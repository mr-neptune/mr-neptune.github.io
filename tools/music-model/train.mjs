// Trains small per-genre style models from extracted MIDI features.
// Usage: node train.mjs <features.jsonl>... > public/lab/models.json
// Writes a report to stderr. All statistics are key-independent except the
// chord-degree table, which only uses files in the genre's mode.
import fs from 'node:fs';
import readline from 'node:readline';

const NQ = 11;
// Quality index -> class: 0 major, 1 minor, 2 dominant, 3 other.
const QCLASS = [0, 1, 3, 2, 0, 1, 2, 1, 0, 3, 3];
const NAMES = ['', 'm', '5', '7', 'maj7', 'm7', '9', 'm9', 'maj9', 'dim', 'sus4'];
const strength = (s) => { const k = s % 16; return k === 0 || k === 8 ? 0 : k === 4 || k === 12 ? 1 : k % 2 === 0 ? 2 : 3; };
const ivIndex = (d) => Math.max(-12, Math.min(12, d)) + 12;

// genre -> { sources, minor (mode used for the degree table), filter }
const GENRES = {
  classical: { sources: ['classical'], minor: false },
  jazz: { sources: ['jazz'], minor: false },
  lofi: { sources: ['jazz', 'rnb'], minor: false, filter: (d) => d.tempo < 95 },
  rock: { sources: ['rock'], minor: true },
  funk: { sources: ['funk'], minor: true },
};

function newStats() {
  return {
    files: 0, bars: 0, tempos: [],
    melPat: new Map(), melStep: new Float64Array(16), melBars: 0, melNotesPerBar: [],
    fill: new Float64Array(3),
    ivUni: new Float64Array(25), ivBi: new Float64Array(25 * 25),
    melRel: new Float64Array(4 * 4 * 12),
    chordT: new Float64Array(2 * NQ * (1 + 12 * NQ)),
    degree: new Float64Array(12 * NQ),
    bassPat: new Map(), bassStep: new Float64Array(16), bassBars: 0,
    bassRel: new Float64Array(4 * 12),
    bassIvBi: new Float64Array(25 * 25), bassIvUni: new Float64Array(25),
    melMean: [], melSpan: [], bassMean: [],
    sim02: [], sim13: [],
    hr: new Float64Array(8),
  };
}

function grid(notes, end) {
  const g = new Int16Array(end).fill(-1);
  for (const [s, len, p] of notes) { if (s >= end) continue; g[s] = p; for (let k = s + 1; k < s + len && k < end; k++) if (g[k] === -1) g[k] = -2; }
  return g;
}

