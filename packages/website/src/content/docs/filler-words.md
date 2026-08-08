---
title: Filler words
description: Why filler detection needs a word-level transcript, and why a match is not a verdict.
order: 3
---

## Filler words

Cutting a single spoken word requires knowing where that word starts and ends. A normal SRT does not carry that: it has one cue per sentence, spanning several seconds and a dozen words.

vcut detects this and reports zero fillers with a warning naming the fix, rather than interpolating a position inside a cue. A confident wrong timestamp cuts into speech; an honest zero costs one re-run of the transcriber.

### Getting a word-level transcript

One cue per word. Either of these produces it:

```bash
# with trx, which wraps whisper and handles extraction
trx transcribe recording.mp4 --words --language es

# or with whisper-cli directly
whisper-cli -m model.bin -f audio.wav --max-len 1 --output-srt
```

Then point vcut at the result:

```bash
vcut detect recording.mp4 --transcript words.srt --lang es
```

The `fillers` line in the summary changes from `not checked` to a count.

### The lists

| Language | Words |
| --- | --- |
| `es` | aaa, eee, este, pues, o sea, tipo |
| `en` | uh, um, like, basically, you know, i mean |
| `pt` | aaa, eee, tipo, assim, entendeu, sabe |

Matching ignores case, accents, and punctuation, and handles multi-word entries like `o sea` across consecutive cues.

### A match is not a verdict

**The list matches tokens, not intent.** Spanish `este` is a filler in "y este, entonces" and an ordinary demonstrative in "en este caso". English `like` is a filler in "it was like, hard" and a verb in "I like this". The detector cannot tell them apart.

On a real six-minute recording, vcut found four filler hits and one of them was `este` inside "en este caso" — cutting it would have mutilated the sentence.

This is one reason every hit lands in the EDL as `proposed`. Read them before approving, or pass `--no-fillers` to `vcut edl build` and keep only the silence cuts.

### A better transcript can mean fewer cuts

Worth knowing, because it looks like a bug the first time: `whisper --max-len 1` stretches each cue to the start of the next word, so a word's range routinely swallows the pause that follows it.

On that same recording, 118 of 119 detected silences overlapped some word's range. Clamping every cut strictly inside word boundaries erased 57 of them outright, and removal collapsed from 10.5% to 2.7% purely because a better transcript was supplied.

vcut treats silence measured from audio energy as stronger evidence than a boundary inferred by a model. When clamping would shred a cut into a remainder shorter than your own `--min-silence`, that remainder is overlap residue rather than a real pause, and the measured span wins.
