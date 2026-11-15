// Extracts melody, bass, chords and key from MIDI files on a 16th-note grid.
// Usage: node extract.mjs <list.tsv> <out.jsonl> [shard] [shards]
// list.tsv lines: "<genre>\t<path>". Writes one JSON object per usable file.
import fs from 'node:fs';
import tonejs from '@tonejs/midi';
const { Midi } = tonejs;

const [listPath, outPath, shardArg = '0', shardsArg = '1'] = process.argv.slice(2);
const shard = +shardArg, shards = +shardsArg;

export const QUALITIES = [
  ['', [0, 4, 7]], ['m', [0, 3, 7]], ['5', [0, 7]], ['7', [0, 4, 7, 10]],
  ['maj7', [0, 4, 7, 11]], ['m7', [0, 3, 7, 10]], ['9', [0, 4, 7, 10, 14]],
  ['m9', [0, 3, 7, 10, 14]], ['maj9', [0, 4, 7, 11, 14]], ['dim', [0, 3, 6]],
  ['sus4', [0, 5, 7]],
].map(([name, iv]) => ({ name, pcs: [...new Set(iv.map((x) => x % 12))] }));

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const TOL = +(process.env.TOL || 0.07), MIN_OK = +(process.env.MIN_OK || 0.75);
const GRID = [[0, 0], [0.25, 1], [1 / 3, 1], [0.5, 2], [2 / 3, 2], [0.75, 3], [1, 4]];
const LEAD_FAMILIES = new Set(['reed', 'brass', 'pipe', 'synth lead', 'strings']);

function corr(a, b) {
  const ma = a.reduce((x, y) => x + y) / 12, mb = b.reduce((x, y) => x + y) / 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db || 1);
}

function estimateKey(hist) {
  let best = { r: -2 };
  for (let t = 0; t < 12; t++) {
    const rot = Array.from({ length: 12 }, (_, i) => hist[(i + t) % 12]);
    const rM = corr(rot, MAJOR), rm = corr(rot, MINOR);
    if (rM > best.r) best = { r: rM, tonic: t, minor: false };
    if (rm > best.r) best = { r: rm, tonic: t, minor: true };
  }
  return best;
}

// Highest note at each onset step, cut so notes never overlap.
function skyline(notes) {
  const byStep = new Map();
  for (const n of notes) { const c = byStep.get(n.s); if (!c || n.p > c.p) byStep.set(n.s, { ...n }); }
  const out = [...byStep.values()].sort((a, b) => a.s - b.s);
  for (let i = 0; i < out.length - 1; i++) out[i].len = Math.max(1, Math.min(out[i].len, out[i + 1].s - out[i].s));
  return out;
}

// Lowest note at each onset step, for bass lines.
function floorline(notes) {
  const byStep = new Map();
  for (const n of notes) { const c = byStep.get(n.s); if (!c || n.p < c.p) byStep.set(n.s, { ...n }); }
  const out = [...byStep.values()].sort((a, b) => a.s - b.s);
  for (let i = 0; i < out.length - 1; i++) out[i].len = Math.max(1, Math.min(out[i].len, out[i + 1].s - out[i].s));
  return out;
}