function addFile(st, d, genre) {
  st.files++;
  st.tempos.push(d.tempo);
  const end = d.end, nBars = Math.floor(end / 16);
  st.bars += nBars;
  const mel = d.mel, bass = d.bass, chords = d.chords;
  const chordAt = (s) => chords[s >> 3];

  // Rhythm patterns over the active span of each line.
  const patterns = (notes, map, step, key) => {
    if (!notes || notes.length < 4) return;
    const first = Math.floor(notes[0][0] / 16), last = Math.floor(notes[notes.length - 1][0] / 16);
    const masks = new Int32Array(nBars);
    for (const [s] of notes) { const b = s >> 4; if (b < nBars) masks[b] |= 1 << (s % 16); }
    for (let b = first; b <= last && b < nBars; b++) {
      if (!masks[b]) continue;
      map.set(masks[b], (map.get(masks[b]) || 0) + 1);
      for (let i = 0; i < 16; i++) if (masks[b] & (1 << i)) step[i]++;
      st[key]++;
      if (key === 'melBars') { let c = 0; for (let i = 0; i < 16; i++) if (masks[b] & (1 << i)) c++; st.melNotesPerBar.push(c); }
    }
  };
  patterns(mel, st.melPat, st.melStep, 'melBars');
  patterns(bass, st.bassPat, st.bassStep, 'bassBars');

  // Melody intervals, fill ratio and chord-relative pitch.
  let prevIv = -1;
  for (let i = 0; i < mel.length; i++) {
    const [s, len, p] = mel[i];
    const next = mel[i + 1];
    if (next) {
      const gap = next[0] - s;
      st.fill[len / Math.min(gap, 16) <= 0.5 ? 0 : len / Math.min(gap, 16) < 0.95 ? 1 : 2]++;
      if (gap <= 16) {
        const iv = ivIndex(next[2] - p);
        st.ivUni[iv]++;
        if (prevIv >= 0) st.ivBi[prevIv * 25 + iv]++;
        prevIv = iv;
      } else prevIv = -1;
    }
    const c = chordAt(s);
    if (c) st.melRel[(strength(s) * 4 + QCLASS[c[1]]) * 12 + (((p - c[0]) % 12) + 12) % 12]++;
  }

  // Chord transitions per half bar, conditioned on previous quality and on
  // whether the new slot starts a bar (parity 0) or the middle of one.
  for (let k = 0; k + 1 < chords.length; k++) {
    const a = chords[k], b = chords[k + 1];
    if (!a || !b) continue;
    const parity = (k + 1) % 2;
    const out = a[0] === b[0] && a[1] === b[1] ? 0 : 1 + (((b[0] - a[0]) % 12 + 12) % 12) * NQ + b[1];
    st.chordT[(parity * NQ + a[1]) * (1 + 12 * NQ) + out]++;
  }
  // Harmonic rhythm: chord changes inside each aligned 4-bar window.
  for (let w = 0; w + 8 <= chords.length; w += 8) {
    const win = chords.slice(w, w + 8);
    if (win.some((c) => !c)) continue;
    let ch = 0;
    for (let k = 1; k < 8; k++) if (win[k][0] !== win[k - 1][0] || win[k][1] !== win[k - 1][1]) ch++;
    st.hr[ch]++;
  }
  if (d.minor === GENRES[genre].minor) {
    for (const c of chords) if (c) st.degree[(((c[0] - d.tonic) % 12 + 12) % 12) * NQ + c[1]]++;
  }

  if (bass && bass.length >= 4) {
    let prev = -1;
    for (let i = 0; i < bass.length; i++) {
      const [s, , p] = bass[i];
      const c = chordAt(s);
      if (c) st.bassRel[strength(s) * 12 + (((p - c[0]) % 12) + 12) % 12]++;
      const next = bass[i + 1];
      if (next && next[0] - s <= 16) {
        const iv = ivIndex(next[2] - p);
        st.bassIvUni[iv]++;
        if (prev >= 0) st.bassIvBi[prev * 25 + iv]++;
        prev = iv;
      } else prev = -1;
    }
    st.bassMean.push(bass.reduce((a, n) => a + n[2], 0) / bass.length);
  }

  // Register and phrase structure over aligned 4-bar windows.
  const g = grid(mel, nBars * 16);
  for (let w = 0; w + 4 <= nBars; w += 4) {
    const ps = mel.filter((n) => n[0] >= w * 16 && n[0] < w * 16 + 64).map((n) => n[2]);
    if (ps.length < 6) continue;
    st.melMean.push(ps.reduce((a, b) => a + b) / ps.length);
    st.melSpan.push(Math.max(...ps) - Math.min(...ps));
    const sim = (a, b) => { let same = 0; for (let i = 0; i < 16; i++) if (g[(w + a) * 16 + i] === g[(w + b) * 16 + i]) same++; return same / 16; };
    st.sim02.push(sim(0, 2)); st.sim13.push(sim(1, 3));
  }
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 0; };
const round = (x, n = 4) => +x.toPrecision(n);

function normRows(arr, rowLen, k) {
  const out = new Array(arr.length);
  for (let r = 0; r < arr.length; r += rowLen) {
    let sum = 0;
    for (let i = 0; i < rowLen; i++) sum += arr[r + i] + k;
    for (let i = 0; i < rowLen; i++) out[r + i] = round((arr[r + i] + k) / sum);
  }
  return out;
}

function patternModel(map, step, bars, topK) {
  const items = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
  return {
    top: items.map(([m, c]) => [m, round(c / bars)]),
    step: Array.from(step, (c) => round(Math.min(0.98, Math.max(0.005, c / bars)))),
  };
}

