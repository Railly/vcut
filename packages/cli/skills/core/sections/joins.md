## joins

```bash
vcut joins --edl edl.json --render cut.mp4 --report report.json --lang es
```

The post-render twin of `edl build`'s `removedText`: one call that verifies every semantic
join instead of `N x (locate + say --transcribe)`. On a real 11.7-minute run (2026-08-10,
testing-10m.mp4), verifying 9 joins by hand cost about 14 calls — this collapses that whole
round to one, at 8 joins re-transcribed in ~15 seconds wall time.

Each **join** is the EDL segment that opens right after a semantic cut, derived the same way
`edl build`'s own `boundariesAfterSpeech` finds it: by the *kind* of cut, not a distance, so
this can never disagree with the "opens right after a semantic cut" warning `edl build`
already writes about the same boundary. A semantic cut at the very start of the file has
nothing before it to join, and is silently absent from the result.

`joins` runs on `--render`, never the source — the EDL says what was asked for, only the
render says what happened, the same stance `locate --render` takes. It checks the EDL's own
master-time total against the render's measured duration before reading a single window
(`renderCheck`, same shape as `locate --render`), then re-transcribes a window around each
join (default 4s) and reports a `reading`:

- `lands` — the window's carrying words do not majority-overlap the cut's `removedText`. The
  join connects to whatever comes next.
- `removed-text-leaked` — the window shares a majority of carrying words with `removedText`.
  The tail of the removed speech may have survived into the render.
- `check-by-ear` — the window carries no words worth judging, same honest-limits stance
  `peek`'s `viewsDisagree` and `nonspeech --verify` already take rather than reading silence
  as success.

**`removed-text-leaked` is a place to look, not a verdict.** Verified false positive on real
material: a false-start's `removedText` was the speaker stumbling on "agregar
verificabilidad" three times before landing it, and the surviving sentence legitimately used
"agregar verificabilidad" as its real content — carrying-word overlap cannot tell a leaked
tail from a kept sentence that shares vocabulary with its own discarded false starts by
construction. A wider `say --transcribe --window 8` confirmed the join read clean; `joins`
names that exact call in `next` on a leaked or check-by-ear reading.

`--report <path>` points at a build report (`vcut edl build`'s own JSON, `vcut commit`'s, or
`rounds/round-N/report.json`, the default sibling lookup next to `--edl`) for
`removedText`/`reason`/`driftSuspect` on each join. Its absence is a supported state: `joins`
still runs and reports `reading` from the window alone, with those three fields `null`.

Checking only the readings worth a second look, not the whole payload:

```bash
vcut joins --edl edl.json --render cut.mp4 --report report.json \
  --fields joins.reading,joins.joinMasterMs,joins.removedText
```