function analyze(buf) {
  const midi = new Midi(buf);
  const sigs = midi.header.timeSignatures;
  if (sigs.some((t) => !((t.timeSignature[0] === 4 && t.timeSignature[1] === 4) || (t.timeSignature[0] === 2 && t.timeSignature[1] === 2)))) return { skip: 'meter' };
  const ppq = midi.header.ppq, step = ppq / 4;
  const tracks = midi.tracks.filter((t) => !t.instrument.percussion && t.channel !== 9 && t.notes.length >= 16);
  if (!tracks.length) return { skip: 'empty' };

  // Snap onsets to 16ths, treating swung/triplet offbeats as the matching
  // 16th step (2/3 of a beat -> the "and", 1/3 -> the "e").
  let ok = 0, total = 0;
  const snap = (ticks) => {
    const b = ticks / ppq, beat = Math.floor(b), f = b - beat;
    let best = 0, err = 9;
    for (const [pos, st] of GRID) { const e = Math.abs(f - pos); if (e < err) { err = e; best = st; } }
    total++; if (err <= TOL) ok++;
    return beat * 4 + best;
  };
  const quant = (t) => t.notes.map((n) => ({ s: snap(n.ticks), len: Math.max(1, Math.min(32, Math.round(n.durationTicks / step))), p: n.midi }));
  for (const t of tracks) quant(t);
  if (ok / total < MIN_OK) return { skip: "unquantized" };
  const info = tracks.map((t) => {
    const notes = quant(t);
    const steps = new Map();
    for (const n of notes) steps.set(n.s, (steps.get(n.s) || 0) + 1);
    const mono = [...steps.values()].filter((c) => c === 1).length / steps.size;
    const mean = notes.reduce((a, n) => a + n.p, 0) / notes.length;
    const fam = t.instrument.family, name = (t.name || '') + ' ' + (t.instrument.name || '');
    return { t, notes, mono, mean, fam, name };
  });
  const bassInfo = info.filter((x) => x.fam === 'bass' || /\bbass\b/i.test(x.name)).sort((a, b) => b.notes.length - a.notes.length)[0];
  const end = Math.max(...info.flatMap((x) => x.notes.map((n) => n.s + n.len)));
  const bars = end / 16;
  let best = null;
  for (const x of info) {
    if (x === bassInfo) continue;
    const density = x.notes.length / bars;
    if (density < 1 || x.mean < 55) continue;
    let score = x.mono + (x.mean >= 62 ? 0.4 : 0) + (LEAD_FAMILIES.has(x.fam) ? 0.4 : 0);
    if (/melod|vocal|voice|lead|sing|vox|tune/i.test(x.name)) score += 2;
    if (/drum|perc|bass|pad|chord|rhythm|strings? ?ens/i.test(x.name)) score -= 1;
    if (!best || score > best.score) best = { ...x, score };
  }
  if (!best) return { skip: 'nomelody' };
  const mel = skyline(best.notes);
  // Without a bass instrument (e.g. solo piano), use the lowest line below
  // the melody's register.
  let bass = bassInfo ? floorline(bassInfo.notes) : null;
  if (!bass) {
    const lowNotes = info.flatMap((x) => x.notes).filter((n) => n.p < 55);
    if (lowNotes.length >= 16) bass = floorline(lowNotes);
  }

  // Pitch-class content per half bar -> chord label; whole file -> key.
  const slots = Math.ceil(end / 8);
  const hist = Array.from({ length: slots }, () => new Float64Array(12));
  const low = new Int16Array(slots).fill(999);
  const keyHist = new Float64Array(12);
  for (const x of info) {
    const w = x === bassInfo ? 1.5 : 1;
    for (const n of x.notes) {
      keyHist[n.p % 12] += n.len;
      for (let s = n.s; s < n.s + n.len && s < end; s++) {
        const k = s >> 3;
        hist[k][n.p % 12] += w;
        if (n.p < low[k]) low[k] = n.p;
      }
    }
  }
  // Label each bar with one chord; split it into two half-bar chords only
  // when the halves clearly disagree. Avoids labelling passing tones.
  const label = (h, lowPc) => {
    const sum = h.reduce((a, b) => a + b, 0);
    if (sum < 4) return null;
    let top = { sc: -9 };
    for (let r = 0; r < 12; r++) {
      for (let q = 0; q < QUALITIES.length; q++) {
        const pcs = QUALITIES[q].pcs;
        let inside = 0;
        for (const iv of pcs) inside += h[(r + iv) % 12];
        let sc = (inside - 0.6 * (sum - inside)) / sum - 0.06 * Math.max(0, pcs.length - 3);
        if (lowPc === r) sc += 0.12;
        pcs.forEach((iv, j) => { if (h[(r + iv) % 12] < sum * (j < 3 ? 0.04 : 0.1)) sc -= 0.15; });
        if (sc > top.sc) top = { sc, r, q };
      }
    }
    return top;
  };
  const scoreAs = (h, lowPc, c) => {
    const sum = h.reduce((a, b) => a + b, 0), pcs = QUALITIES[c.q].pcs;
    let inside = 0;
    for (const iv of pcs) inside += h[(c.r + iv) % 12];
    return (inside - 0.6 * (sum - inside)) / sum - 0.06 * Math.max(0, pcs.length - 3) + (lowPc === c.r ? 0.12 : 0);
  };
  const chords = new Array(slots).fill(null);
  for (let k = 0; k < slots; k += 2) {
    const h1 = hist[k], h2 = hist[k + 1] || new Float64Array(12);
    const hb = h1.map((v, i) => v + h2[i]);
    const lowBar = Math.min(low[k], k + 1 < slots ? low[k + 1] : 999);
    const bar = label(hb, lowBar % 12);
    if (!bar) continue;
    const a = label(h1, low[k] % 12), b = k + 1 < slots ? label(h2, low[k + 1] % 12) : null;
    const split = a && b && a.r !== b.r && a.sc - scoreAs(h1, low[k] % 12, bar) > 0.15 && b.sc - scoreAs(h2, low[k + 1] % 12, bar) > 0.15;
    chords[k] = split ? [a.r, a.q] : [bar.r, bar.q];
    if (k + 1 < slots) chords[k + 1] = split ? [b.r, b.q] : [bar.r, bar.q];
  }
  const key = estimateKey(keyHist);
  const tempo = midi.header.tempos.length ? midi.header.tempos[0].bpm : 120;
  const pack = (ns) => ns.map((n) => [n.s, n.len, n.p]);
  return { tempo: Math.round(tempo), tonic: key.tonic, minor: key.minor, end, mel: pack(mel), bass: bass ? pack(bass) : null, chords };
}

const lines = fs.readFileSync(listPath, 'utf8').trim().split('\n');
const out = fs.createWriteStream(outPath);
const skips = {};
let kept = 0;
for (let i = shard; i < lines.length; i += shards) {
  const [genre, path] = lines[i].split('\t');
  try {
    const r = analyze(fs.readFileSync(path));
    if (r.skip) { skips[r.skip] = (skips[r.skip] || 0) + 1; continue; }
    out.write(JSON.stringify({ genre, path, ...r }) + '\n');
    kept++;
  } catch (e) {
    skips.error = (skips.error || 0) + 1;
  }
}
out.end(() => console.log(`shard ${shard}: kept ${kept}`, JSON.stringify(skips)));
