## edl build

```bash
vcut edl build --detect detect.json --output master.mp4 --campaign my-video
```

`--campaign` is a required free-form label that rides along in the EDL so a later reader can
tell which piece of work it belongs to. Nothing parses it; any stable string works.

Inverts the cut intervals into the spans worth keeping, so the EDL always describes surviving material. Boundaries are snapped to whole frames; unsnapped boundaries accumulate rounding error and make the renderer reject the result with a frame count mismatch.

Flags: `--edl <path>` (default `./edl.json`), `--width`, `--height`, `--fps`, `--edge-fade <ms>` (default 50), `--semantic <path>`, `--crop <spec>`.

**`--crop` frames the whole edit at once**, which is the reason it lives here and not in the
renderer's per-segment field. A traditional editor makes you set the frame per clip, so
remembering the menu bar after cutting means redoing every segment by hand. Here the crop is
one decision applied to all of them, and changing it never touches a cut boundary.

```bash
vcut edl build --detect detect.json --crop top:0.06 ...   # shave 6% off the top
vcut edl build --detect detect.json --crop 0.1,0,0.8,1 ...  # arbitrary window
```

Fractions, not pixels, so the same EDL survives a source at another resolution.

Every segment is written as `proposed` and the EDL as `draft`. **This command never approves its own work.**

**Read the boundary warnings.** When a segment opens right after a semantic cut, the build says so:

```
warning   segment-020 opens right after a semantic cut of 5.83s (18 words). A tail of removed
          speech surviving that join reads as a real sentence, so check it once rendered.
```

That is where the tail of removed speech leaks into the render, and it does not arrive looking
like a defect: it arrives as a plausible sentence with the wrong meaning, which reads as a
transcription error rather than a cut. Checking one is two commands — `vcut locate` for the
master position, `vcut say` to hear what landed there.

Only semantic cuts raise this. Silence cuts do not, and that is deliberate: with word clamping
every silence cut brushes the margin around a word, so keying the warning on "words were
removed" fired on 23 of 24 boundaries on a real EDL and would have trained you to skip it.

**Read `semanticCuts[].removedText` before rendering.** Every accepted semantic proposal gets
its own entry in the build report: the transcript words that fall inside its final span, and
whether each boundary lands inside a silence `detect` measured.

```
semantic cuts   2
  323.63-328.70s  repetition: "luego, no sé, puede pasar muchas cosas y cada uno está..."
  333.85-335.99s  repetition: "o sea, todos estamos en nuestro"
```

This is the corrective for a specific, already-shipped mistake: a repetition cut once removed
"todos estamos" instead of the stutter "en nuestra propia" because measured blocks were
mis-assigned to words. The mistake was invisible until a render and a windowed
re-transcription caught it. `removedText` makes the actual span legible at build time, before
any of that — read it and ask whether it matches what the `reason` describes.

`edl build` now asks that question for you where it can. A span whose `removedText` shares
fewer than half its carrying words (4+ letters, same comparison `converge` uses) with its own
`reason`, and has 4 or more carrying words itself, gets a warning:

```
warning   semantic cut 323.63-328.70s removes "luego, no sé, puede pasar muchas cosas y cada
          uno está en su propio ritmo,", which the reason does not mention ("'y cada uno esta
          en su propio ritmo, en su propia carrera' repite..."). Read removedText before
          rendering: a span can drift onto the wrong words when measured blocks are
          mis-assigned.
```

A short span (a lone filler, a couple of words) never fires this: it does not carry enough
signal to call disjoint, and firing there would train a reader to skip it, the same reasoning
behind not keying the boundary warning on "words were removed." `boundariesInSilence` is
reported alongside but not gated on — a semantic boundary landing in speech rather than
silence is common and not itself wrong, since the model chose it by meaning, not by pause.

**`removedText` inherits transcript drift, and `driftSuspect: true` says when not to trust it.**
`detect`'s own drift warning flags cues whose claimed start lands inside a span it measured as
silence — the transcript disagreeing with the audio about where speech begins. `removedText`
is built from those same cues, so a span sitting on drifted words can misreport what it removes
the same way the whole-file transcript can. On a recording with 326 drifted cues, `removedText`
cried wolf three times in one run, each wolf costing a `say --transcribe` to refute before the
real cause (drift, not a bad proposal) was found. `edl build` now reuses `detect`'s own drift
check, scoped to the words a span's `removedText` actually draws from, and marks the cut
`driftSuspect: true` with a matching warning when any of them contradict measured silence:

```
warning   semantic cut 662.35-671.83s removes "mejor. Quiero estornudar. ¡Wow! Ah, perdón,
          estorné...", built from cues that claim a word starts inside measured silence.
          removedText is driftSuspect here: do not trust it without a check (vcut peek or
          say --transcribe over the span).
```

`driftSuspect` is present and `true` only on a suspect span; a clean one has no such field at
all, not `false`. On a heavily drifted recording this can flag most or even every semantic
span — that is not a bug in the check, it is `detect`'s own "no invented tolerance" rule
(any word claiming to start inside measured silence counts, however far in) applied at span
granularity instead of file granularity. A saturated result is itself information: it says the
transcript's timing is unreliable everywhere in this recording, not just at the spans flagged,
and every `removedText` on the build is worth a `peek` before trusting it. This is deliberately
not a re-transcription: that answers what the audio actually says, which `peek` and `say
--transcribe` already provide on demand, and running one automatically per span would spend a
transcription call on every proposal whether it needed one or not.

Compare the reported `removalPercent` against the target for the content type:

| Content | Expected removal |
| --- | --- |
| Event or interview | 30-45% |
| Tutorial or screencast | 15-25% |
| Scripted talking head | 10-20% |

A number far below target usually means the source was already edited.
