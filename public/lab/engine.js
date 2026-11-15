/*
 * Noise to Music: an evolutionary optimizer that turns random notes into a
 * 16-bar song (A A B A' form, with melody, counter-melody, bass and chords)
 * in a chosen genre or a blend of two. The loss scores each 4-bar section
 * with style models learned from MIDI (tools/music-model), falling back to
 * hand-written music-theory rules, plus terms for how the sections fit
 * together. Runs in the browser and in Node (for tuning).
 */
(function (root) {
  'use strict';

  const STEPS = 64, BAR = 16, SLOTS = 8, SLOT = 8;
  const REST = -1, HOLD = -2;
  const MEL_LO = 55, MEL_HI = 88, BASS_LO = 28, BASS_HI = 55;

  const QUALITIES = [
    ['', [0, 4, 7]], ['m', [0, 3, 7]], ['5', [0, 7]], ['7', [0, 4, 7, 10]],
    ['maj7', [0, 4, 7, 11]], ['m7', [0, 3, 7, 10]], ['9', [0, 4, 7, 10, 14]],
    ['m9', [0, 3, 7, 10, 14]], ['maj9', [0, 4, 7, 11, 14]], ['dim', [0, 3, 6]],
    ['sus4', [0, 5, 7]],
  ].map(([name, iv]) => ({ name, iv }));
  const NQ = QUALITIES.length;

  const MAJOR = [0, 2, 4, 5, 7, 9, 11];
  const AEOLIAN = [0, 2, 3, 5, 7, 8, 10];
  const DORIAN = [0, 2, 3, 5, 7, 9, 10];

  // Targets per genre. Chord roots and progressions are scale degrees in
  // semitones above the key. mel/bass hold the numeric targets that blend.
  const GENRES = {
    classical: {
      name: 'Classical', key: 0, tempo: 96, swing: 0.5, scale: MAJOR,
      chords: { 0: { '': 1 }, 2: { m: 1, m7: 0.4 }, 4: { m: 0.8 }, 5: { '': 1 }, 7: { '': 1, 7: 0.9 }, 9: { m: 1 }, 11: { dim: 0.6 } },
      progs: [[0, 5, 7, 0], [0, 9, 2, 7], [0, 9, 5, 7], [0, 7, 9, 4, 5, 0, 5, 7], [0, 2, 7, 0], [0, 5, 0, 7], [4, 9, 2, 7, 0]],
      start: { 0: 1 }, end: { 0: 1, 7: 0.7 },
      harmony: { changes: 5, odd: 0.35 },
      mel: { density: 6, syncop: 0.03, rest: 0.08, interval: 2.0, chordTone: 0.85, inScale: 1, center: 74, short: 0.1, rep: 0.55, recover: 1, endLong: 1, color: 0 },
      bass: { density: 3.5, syncop: 0, interval: 4, chordTone: 0.95, center: 43 },
      style: { lead: 'piano', comp: 'sustain', bass: 'pianoLow', counter: 'strings', drums: 'none' },
    },
    jazz: {
      name: 'Jazz', key: 5, tempo: 128, swing: 0.64, scale: MAJOR,
      chords: { 0: { maj7: 1, maj9: 0.9 }, 2: { m7: 1, m9: 0.8, 7: 0.5 }, 4: { m7: 0.8, 7: 0.5 }, 5: { maj7: 0.8, 7: 0.5 }, 7: { 7: 1, 9: 0.9 }, 9: { m7: 1, 7: 0.6 } },
      progs: [[2, 7, 0, 0], [0, 9, 2, 7], [4, 9, 2, 7], [0, 4, 9, 2, 7, 0], [5, 4, 9, 2, 7, 0], [2, 7, 4, 9]],
      start: { 0: 0.8, 2: 1, 4: 0.7 }, end: { 0: 1, 7: 0.9 },
      harmony: { changes: 6, odd: 0.5 },
      mel: { density: 7, syncop: 0.12, rest: 0.2, interval: 3.0, chordTone: 0.6, inScale: 0.85, center: 72, short: 0.08, rep: 0.35, recover: 0.4, endLong: 0.5, color: 1 },
      bass: { density: 4, syncop: 0, interval: 2.2, chordTone: 0.7, center: 40 },
      style: { lead: 'rhodes', comp: 'charleston', bass: 'upright', counter: 'vibes', drums: 'swing' },
    },
    lofi: {
      name: 'Lo-fi', key: 3, tempo: 80, swing: 0.58, scale: MAJOR,
      chords: { 0: { maj7: 1, maj9: 1 }, 2: { m7: 1, m9: 1 }, 4: { m7: 1 }, 5: { maj7: 1, maj9: 1 }, 7: { 7: 0.6, 9: 0.7, sus4: 0.5 }, 9: { m7: 1, m9: 0.9 } },
      progs: [[5, 4, 9, 2], [2, 7, 0, 9], [5, 7, 4, 9], [0, 9, 5, 7], [5, 4, 2, 0], [9, 5, 0, 7]],
      start: { 5: 1, 2: 1, 0: 0.8, 9: 0.8 }, end: { 7: 0.8, 2: 0.7, 4: 0.8, 9: 0.8, 0: 0.6, 5: 0.6 },
      harmony: { changes: 3, odd: 0 },
      mel: { density: 3.5, syncop: 0.25, rest: 0.45, interval: 2.6, chordTone: 0.7, inScale: 0.97, center: 74, short: 0.05, rep: 0.8, recover: 0.4, endLong: 0.3, color: 1 },
      bass: { density: 2, syncop: 0.15, interval: 5, chordTone: 0.9, center: 38 },
      style: { lead: 'lofi', comp: 'strum', bass: 'sub', counter: 'vibes', drums: 'boombap' },
    },
    rock: {
      name: 'Rock', key: 4, tempo: 132, swing: 0.5, scale: AEOLIAN,
      chords: { 0: { 5: 1, m: 0.6 }, 3: { 5: 1, '': 0.6 }, 5: { 5: 1 }, 7: { 5: 0.9 }, 8: { 5: 1, '': 0.6 }, 10: { 5: 1, '': 0.6 } },
      progs: [[0, 10, 8, 10], [0, 8, 3, 10], [0, 3, 10, 5], [0, 5, 10, 0], [0, 8, 10, 0], [0, 3, 5, 8]],
      start: { 0: 1 }, end: { 10: 1, 0: 0.8, 7: 0.7 },
      harmony: { changes: 3, odd: 0 },
      mel: { density: 5, syncop: 0.15, rest: 0.25, interval: 2.8, chordTone: 0.8, inScale: 0.97, center: 67, short: 0.1, rep: 0.75, recover: 0.4, endLong: 0.4, color: 0 },
      bass: { density: 8, syncop: 0, interval: 0.5, chordTone: 1, center: 40 },
      style: { lead: 'overdrive', comp: 'power', bass: 'pick', counter: 'pad', drums: 'rock' },
    },
    funk: {
      name: 'Funk', key: 2, tempo: 104, swing: 0.54, scale: DORIAN,
      chords: { 0: { m7: 1, m9: 1 }, 5: { 7: 1, 9: 1 }, 10: { 7: 0.7, 9: 0.7 }, 3: { maj7: 0.5 }, 7: { m7: 0.6 } },
      progs: [[0, 0, 5, 0], [0, 5, 0, 5], [0, 0, 10, 5], [0, 5, 10, 0], [0, 7, 5, 0]],
      start: { 0: 1 }, end: { 0: 0.8, 5: 1, 10: 0.7 },
      harmony: { changes: 2, odd: 0.2 },
      mel: { density: 6.5, syncop: 0.45, rest: 0.35, interval: 2.6, chordTone: 0.65, inScale: 0.9, center: 69, short: 0.4, rep: 0.85, recover: 0.4, endLong: 0, color: 1 },
      bass: { density: 7, syncop: 0.5, interval: 4, chordTone: 0.85, center: 38 },
      style: { lead: 'brass', comp: 'stabs', bass: 'slap', counter: 'pad', drums: 'funk' },
    },
  };

  const GROUPS = ['Harmony', 'Melody', 'Rhythm', 'Form', 'Bass', 'Counter'];

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Blend two genres into one set of targets. Numbers interpolate; scales,
  // chord vocabularies and progressions become weighted lookup tables.
  function makeTarget(aId, bId, mix) {
    const A = GENRES[aId];
    const B = bId && GENRES[bId] && bId !== aId ? GENRES[bId] : A;
    const m = B === A ? 0 : Math.min(1, Math.max(0, mix));
    const both = (f) => (1 - m) * f(A) + m * f(B);
    const lerpObj = (k) => {
      const o = {};
      for (const f in A[k]) o[f] = both((G) => G[k][f]);
      return o;
    };
    const scaleW = new Float32Array(12), startW = new Float32Array(12), endW = new Float32Array(12);
    const chordW = new Float32Array(12 * NQ), trans = new Float32Array(144);
    for (let i = 0; i < 12; i++) {
      scaleW[i] = both((G) => (G.scale.includes(i) ? 1 : 0));
      startW[i] = both((G) => G.start[i] || 0);
      endW[i] = both((G) => G.end[i] || 0);
      for (let q = 0; q < NQ; q++) chordW[i * NQ + q] = both((G) => (G.chords[i] && G.chords[i][QUALITIES[q].name]) || 0);
    }
    for (const [G, w] of [[A, 1 - m], [B, m]]) {
      if (!w) continue;
      const seen = new Set();
      for (const p of G.progs) {
        for (let j = 0; j < p.length; j++) {
          const a = p[j], b = p[(j + 1) % p.length];
          if (a !== b) seen.add(a * 12 + b);
        }
      }
      for (const k of seen) trans[k] += w;
    }
    const model = MODELS && MODELS[aId] && MODELS[B === A ? aId : bId]
      ? mixModel(MODELS[aId], MODELS[B === A ? aId : bId], m) : null;
    return {
      a: aId, b: B === A ? null : bId, mix: m, model,
      key: A.key, tempo: Math.round(both((G) => G.tempo)), swing: both((G) => G.swing),
      scaleW, startW, endW, chordW, trans,
      harmony: lerpObj('harmony'), mel: lerpObj('mel'), bass: lerpObj('bass'),
      style: (m < 0.5 ? A : B).style,
    };
  }

  // ---------- song form ----------
  // The genome holds 9 unique bars: section A (bars 0-3), section B (bars
  // 4-7) and an ending bar (8) that replaces A's last bar the final time.
  // FORM lists genome bars in playing order: a 16-bar A A B A' song.
  const NB = 9, GSTEPS = NB * BAR, GSLOTS = NB * 2;
  const CTR_LO = 55, CTR_HI = 79;
  const FORM = [0, 1, 2, 3, 0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 8];
  const SECTIONS = [{ name: 'A', bar: 0 }, { name: 'A', bar: 4 }, { name: 'B', bar: 8 }, { name: 'A′', bar: 12 }];
  const WIN = { A: [0, 1, 2, 3], B: [4, 5, 6, 7], E: [0, 1, 2, 8] };

  function randomGenome(rnd) {
    const g = { mel: new Int8Array(GSTEPS), bass: new Int8Array(GSTEPS), ctr: new Int8Array(GSTEPS), roots: new Int8Array(GSLOTS), quals: new Int8Array(GSLOTS) };
    for (let i = 0; i < GSTEPS; i++) {
      const r = rnd();
      g.mel[i] = r < 0.5 ? MEL_LO + Math.floor(rnd() * (MEL_HI - MEL_LO + 1)) : r < 0.75 ? HOLD : REST;
      const s = rnd();
      g.bass[i] = s < 0.4 ? BASS_LO + Math.floor(rnd() * (BASS_HI - BASS_LO + 1)) : s < 0.7 ? HOLD : REST;
      const c = rnd();
      g.ctr[i] = c < 0.35 ? CTR_LO + Math.floor(rnd() * (CTR_HI - CTR_LO + 1)) : c < 0.7 ? HOLD : REST;
    }
    for (let s = 0; s < GSLOTS; s++) {
      g.roots[s] = Math.floor(rnd() * 12);
      g.quals[s] = Math.floor(rnd() * NQ);
    }
    return g;
  }

  function clone(g) {
    return { mel: g.mel.slice(), bass: g.bass.slice(), ctr: g.ctr.slice(), roots: g.roots.slice(), quals: g.quals.slice() };
  }

  // Lay out the given genome bars one after another (a section, or the song).
  function windowOf(g, bars) {
    const n = bars.length, w = { mel: new Int8Array(n * BAR), bass: new Int8Array(n * BAR), ctr: new Int8Array(n * BAR), roots: new Int8Array(n * 2), quals: new Int8Array(n * 2) };
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      for (const k of ['mel', 'bass', 'ctr']) w[k].set(g[k].subarray(b * BAR, b * BAR + BAR), i * BAR);
      w.roots[i * 2] = g.roots[b * 2]; w.roots[i * 2 + 1] = g.roots[b * 2 + 1];
      w.quals[i * 2] = g.quals[b * 2]; w.quals[i * 2 + 1] = g.quals[b * 2 + 1];
    }
    return w;
  }
  const song = (g) => windowOf(g, FORM);

  // Notes with start, length and pitch; holds after a rest count as rest.
  function parse(track) {
    const len = track.length, notes = [], norm = new Int8Array(len);
    let cur = null;
    for (let i = 0; i < len; i++) {
      const v = track[i];
      if (v >= 0) { cur = { s: i, len: 1, p: v }; notes.push(cur); norm[i] = v; }
      else if (v === HOLD && cur) { cur.len++; norm[i] = HOLD; }
      else { cur = null; norm[i] = REST; }
    }
    return { notes, norm };
  }

  const pcOf = (p, key) => (((p - key) % 12) + 12) % 12;

  function chordMasks(g, color) {
    const masks = new Int32Array(SLOTS), colors = new Int32Array(SLOTS);
    for (let s = 0; s < SLOTS; s++) {
      let m = 0;
      for (const iv of QUALITIES[g.quals[s]].iv) m |= 1 << ((g.roots[s] + iv) % 12);
      masks[s] = m;
      colors[s] = color ? m | (1 << ((g.roots[s] + 2) % 12)) | (1 << ((g.roots[s] + 9) % 12)) : m;
    }
    return { masks, colors };
  }

  function barSim(norm, a, b) {
    let same = 0;
    for (let i = 0; i < BAR; i++) if (norm[a * BAR + i] === norm[b * BAR + i]) same++;
    return same / BAR;
  }

  // ---------- learned critic ----------
  // Style models trained offline on real MIDI (tools/music-model). Each
  // component is an average negative log-likelihood or a distribution
  // distance; its baseline is the 10th percentile on held-out real music, so
  // a component reaches zero once a section is as plausible as the best real
  // 4-bar phrases.
  let MODELS = null;
  const QCLASS = [0, 1, 3, 2, 0, 1, 2, 1, 0, 3, 3];
  const NQ1 = 1 + 12 * NQ;
  const W = { hrhythm: 1.5, chord: 2.5, degree: 1.5, melIv: 1.5, melRel: 2, ivTV: 2, relTV: 2, register: 1.5, melPat: 1.5, fill: 1.2, density: 1.5, structure: 2, bassPat: 1, bassRel: 1.5, bassIv: 1, bassReg: 1 };
  const GROUP_OF = { hrhythm: 0, chord: 0, degree: 0, melIv: 1, melRel: 1, ivTV: 1, relTV: 1, register: 1, melPat: 2, fill: 2, density: 2, structure: 3, bassPat: 4, bassRel: 4, bassIv: 4, bassReg: 4 };
  const strengthOf = (s) => { const k = s % 16; return k === 0 || k === 8 ? 0 : k === 4 || k === 12 ? 1 : k % 2 === 0 ? 2 : 3; };
  const ivIdx = (d) => (d < -12 ? -12 : d > 12 ? 12 : d) + 12;

  function loadModels(json) { MODELS = json && json.models ? json.models : null; }

  function mixModel(A, B, m) {
    const logMix = (a, b) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = Math.log((1 - m) * a[i] + m * b[i]); return o; };
    const probMix = (a, b) => a.map((x, i) => (1 - m) * x + m * b[i]);
    const pat = (pa, pb) => {
      const map = new Map();
      for (const [k, p] of pa.top) map.set(k, (map.get(k) || 0) + (1 - m) * p);
      for (const [k, p] of pb.top) map.set(k, (map.get(k) || 0) + m * p);
      const step = probMix(pa.step, pb.step);
      return { map, l1: step.map(Math.log), l0: step.map((p) => Math.log(1 - p)) };
    };
    const num = (k) => (1 - m) * A[k] + m * B[k];
    const base = {};
    if (A.base && B.base) for (const k in A.base) base[k] = (1 - m) * A.base[k] + m * B.base[k];
    return {
      chordT: logMix(A.chordT, B.chordT), degree: logMix(A.degree, B.degree),
      ivUni: logMix(A.ivUni, B.ivUni), ivBi: logMix(A.ivBi, B.ivBi), ivUniP: probMix(A.ivUni, B.ivUni),
      melRel: logMix(A.melRel, B.melRel), melRelP: probMix(A.melRel, B.melRel), fill: logMix(A.fill, B.fill),
      bassRel: logMix(A.bassRel, B.bassRel), bassIvUni: logMix(A.bassIvUni, B.bassIvUni), bassIvBi: logMix(A.bassIvBi, B.bassIvBi),
      melPat: pat(A.melPat, B.melPat), bassPat: pat(A.bassPat, B.bassPat),
      notesPerBar: num('notesPerBar'), melCenter: num('melCenter'), melSpan: num('melSpan'), bassCenter: num('bassCenter'),
      sim02: num('sim02'), sim13: num('sim13'), base, hr: logMix(A.hr, B.hr),
    };
  }

  function patLogP(P, mask) {
    let bern = 0;
    for (let i = 0; i < 16; i++) bern += (mask >> i) & 1 ? P.l1[i] : P.l0[i];
    return Math.log(0.85 * (P.map.get(mask) || 0) + 0.15 * Math.exp(bern));
  }

  function tv(hist, expected) {
    let n = 0, e = 0;
    for (let i = 0; i < hist.length; i++) { n += hist[i]; e += expected[i]; }
    if (!n || !e) return 1;
    let d = 0;
    for (let i = 0; i < hist.length; i++) d += Math.abs(hist[i] / n - expected[i] / e);
    return d / 2;
  }

  function masksOf(norm) {
    const masks = new Int32Array(4);
    for (let i = 0; i < STEPS; i++) if (norm[i] >= 0) masks[i >> 4] |= 1 << (i % 16);
    return masks;
  }

  // Raw component values for one loop. `loop` adds the wrap-around chord move.
  function components(g, M, key, loop) {
    const c = {};
    let ch = 0, cn = 0;
    for (let a = 0; a < (loop ? SLOTS : SLOTS - 1); a++) {
      const b = (a + 1) % SLOTS;
      const same = g.roots[a] === g.roots[b] && g.quals[a] === g.quals[b];
      const out = same ? 0 : 1 + (((g.roots[b] - g.roots[a]) % 12 + 12) % 12) * NQ + g.quals[b];
      ch -= M.chordT[((b % 2) * NQ + g.quals[a]) * NQ1 + out]; cn++;
    }
    c.chord = ch / cn;
    let changes = 0;
    for (let s = 1; s < SLOTS; s++) if (g.roots[s] !== g.roots[s - 1] || g.quals[s] !== g.quals[s - 1]) changes++;
    c.hrhythm = -M.hr[changes];
    let dg = 0;
    for (let s = 0; s < SLOTS; s++) dg -= M.degree[g.roots[s] * NQ + g.quals[s]];
    c.degree = dg / SLOTS;

    const mel = parse(g.mel), notes = mel.notes, n = notes.length;
    if (n < 3) return null;
    let iv = 0, ivn = 0, prev = -1, rel = 0, fill = 0, fn = 0, sum = 0, lo = 999, hi = -999, wide = 0;
    const ivHist = new Float64Array(25), relHist = new Float64Array(12), relExp = new Float64Array(12);
    for (let i = 0; i < n; i++) {
      const nt = notes[i], nx = notes[i + 1];
      if (nx) {
        const gap = nx.s - nt.s, r = nt.len / Math.min(gap, 16);
        fill -= M.fill[r <= 0.5 ? 0 : r < 0.95 ? 1 : 2]; fn++;
        if (gap <= 16) {
          const k = ivIdx(nx.p - nt.p);
          iv -= prev >= 0 ? M.ivBi[prev * 25 + k] : M.ivUni[k]; ivn++; ivHist[k]++; prev = k;
          if (Math.abs(nx.p - nt.p) > 12) wide++;
        } else prev = -1;
      }
      const slot = nt.s >> 3, root = (g.roots[slot] + key) % 12;
      const row = (strengthOf(nt.s) * 4 + QCLASS[g.quals[slot]]) * 12, r12 = ((nt.p - root) % 12 + 12) % 12;
      rel -= M.melRel[row + r12]; relHist[r12]++;
      for (let j = 0; j < 12; j++) relExp[j] += M.melRelP[row + j];
      sum += nt.p; if (nt.p < lo) lo = nt.p; if (nt.p > hi) hi = nt.p;
    }
    c.melIv = ivn ? iv / ivn : 4;
    c.wideLeaps = ivn ? wide / ivn : 0;
    c.melRel = rel / n;
    c.fill = fn ? fill / fn : 1.5;
    c.ivTV = tv(ivHist, M.ivUniP);
    c.relTV = tv(relHist, relExp);
    c.density = Math.abs(n / 4 - M.notesPerBar) / M.notesPerBar;
    c.register = Math.abs(sum / n - M.melCenter) / 12 + Math.max(0, hi - lo - (M.melSpan + 5)) / 12;
    const mm = masksOf(mel.norm);
    let mp = 0;
    let filled = 0;
    for (let b = 0; b < 4; b++) if (mm[b]) { mp -= patLogP(M.melPat, mm[b]); filled++; }
    c.melPat = filled ? mp / filled : 12;
    c.emptyBars = 4 - filled;
    c.structure = Math.abs(barSim(mel.norm, 0, 2) - M.sim02) + 0.5 * Math.abs(barSim(mel.norm, 1, 3) - M.sim13);

    const bass = parse(g.bass), bn = bass.notes;
    if (bn.length < 2) {
      c.bassPat = 8; c.bassRel = 4; c.bassIv = 4; c.bassReg = 2;
    } else {
      let br = 0, bi = 0, bin = 0, bprev = -1, bsum = 0;
      for (let i = 0; i < bn.length; i++) {
        const nt = bn[i], nx = bn[i + 1], root = (g.roots[nt.s >> 3] + key) % 12;
        br -= M.bassRel[strengthOf(nt.s) * 12 + ((nt.p - root) % 12 + 12) % 12];
        if (nx && nx.s - nt.s <= 16) {
          const k = ivIdx(nx.p - nt.p);
          bi -= bprev >= 0 ? M.bassIvBi[bprev * 25 + k] : M.bassIvUni[k]; bin++; bprev = k;
        } else bprev = -1;
        bsum += nt.p;
      }
      c.bassRel = br / bn.length;
      c.bassIv = bin ? bi / bin : 4;
      c.bassReg = Math.abs(bsum / bn.length - M.bassCenter) / 12;
      const bm = masksOf(bass.norm);
      let bp = 0, bf = 0;
      for (let b = 0; b < 4; b++) if (bm[b]) { bp -= patLogP(M.bassPat, bm[b]); bf++; }
      c.bassPat = bf ? bp / bf : 8;
      c.bassEmpty = 4 - bf;
    }
    return c;
  }

  // One 4-bar section under the learned model. `loop` scores the wrap-around
  // chord move (A repeats); `ending` asks for a resolved last note.
  function sectionModel(w, T, loop, ending, groups) {
    const M = T.model;
    const c = components(w, M, T.key, loop);
    if (!c) { groups[1] += 10; groups[2] += 10; groups[3] += 10; return; }
    for (const k in W) groups[GROUP_OF[k]] += W[k] * Math.max(0, c[k] - (M.base[k] || 0));
    groups[2] += 1.0 * c.emptyBars;
    groups[4] += 0.7 * (c.bassEmpty || 0);
    // Leaps wider than an octave are rare in real melodies (the interval
    // model folds them into its ±12 bucket).
    groups[1] += 4 * c.wideLeaps;
    // A section that never leaves one chord root is a vamp, not a section.
    let moves = 0;
    for (let s = 1; s < SLOTS; s++) if (w.roots[s] !== w.roots[0]) moves++;
    if (!moves) groups[0] += 1.2;
    if (ending) {
      // The last melody note lands in the last bar, on the final chord's root
      // or the tonic, and is held.
      const notes = parse(w.mel).notes, last = notes[notes.length - 1], lpc = pcOf(last.p, T.key);
      groups[3] += 1.5 * (last.s < 48 ? 1 : lpc === w.roots[SLOTS - 1] || lpc === 0 ? 0 : 0.6) + 0.5 * Math.max(0, (4 - last.len) / 4);
    }
  }

  function sectionRules(w, T, groups) {
    const e = evaluateRules(w, T);
    for (let i = 0; i < 5; i++) groups[i] += e.groups[i];
  }

  // Counter-melody: a second voice under the melody. Hand-written
  // counterpoint rules (the training data has no reliable second voice), plus
  // the learned chord-tone model when it is loaded.
  const DISS = [0, 1, 0.5, 0, 0, 0, 1, 0, 0, 0, 0.5, 1];
  function counterLoss(w, T) {
    const M = T.model, cn = parse(w.ctr).notes, n = cn.length;
    if (n < 2) return 8;
    const mel = parse(w.mel), sound = new Int8Array(STEPS).fill(-1);
    for (const nt of mel.notes) sound.fill(nt.p, nt.s, nt.s + nt.len);
    const density = M ? Math.max(1.5, Math.min(4, M.notesPerBar * 0.5)) : 2.5;
    const center = (M ? M.melCenter : T.mel.center) - 8;
    const { masks } = M ? { masks: null } : chordMasks(w, false);
    let diss = 0, strong = 0, cross = 0, checks = 0, coin = 0, leaps = 0, sum = 0, len = 0, par = 0, pairs = 0, rel = 0, ct = 0;
    let prev = null;
    for (let i = 0; i < n; i++) {
      const nt = cn[i];
      for (let s = nt.s; s < nt.s + nt.len; s++) {
        const m = sound[s];
        if (m < 0 || (s !== nt.s && mel.norm[s] < 0)) continue;
        const d = m - nt.p, ic = ((d % 12) + 12) % 12;
        checks++;
        if (d < 0) cross++;
        if (s % 4 === 0) { strong++; diss += DISS[ic]; }
        if (s === nt.s) {
          if (prev && prev.m !== m && prev.c !== nt.p && Math.sign(m - prev.m) === Math.sign(nt.p - prev.c) && (ic === 0 || ic === 7) && ic === prev.ic) par++;
          prev = { m, c: nt.p, ic }; pairs++;
        }
      }
      if (mel.norm[nt.s] >= 0) coin++;
      if (i && Math.abs(nt.p - cn[i - 1].p) > 7) leaps++;
      sum += nt.p; len += nt.len;
      const slot = nt.s >> 3, root = (w.roots[slot] + T.key) % 12, r12 = ((nt.p - root) % 12 + 12) % 12;
      if (M) rel -= M.melRel[(strengthOf(nt.s) * 4 + QCLASS[w.quals[slot]]) * 12 + r12];
      else if (masks[slot] & (1 << pcOf(nt.p, T.key))) ct++;
    }
    return 1.5 * Math.abs(n / 4 - density) / density
      + 3 * diss / Math.max(1, strong)
      + 2 * cross / Math.max(1, checks)
      + 2 * Math.max(0, coin / n - 0.5)
      + 1.5 * leaps / (n - 1)
      + 1.5 * par / Math.max(1, pairs)
      + 0.5 * Math.max(0, (3 - len / n) / 3)
      + Math.abs(sum / n - center) / 12
      + (M ? 1.5 * Math.max(0, rel / n - (M.base.melRel || 0)) : 2 * (1 - ct / n));
  }

  function chordLP(M, g, a, b) {
    const same = g.roots[a] === g.roots[b] && g.quals[a] === g.quals[b];
    const out = same ? 0 : 1 + (((g.roots[b] - g.roots[a]) % 12 + 12) % 12) * NQ + g.quals[b];
    return M.chordT[((b % 2) * NQ + g.quals[a]) * NQ1 + out];
  }

  // The whole song: each section scored on its own (averaged, so the scale
  // matches a single loop), plus terms for how the sections fit together.
  function evaluate(g, T) {
    const groups = new Float64Array(GROUPS.length), M = T.model;
    const wins = [[windowOf(g, WIN.A), true, false], [windowOf(g, WIN.B), false, false], [windowOf(g, WIN.E), false, true]];
    for (const [w, loop, ending] of wins) {
      if (M) sectionModel(w, T, loop, ending, groups); else sectionRules(w, T, groups);
      groups[5] += counterLoss(w, T);
    }
    for (let i = 0; i < groups.length; i++) groups[i] /= 3;

    // Chord moves across the section boundaries: A into B, and B back to A.
    if (M) groups[0] += 2.5 * Math.max(0, -(chordLP(M, g, 7, 8) + chordLP(M, g, 15, 0)) / 2 - (M.base.chord || 0));
    // B contrasts with A: a different tune and mostly different chords.
    const norm = parse(g.mel).norm;
    let sim = 0, same = 0;
    for (let b = 0; b < 4; b++) sim += barSim(norm, b, 4 + b) / 4;
    for (let s = 0; s < 8; s++) if (g.roots[s] === g.roots[8 + s] && g.quals[s] === g.quals[8 + s]) same++;
    groups[3] += 3 * Math.max(0, sim - 0.35) + 2 * Math.max(0, same / 8 - 0.5);
    // Mark the change of section: B doesn't open on the chord A just played.
    if (g.roots[8] === g.roots[7] && g.quals[8] === g.quals[7]) groups[3] += 1;
    // The song ends on the tonic chord.
    if (g.roots[GSLOTS - 1] !== 0) groups[3] += 1;

    let loss = 0;
    for (let i = 0; i < groups.length; i++) loss += groups[i];
    return { loss, groups };
  }

  // Hand-written rule critic, used when the learned models are unavailable.
  function evaluateRules(g, T) {
    const groups = new Float64Array(5);
    const key = T.key;
    const { masks, colors } = chordMasks(g, T.mel.color > 0.5);

    // Harmony
    let vocab = 0;
    for (let s = 0; s < SLOTS; s++) vocab += T.chordW[g.roots[s] * NQ + g.quals[s]];
    vocab /= SLOTS;
    let changes = 0, odd = 0;
    for (let s = 1; s < SLOTS; s++) {
      if (g.roots[s] !== g.roots[s - 1] || g.quals[s] !== g.quals[s - 1]) { changes++; if (s % 2) odd++; }
    }
    const seq = [];
    for (let s = 0; s < SLOTS; s++) if (!seq.length || seq[seq.length - 1] !== g.roots[s]) seq.push(g.roots[s]);
    if (seq.length > 1 && seq[0] === seq[seq.length - 1]) seq.pop();
    let trans = 0.3;
    if (seq.length > 1) {
      trans = 0;
      for (let j = 0; j < seq.length; j++) trans += Math.min(1, T.trans[seq[j] * 12 + seq[(j + 1) % seq.length]]);
      trans /= seq.length;
    }
    groups[0] = 5 * (1 - vocab) + 3.5 * (1 - trans)
      + 1.5 * (0.5 * (1 - T.startW[g.roots[0]]) + (1 - T.endW[g.roots[SLOTS - 1]]))
      + 1.5 * (Math.abs(changes - T.harmony.changes) / 3 + (changes ? Math.abs(odd / changes - T.harmony.odd) : 0));

    // Melody
    const M = T.mel;
    const { notes, norm } = parse(g.mel);
    const n = notes.length;
    if (n < 3) {
      groups[1] = groups[2] = groups[3] = 8;
    } else {
      let inScale = 0, unprepared = 0, strong = 0, strongHit = 0, sync = 0, short = 0, sum = 0, lo = 99, hi = 0;
      let ivSum = 0, bigLeaps = 0, leaps = 0, recovered = 0;
      for (let i = 0; i < n; i++) {
        const nt = notes[i], pc = pcOf(nt.p, key), w = T.scaleW[pc];
        inScale += w;
        if (w < 0.5) {
          const prev = notes[i - 1], next = notes[i + 1];
          if (!prev || !next || Math.abs(nt.p - prev.p) > 2 || Math.abs(next.p - nt.p) > 2) unprepared++;
        }
        if (nt.s % 4 === 0) {
          strong++;
          if (colors[nt.s >> 3] & (1 << pc)) strongHit++;
          else if (!(masks[nt.s >> 3] & (1 << pc))) strongHit -= 0.25;
        }
        if (nt.s % 2) sync++;
        if (nt.len === 1) short++;
        sum += nt.p; if (nt.p < lo) lo = nt.p; if (nt.p > hi) hi = nt.p;
        if (i > 0) {
          const d = nt.p - notes[i - 1].p, ad = Math.abs(d);
          ivSum += ad;
          if (ad > 9) bigLeaps++;
          if (ad >= 5 && i < n - 1) {
            leaps++;
            const d2 = notes[i + 1].p - nt.p;
            if (Math.sign(d2) === -Math.sign(d) && Math.abs(d2) <= 3) recovered++;
          }
        }
      }
      const meanIv = ivSum / (n - 1);
      groups[1] = 4 * Math.max(0, M.inScale - inScale / n) * 3 + 1.5 * (2 * unprepared / n)
        + 3 * (strong ? Math.max(0, M.chordTone - strongHit / strong) * 2 : 1)
        + 2 * Math.abs(meanIv - M.interval) / M.interval + 2 * (3 * bigLeaps / (n - 1))
        + 1.5 * (Math.max(0, hi - lo - 15) / 12 + Math.abs(sum / n - M.center) / 12)
        + 0.8 * M.recover * (leaps ? (leaps - recovered) / leaps : 0);

      let rests = 0;
      for (let i = 0; i < STEPS; i++) if (norm[i] === REST) rests++;
      groups[2] = 2 * Math.abs(n / 4 - M.density) / M.density + 1.5 * 2 * Math.abs(sync / n - M.syncop)
        + 1.5 * 2 * Math.abs(rests / STEPS - M.rest) + Math.abs(short / n - M.short);

      const last = notes[n - 1], lpc = pcOf(last.p, key);
      let ending = last.s < 48 ? 1 : lpc === g.roots[SLOTS - 1] || lpc === 0 ? 0 : masks[SLOTS - 1] & (1 << lpc) ? 0.4 : 1;
      ending += M.endLong * 0.5 * Math.max(0, (4 - last.len) / 4);
      groups[3] = 2 * (Math.abs(barSim(norm, 0, 2) - M.rep) + 0.5 * Math.abs(barSim(norm, 1, 3) - M.rep * 0.5)) + 1.5 * ending;
    }

    // Bass
    const Bt = T.bass;
    const bp = parse(g.bass), bn = bp.notes.length;
    if (bn < 2) {
      groups[4] = 10;
    } else {
      let rootScore = 0, segs = 0;
      for (let s = 0; s < SLOTS; s++) {
        if (s > 0 && g.roots[s] === g.roots[s - 1] && g.quals[s] === g.quals[s - 1] && s % 2) continue;
        segs++;
        const v = bp.norm[s * SLOT];
        if (v >= 0) rootScore += pcOf(v, key) === g.roots[s] ? 1 : masks[s] & (1 << pcOf(v, key)) ? 0.5 : 0;
      }
      let ct = 0, sync = 0, sc = 0, iv = 0, sum = 0, lo = 99, hi = 0;
      for (let i = 0; i < bn; i++) {
        const nt = bp.notes[i], pc = pcOf(nt.p, key);
        if (masks[nt.s >> 3] & (1 << pc)) ct++;
        if (nt.s % 4) sync++;
        sc += T.scaleW[pc];
        sum += nt.p; if (nt.p < lo) lo = nt.p; if (nt.p > hi) hi = nt.p;
        if (i) { const d = Math.abs(nt.p - bp.notes[i - 1].p); iv += d === 12 ? 0 : d; }
      }
      groups[4] = 3 * (1 - rootScore / segs) + 2 * Math.max(0, Bt.chordTone - ct / bn) * 2
        + 1.5 * Math.abs(bn / 4 - Bt.density) / Bt.density + Math.abs(sync / bn - Bt.syncop) * 2
        + 1.5 * Math.abs(iv / (bn - 1) - Bt.interval) / Math.max(1.5, Bt.interval)
        + (Math.abs(sum / bn - Bt.center) / 12 + Math.max(0, hi - lo - 14) / 12)
        + 2 * Math.max(0, 0.95 - sc / bn);
    }

    let loss = 0;
    for (let i = 0; i < 5; i++) loss += groups[i];
    return { loss, groups };
  }

  const DELTAS = [-12, -7, -5, -3, -2, -1, 1, 2, 3, 5, 7, 12];
  const ROOT_DELTAS = [-7, -5, -2, -1, 1, 2, 5, 7];
  const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];
  const clamp = (v, lo, hi) => (v < lo ? lo + ((lo - v) % 12) : v > hi ? hi - ((v - hi) % 12) : v);

  function nearbyPitch(track, i, rnd, lo, hi) {
    for (let j = i - 1; j >= 0; j--) if (track[j] >= 0) return clamp(track[j] + pick(rnd, DELTAS), lo, hi);
    return lo + Math.floor(rnd() * (hi - lo + 1));
  }

  function mutateTrack(track, rnd, lo, hi) {
    const r = rnd(), len = track.length;
    if (r < 0.5) {
      const ons = [];
      for (let i = 0; i < len; i++) if (track[i] >= 0) ons.push(i);
      if (ons.length) { const i = pick(rnd, ons); track[i] = clamp(track[i] + pick(rnd, DELTAS), lo, hi); return; }
    }
    if (r < 0.85) {
      const i = Math.floor(rnd() * len), t = rnd();
      track[i] = t < 0.4 ? nearbyPitch(track, i, rnd, lo, hi) : t < 0.7 ? HOLD : REST;
      return;
    }
    // Copy a bar or half bar elsewhere: lets motifs repeat.
    const seg = rnd() < 0.5 ? BAR : BAR / 2;
    const n = len / seg, a = Math.floor(rnd() * n);
    let b = Math.floor(rnd() * (n - 1)); if (b >= a) b++;
    track.copyWithin(b * seg, a * seg, a * seg + seg);
  }

  // Move a bar or half bar to another chord root, carrying its melody, bass
  // and counter-melody along so they keep the same relation to the chord.
  const fold = (v, lo, hi) => { while (v > hi) v -= 12; while (v < lo) v += 12; return v; };
  function shiftNotes(g, slot, n, d) {
    for (let i = slot * SLOT; i < (slot + n) * SLOT; i++) {
      if (g.mel[i] >= 0) g.mel[i] = fold(g.mel[i] + d, MEL_LO, MEL_HI);
      if (g.bass[i] >= 0) g.bass[i] = fold(g.bass[i] + d, BASS_LO, BASS_HI);
      if (g.ctr[i] >= 0) g.ctr[i] = fold(g.ctr[i] + d, CTR_LO, CTR_HI);
    }
  }
  function pickSegment(rnd) {
    const half = rnd() < 0.35;
    return half ? [Math.floor(rnd() * GSLOTS), 1] : [Math.floor(rnd() * NB) * 2, 2];
  }
  function transposeSegment(g, rnd) {
    const [slot, n] = pickSegment(rnd), d = pick(rnd, ROOT_DELTAS);
    for (let s = slot; s < slot + n; s++) g.roots[s] = (g.roots[s] + d + 12) % 12;
    shiftNotes(g, slot, n, d);
  }

  // Cumulative distribution over (root, quality) in the key: the learned
  // degree model, or the rule critic's chord vocabulary.
  function chordCdf(T) {
    const n = 12 * NQ, cdf = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) { acc += T.model ? Math.exp(T.model.degree[i]) : T.chordW[i] + 0.01; cdf[i] = acc; }
    for (let i = 0; i < n; i++) cdf[i] /= acc;
    return cdf;
  }
  // Propose a chord the genre actually uses for a bar or half bar. Half the
  // time the notes move with it, keeping their relation to the chord.
  function proposeChord(g, rnd, cdf) {
    const u = rnd();
    let i = 0;
    while (i < cdf.length - 1 && cdf[i] < u) i++;
    const root = Math.floor(i / NQ), q = i % NQ, [slot, n] = pickSegment(rnd);
    if (rnd() < 0.5) shiftNotes(g, slot, n, ((root - g.roots[slot] + 18) % 12) - 6);
    for (let s = slot; s < slot + n; s++) { g.roots[s] = root; g.quals[s] = q; }
  }

  function mutate(g, rnd, cdf) {
    const k = 1 + (rnd() < 0.5 ? 1 : 0) + (rnd() < 0.25 ? 1 : 0);
    for (let j = 0; j < k; j++) {
      const m = rnd();
      if (m < 0.07) { transposeSegment(g, rnd); continue; }
      if (m < 0.15) { proposeChord(g, rnd, cdf); continue; }
      const r = rnd();
      if (r < 0.36) mutateTrack(g.mel, rnd, MEL_LO, MEL_HI);
      else if (r < 0.54) mutateTrack(g.bass, rnd, BASS_LO, BASS_HI);
      else if (r < 0.68) mutateTrack(g.ctr, rnd, CTR_LO, CTR_HI);
      else {
        const s = Math.floor(rnd() * GSLOTS), t = rnd();
        if (t < 0.4) g.roots[s] = (g.roots[s] + pick(rnd, ROOT_DELTAS) + 12) % 12;
        else if (t < 0.7) g.quals[s] = Math.floor(rnd() * NQ);
        else {
          const o = s === 0 ? 1 : s === GSLOTS - 1 ? s - 1 : s + (rnd() < 0.5 ? -1 : 1);
          g.roots[s] = g.roots[o]; g.quals[s] = g.quals[o];
        }
      }
    }
  }

  function crossover(a, b, rnd) {
    const c = clone(a);
    for (let bar = 0; bar < NB; bar++) {
      if (rnd() < 0.5) c.mel.set(b.mel.subarray(bar * BAR, bar * BAR + BAR), bar * BAR);
      if (rnd() < 0.5) c.bass.set(b.bass.subarray(bar * BAR, bar * BAR + BAR), bar * BAR);
      if (rnd() < 0.5) c.ctr.set(b.ctr.subarray(bar * BAR, bar * BAR + BAR), bar * BAR);
      if (rnd() < 0.5) {
        c.roots.set(b.roots.subarray(bar * 2, bar * 2 + 2), bar * 2);
        c.quals.set(b.quals.subarray(bar * 2, bar * 2 + 2), bar * 2);
      }
    }
    return c;
  }

  // A population of songs; step() runs one generation and records the best.
  class Evolver {
    constructor(target, seed, size) {
      this.target = target;
      this.cdf = chordCdf(target);
      this.seed = seed >>> 0;
      this.rnd = mulberry32(this.seed);
      this.size = size || 200;
      // The starting noise depends only on the seed, so every genre starts
      // from the same random notes.
      const init = mulberry32(this.seed ^ 0x9e3779b9);
      this.pop = [];
      for (let i = 0; i < this.size; i++) this.pop.push(this.score(randomGenome(init)));
      this.pop.sort((x, y) => x.loss - y.loss);
      this.gen = 0;
      this.history = [this.snapshot()];
    }
    score(g) { const e = evaluate(g, this.target); return { g, loss: e.loss, groups: e.groups }; }
    snapshot() { const b = this.pop[0]; return { gen: this.gen, loss: b.loss, groups: Array.from(b.groups), genome: clone(b.g) }; }
    setTarget(target) {
      this.target = target;
      this.cdf = chordCdf(target);
      this.pop = this.pop.map((x) => this.score(x.g)).sort((x, y) => x.loss - y.loss);
    }
    tournament() {
      let best = this.pop[Math.floor(this.rnd() * this.size)];
      for (let i = 0; i < 2; i++) { const c = this.pop[Math.floor(this.rnd() * this.size)]; if (c.loss < best.loss) best = c; }
      return best.g;
    }
    step() {
      const next = this.pop.slice(0, 6);
      while (next.length < this.size) {
        const child = this.rnd() < 0.5 ? crossover(this.tournament(), this.tournament(), this.rnd) : clone(this.tournament());
        mutate(child, this.rnd, this.cdf);
        next.push(this.score(child));
      }
      next.sort((x, y) => x.loss - y.loss);
      this.pop = next;
      this.gen++;
      this.history.push(this.snapshot());
      return this.history[this.history.length - 1];
    }
  }

  const NOTE_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
  function chordName(root, q, key) { return NOTE_NAMES[(root + key) % 12] + QUALITIES[q].name; }

  root.MusicLab = { STEPS, BAR, SLOTS, SLOT, REST, HOLD, NB, FORM, SECTIONS, QUALITIES, GENRES, GROUPS, NOTE_NAMES, makeTarget, evaluate, parse, song, windowOf, Evolver, chordName, mulberry32, loadModels, components, mixModel };
})(typeof self !== 'undefined' ? self : globalThis);
