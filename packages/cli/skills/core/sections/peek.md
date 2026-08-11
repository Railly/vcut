## peek

```bash
vcut peek recording.mp4 --ref b042
vcut peek recording.mp4 --at 550.0 --window 5 --lang es
```

Four views of one position, aligned in a single call, instead of the four separate outputs a
review question used to mean juggling by hand: what the cached transcript claims is there
(`transcript`), what the audio actually says when asked again over the span (`heard`), the
speech/silence shape at fine resolution (`blocks`, -33dB/0.08s min over the span padded by a
second on each side — the same threshold `silences` names for placing a boundary around a
filler), and the level (`level`). `--ref` resolves a block from the session's `refs.json`
(`open` writes it); an unknown or stale-gen ref is a usage error naming the ref and the
session's current gen rather than a guess. `--at` takes a raw position and derives a span
`--window` seconds wide, centred on it (default 4).

Resolves the session for `<media>` the way `open` does: creates it if none exists, otherwise
reuses `checkSession`'s cheap size+mtime path rather than re-hashing.

**`viewsDisagree` is the field that pays for this verb.** It compares `transcript` against
`heard` on carrying words (4+ letters — the same comparison `converge` already uses, for the
same reason short words drift between two transcriptions of the same audio and comparing them
would report noise rather than disagreement), and names one of:

- `transcript-claims-more` — the cached transcript has carrying words the fresh transcription
  does not. The fabrication/fusion class: something the whole-file pass wrote that the audio,
  asked again, does not confirm.
- `heard-more` — the fresh transcription has carrying words the cached transcript does not.
  Omission, or the whole-file pass averaging a passage away.
- `soft-speech-below-threshold` — the fine-resolution `blocks` read silence for the entire
  span, but `heard` still carries words. This is the "Me siento muy..." class a real run
  found: speech quiet enough to sit under both `silences`' and `detect`'s volume floor, but
  plainly audible to a transcriber asked to listen to exactly that span. Neither a silence
  list nor a level threshold alone can see it; `peek` can, because it asks the audio directly.
- `aligned` — nothing across the two views disagrees at the word level this comparison uses.

**A disagreement is a place to look, not a verdict.** A window of a few seconds is itself a
noisy instrument — the same caveat `say`'s own manual entry gives `--transcribe` — so
`viewsDisagree: true` means "check this", the same stance `audit`'s correlation score and
`edl build`'s `removedText` warning already take, not a claim about which view is right.
Verified on a real recording: the three known drift zones from an earlier session all came
back disagreeing, but not always for the exact reason expected going in — one of them turned
out to be the re-transcription window itself cutting off a word a wider window recovers
cleanly, which is exactly the honest-limits case this field exists to surface rather than
hide.

`next` points past the disagreement rather than at it: a wider `say --transcribe` to settle
it, and a `silences` call at fine resolution over the same span to place a boundary once the
words are settled. Both are absent when `viewsDisagree.disagree` is `false` — nothing to
chase on a clean read.
