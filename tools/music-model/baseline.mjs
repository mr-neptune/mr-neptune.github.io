// Measures each loss component on held-out real music (4-bar windows) with
// the same code the browser uses, and stores the medians as baselines.
// Usage: node baseline.mjs <models.json> <holdout.json>
import fs from 'node:fs';
import vm from 'node:vm';

const [modelsPath, holdoutPath] = process.argv.slice(2);
const here = new URL('.', import.meta.url).pathname;
vm.runInThisContext(fs.readFileSync(here + '../../public/lab/engine.js', 'utf8'));
const L = globalThis.MusicLab;
const json = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
const holdout = JSON.parse(fs.readFileSync(holdoutPath, 'utf8'));
const MINOR = { classical: false, jazz: false, lofi: false, rock: true, funk: true };

function windows(d, key) {
  const out = [];
  const shift = ((((key - d.tonic) % 12) + 12) % 12 + 6) % 12 - 6;
  for (let w = 0; (w + 4) * 16 <= d.end; w += 4) {
    const s0 = w * 16, chords = d.chords.slice(w * 2, w * 2 + 8);
    if (chords.length < 8 || chords.some((c) => !c)) continue;
    const mel = d.mel.filter((n) => n[0] >= s0 && n[0] < s0 + 64);
    if (mel.length < 4) continue;
    const g = { mel: new Int8Array(64).fill(L.REST), bass: new Int8Array(64).fill(L.REST), roots: new Int8Array(8), quals: new Int8Array(8) };
    const put = (arr, notes) => {
      for (const [s, len, p] of notes) {
        const k = s - s0, pitch = p + shift;
        if (pitch < 0 || pitch > 127) continue;
        arr[k] = pitch;
        for (let j = k + 1; j < Math.min(64, k + len); j++) if (arr[j] === L.REST) arr[j] = L.HOLD;
      }
    };
    put(g.mel, mel);
    if (d.bass) put(g.bass, d.bass.filter((n) => n[0] >= s0 && n[0] < s0 + 64));
    chords.forEach((c, i) => { g.roots[i] = (((c[0] - d.tonic) % 12) + 12) % 12; g.quals[i] = c[1]; });
    out.push(g);
  }
  return out;
}

const Q = +(process.env.Q || 0.1);
const quantile = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * Q)]; };
for (const [genre, model] of Object.entries(json.models)) {
  delete model.base;
  const M = L.mixModel(model, model, 0), key = L.GENRES[genre].key;
  const docs = holdout[genre].filter((d) => d.minor === MINOR[genre]);
  const vals = {};
  let count = 0;
  for (const d of docs.length >= 8 ? docs : holdout[genre]) {
    for (const g of windows(d, key)) {
      const c = L.components(g, M, key, false);
      if (!c) continue;
      count++;
      for (const k in c) (vals[k] ||= []).push(c[k]);
    }
  }
  model.base = {};
  for (const k in vals) model.base[k] = +quantile(vals[k]).toFixed(4);
  console.error(genre, `${count} windows from ${docs.length} files`, JSON.stringify(model.base));
}
fs.writeFileSync(modelsPath, JSON.stringify(json));