function finish(st) {
  return {
    files: st.files, bars: st.bars, tempo: median(st.tempos),
    melPat: patternModel(st.melPat, st.melStep, st.melBars, 400),
    notesPerBar: round(mean(st.melNotesPerBar), 3),
    fill: normRows(st.fill, 3, 1),
    ivUni: normRows(st.ivUni, 25, 0.5), ivBi: normRows(st.ivBi, 25, 0.5),
    melRel: normRows(st.melRel, 12, 0.5),
    chordT: normRows(st.chordT, 1 + 12 * NQ, 0.05),
    degree: normRows(st.degree, 12 * NQ, 0.5),
    bassPat: patternModel(st.bassPat, st.bassStep, st.bassBars, 300),
    bassRel: normRows(st.bassRel, 12, 0.5),
    bassIvUni: normRows(st.bassIvUni, 25, 0.5), bassIvBi: normRows(st.bassIvBi, 25, 0.5),
    melCenter: round(mean(st.melMean), 3), melSpan: round(mean(st.melSpan), 3), bassCenter: round(mean(st.bassMean), 3),
    sim02: round(mean(st.sim02), 3), sim13: round(mean(st.sim13), 3),
    hr: normRows(st.hr, 8, 0.5),
  };
}

// --- load ---
const files = process.argv.slice(2);
const bySource = {};
for (const f of files) {
  const rl = readline.createInterface({ input: fs.createReadStream(f) });
  for await (const line of rl) {
    if (!line) continue;
    const d = JSON.parse(line);
    (bySource[d.genre] ||= []).push(d);
  }
}

// Hold out every 10th file per genre to measure the typical NLL (baseline).
const models = {}, holdout = {};
for (const [genre, cfg] of Object.entries(GENRES)) {
  const st = newStats(), docs = [];
  for (const src of cfg.sources) for (const d of bySource[src] || []) if (!cfg.filter || cfg.filter(d)) docs.push(d);
  docs.forEach((d, i) => { if (i % 10 !== 0) addFile(st, d, genre); });
  models[genre] = finish(st);
  holdout[genre] = docs.filter((_, i) => i % 10 === 0);
}

// --- report ---
const log = (...a) => console.error(...a);
const NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
for (const [g, m] of Object.entries(models)) {
  log('  chord changes per 4 bars:', m.hr.map((p, i) => `${i}:${(p * 100).toFixed(0)}%`).join(' '));
  log(`\n== ${g}: ${m.files} files, ${m.bars} bars, tempo ${m.tempo}, notes/bar ${m.notesPerBar}, center ${m.melCenter}, span ${m.melSpan}, bass ${m.bassCenter}, sim02 ${m.sim02}, sim13 ${m.sim13}`);
  const deg = m.degree.map((p, i) => [p, NOTE[Math.floor(i / NQ)] + NAMES[i % NQ]]).sort((a, b) => b[0] - a[0]).slice(0, 10);
  log('  chords (rel. to C tonic):', deg.map(([p, n]) => `${n} ${(p * 100).toFixed(1)}%`).join(', '));
  const changes = [];
  for (let par = 0; par < 2; par++) for (let q = 0; q < NQ; q++) {
    const row = m.chordT.slice((par * NQ + q) * (1 + 12 * NQ), (par * NQ + q + 1) * (1 + 12 * NQ));
    if (par === 0) changes.push([NAMES[q] || 'maj', 'stay ' + (row[0] * 100).toFixed(0) + '%', row.map((p, i) => [p, i]).slice(1).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([p, i]) => `+${Math.floor((i - 1) / NQ)}${NAMES[(i - 1) % NQ] || 'maj'} ${(p * 100).toFixed(0)}%`).join(' ')]);
  }
  log('  bar-line moves:', changes.filter((c) => ['maj', 'm', '7', 'm7', 'maj7', '5'].includes(c[0])).map((c) => c.join(': ')).join(' | '));
  log('  intervals:', m.ivUni.map((p, i) => [p, i - 12]).sort((a, b) => b[0] - a[0]).slice(0, 8).map(([p, i]) => `${i}:${(p * 100).toFixed(0)}%`).join(' '));
  log('  mel patterns:', m.melPat.top.slice(0, 5).map(([mk, p]) => mk.toString(2).padStart(16, '0').split('').reverse().join('').replace(/0/g, '.').replace(/1/g, 'x') + ' ' + (p * 100).toFixed(1) + '%').join('  '));
  log('  bass patterns:', m.bassPat.top.slice(0, 3).map(([mk, p]) => mk.toString(2).padStart(16, '0').split('').reverse().join('').replace(/0/g, '.').replace(/1/g, 'x') + ' ' + (p * 100).toFixed(1) + '%').join('  '));
}

fs.writeFileSync(process.env.HOLDOUT || '/dev/null', JSON.stringify(holdout));
process.stdout.write(JSON.stringify({ version: 1, qclass: QCLASS, models }));
