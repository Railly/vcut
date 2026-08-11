## commit

```bash
vcut commit recording.mp4 --output master.mp4 --campaign my-video
vcut commit recording.mp4 --output master.mp4 --campaign my-video --video
```

Builds the EDL from a session's cached detect report and its accumulated proposals, then
renders it — the whole loop's build-and-listen step in one call, once a session has proposals
worth building.

**The build is byte-identical to running `edl build` by hand.** `commit` calls the exact same
seam `edl build` itself calls internally rather than a second implementation of the
merge/clamp/invert pipeline, so there is nothing here that can drift from what the standalone
command does on the same detect report and proposals. A session's cached detect report keeps
its own transcript path patched to the session's own cached copy before the build runs — the
same thing `peek` already does, and for the same reason: the path a detect report remembers can
move or vanish, and the session's own copy is the one guaranteed to still be there.

**The EDL is written to the current directory by default (`./edl.json`), never only inside the
session.** The session is disposable cache; the EDL is the artefact a human approves, and it
lives where they wrote it, exactly as `open`'s own manual entry already says about everything
else the session holds.

**`--audio-only` is the default render**, matching the core manual's own per-round rule:
every round's question is about sound, and rendering the picture for it costs 100x the wall
clock for nothing a round needs. `--video` renders the preview instead, for the one call at the
end of a loop. Output lands beside the EDL as `<name>.wav` unless `--output` already names one.

```
committed  ./edl.json
  removalPercent          14.2%
  semantic cuts           2
    660.24-671.83s        tangent: "Y así creo que va a ser mucho mejor. Quiero estornudar.
                          ¡Wow! Ah, perdón, estorné. Eso sí, borra la profa. Bueno, lo que"
    0.00-13.76s           tangent: "Hola, ¿qué tal? Eh, bueno, vengo a comentarles..."
  render                  rendered
  output                  ./master.wav
```

`build` in the JSON output is the same `BuildSummary` shape `edl build` emits — `removalPercent`,
`semanticCuts` with `removedText`, `boundariesInSilence`, warnings, all of it. `render` is the
same shape `render` emits. Nothing about reading either output changes because it came from
`commit` instead of the two commands run by hand.

Pulling only what a round needs to check, from the same call that already built and rendered:

```bash
vcut commit recording.mp4 --output master.mp4 --campaign my-video \
  --fields build.removalPercent,build.semanticCuts.removedText
```

**Records the round in the session** (`rounds/round-N/`: the EDL copy and the build report),
so a session carries its own history of what was proposed and what got built from it. Renders
and wavs stay out of the session, matching everything else the session holds: cheap to
regenerate, expensive to store.

**Carries the rounds gate in `roundsGate` and shapes `next` around it (#36).** Below 2
committed rounds, `roundsGate.status` is `'insufficient-rounds'` and `next` is the missing
pass — render, transcribe, `semantic review` against THIS render, read, `cut`, `commit` again —
never the approve-shaped hints, because those are exactly what let a run mistake round 1's own
verification for a second round. `--single-round` acknowledges a genuine one-round edit
explicitly, recording `single-round-ack.json` in the session so the override shows up in the
record rather than living only in the caller's head; a session already acknowledged reports
`'acknowledged-single-round'` instead of refusing. At 2 or more committed rounds without an
override, `roundsGate.status` is `'converged-pending-review'` — the floor is cleared, but
convergence still means the most recent round proposed nothing, which this field does not
itself verify.

**Master mode never happens here, and the human decision boundary the core manual states is
untouched.**
Approval is a human edit to the EDL — `approval.status` to `"approved"`, each segment's own
`approval` to `"approved"` — followed by the existing `vcut render --edl <path> --mode master`.
`commit` only ever drafts and previews; it does not write approval and it does not accept
`--mode master`. If you find yourself wanting `commit` to finish a master, that want is the
approval step arriving early, and the answer is still the same: hand the EDL to a human.

**Takes the session's advisory lock for the whole build+render**, released after (or on error —
a `finally`, not a happy-path-only release). A session already locked by another live process
refuses with the same holder-naming error `cut` gives. **On success, the session is marked
`committed`** — the spike's B7-Q2 rule: a successful commit is the signal `session gc` reads as
a candidate to clear, never a signal that triggers deletion by itself.
