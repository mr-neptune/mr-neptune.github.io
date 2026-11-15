# Genre style models for /lab

This directory trains the per-genre models that `public/lab/engine.js` uses as its loss.
Training happens offline. The browser only loads the result, `public/lab/models.json`.

## Data

The source data is not committed. It is downloaded into `~/data/midi`:

- [Lakh MIDI Dataset](https://colinraffel.com/projects/lmd/) by Colin Raffel (CC BY 4.0): `lmd_matched` and `clean_midi`.
- [tagtraum genre annotations](https://www.tagtraum.com/msd_genre_datasets.html) for the Million Song Dataset (`msd_tagtraum_cd1.cls`). They give `lmd_matched` its Jazz and RnB labels.
- Artist lists over `clean_midi` for classical, rock, funk, and extra jazz and R&B.

Lo-fi has no MIDI dataset of its own. It is trained on jazz and R&B files under 95 BPM.

## Pipeline

```sh
npm install

# 1. Features: melody, bass, a chord per half bar, key, tempo (16th-note grid).
#    list.tsv lines are "<genre>\t<path>".
for i in 0 1 2 3 4 5; do node extract.mjs ~/data/midi/list.tsv ~/data/midi/extracted/part$i.jsonl $i 6 & done; wait
#    Classical files are mostly human performances, so use a looser grid.
TOL=0.1 MIN_OK=0.55 node extract.mjs classical.tsv ~/data/midi/extracted/classical-loose.jsonl

# 2. Train. Every 10th file per genre is held out.
HOLDOUT=~/data/midi/extracted/holdout.json node train.mjs main.jsonl classical-loose.jsonl > ../../public/lab/models.json

# 3. Baselines. Score the held-out 4-bar windows with the browser's own code
#    (engine.js) and store the 10th percentile of each loss component.
node baseline.mjs ../../public/lab/models.json ~/data/midi/extracted/holdout.json
```

## What the models hold

All tables are key-independent except `degree`, which only uses files in the genre's mode.
Each component's loss is `max(0, value - baseline)`.

| Table | What it models |
| --- | --- |
| `melPat` / `bassPat` | 16-step onset patterns per bar: the top patterns, with a per-step Bernoulli backoff |
| `ivUni` / `ivBi` | Melodic intervals (±12 semitones), unigram and bigram |
| `melRel` | Melody pitch relative to the chord root, by beat strength and chord class |
| `chordT` | Next half-bar chord given the current quality and the bar position (root motion and quality) |
| `hr` | Number of chord changes per 4 bars |
| `degree` | Chord root degree and quality relative to the tonic |
| `bassRel` / `bassIv*` | Bass pitch relative to the chord root, and bass intervals |
| `fill`, `notesPerBar`, `melCenter`, `melSpan`, `sim02`, `sim13` | Articulation, density, register and phrase repetition |
