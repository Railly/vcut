### The muletillas playbook

A vocalized filler — "eeeh", "mmm" — is a defect class that is audible and invisible to every
instrument that reads a transcript, `detect` included. A model cleans them even with a verbatim
preset: measured on a real 7.5-minute run (2026-08-10), the source transcript carried 0 "eh"
cues out of 1024, the master's transcript carried 0, and the render carried roughly seven
audible ones, all found by a human listener on the first playback and none by the five rounds
of the loop before it.

**Why the old closing rule was circular, stated plainly.** The manual used to close a `nonspeech`
hit by reading the whole-file transcript with `vcut say`. That verifies the finding of the one
instrument that hears the filler against the one instrument that structurally cannot: whisper
already cleaned it out, so the transcript will read "breath" or nothing every time, whatever the
audio actually holds. The check always passes and never means anything. `--verify` on `nonspeech`
replaces it, because it does not ask the transcript — it re-transcribes a fresh, narrow window
around the span, which is where the cleaning has not happened yet.

**The playbook:**

1. Run `vcut nonspeech <render> --verify` on the rendered preview, never the source (raw footage
   scores every pause as non-speech).
2. Read every `vocalization-suspect` reading. Each one carries the windowed transcript that
   recovered the filler's text — read `text`, not just the span's timing.
3. Place the cut boundaries with `vcut silences <media> --from <s> --to <s> --min 0.08` at fine
   resolution. The gaps around a filler measure 80-150ms, well under `detect`'s 0.3s default
   minimum, which is why `detect`'s silence list cannot place this boundary on its own.
4. Propose the cut with `kind: "filler"`, quoting the recovered text from `text` in the `reason`
   so whoever approves the EDL can read what is being removed rather than trust a classifier
   score. With a session open, `vcut cut <media> --span <startS>..<endS> --kind filler --reason
   "..."` does this directly — a filler's boundaries almost never line up with a session's own
   refs (they sit inside a block `open` measured as one span), so `--span` is the one the
   playbook reaches for, not `--refs`. Without a session, fold it into `proposals.json` by hand
   the same as any other finding.

This is where the playbook sits in the round: "The round, in order" already runs the non-speech
pass once, on the final preview, after the audio-only loop reads clean. With `--verify` that
pass stops being ceremony — a check whose output never changes a decision — and its
`vocalization-suspect` findings become a real proposal round instead of a formality cleared and
forgotten.
