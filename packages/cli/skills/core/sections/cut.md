## cut

```bash
vcut cut recording.mp4 --refs b202..b207 --kind tangent --reason "sneeze, speaker says cut it"
vcut cut recording.mp4 --span 0..13.25 --kind tangent --reason "pre-roll before the take begins"
vcut cut recording.mp4 --list
vcut cut recording.mp4 --drop 0
```

Proposes a semantic cut against a session's own refs instead of a hand-typed millisecond pair,
and shows what it removes at the moment you propose it rather than after a build. `--refs`
takes a single ref or an inclusive range (`b042..b044`): a range runs from the first ref's own
start to the second's own end, spanning whatever lies between — silence, another block, or
both. Resolution reuses `peek`'s `resolveRef`, so an unknown ref or one from an earlier `gen`
is the same usage error naming the ref and the session's current generation, not a guess. A
reversed range (`b044..b042`) is also a usage error rather than a silent swap, since typing a
range backwards is almost always two refs transposed.

`--span <startS>..<endS>` is the escape hatch for when no ref fits — a cut that straddles what
the detector read as one long block, or a boundary a ref's own edges do not reach. Mutually
exclusive with `--refs`, so a call is never ambiguous about which one is driving the span.

**This is the corrective the arc names directly.** The corrupted-cut class this replaces — a
measured block mis-assigned to the wrong words, invisible until a render — cannot be written
here: the span comes from a ref that points at a block the session already measured, not from
a number typed while looking at a different output. `removedText` is quoted from the session's
own cached transcript at propose time, not re-transcribed: the same words a human would see
running `peek` themselves, read once here so proposing does not cost a second command.

```
testing-10m.mp4  proposed
  span                    660.93-670.37s
  kind                    tangent
  reason                  sneeze aside — speaker says "Eso si, borra la profa"
  removedText             que va a ser mucho mejor. Quiero estornudar. ¡Wow! Ah, perdón,
                          estorné. Eso sí, borra la profa.
```

`kind` is required and is the same four semantic kinds the model proposal shape already uses
(`false-start`, `repetition`, `tangent`, `filler` — `non-speech` is not a `cut` kind, since that
class comes from the classifier, not a ref). `reason` is required and non-empty, read by a
human deciding whether to approve, same as everywhere else in this manual.

**This `removedText` carries no `driftSuspect` flag, unlike `edl build`'s.** It is read straight
from the session's cached transcript at propose time, with no check against `detect`'s drift
warning — `edl build`'s own `driftSuspect` computation runs later, at build time, on the merged
span `commit` produces, not on what `cut` echoes here. On a recording with drifted cues, a
proposal's `removedText` at propose time can read clean here and still turn out to sit on
drifted words once `commit` builds it and reports `driftSuspect: true`. Trust the echoed text as
a preview, not as the drift-checked final read; if `detect`'s own drift warning fired on this
recording, confirm a specific span with `peek` before treating what `cut --list` shows as
settled.

**The session must already exist.** Unlike `open` and `peek`, `cut` never creates one: cutting
against a session nobody opened is a caller mistake, not a flow this command smooths over. The
error names the exact `vcut open` call to run first.

Proposals accumulate in the session's `proposals.json` (created on first `cut`), not in a file
you write and pass by hand. `--list` reads them back with their `removedText`; `--drop <index>`
removes one by its 0-based position — a human changing their mind about a proposed cut is a
normal step, and editing that JSON by hand is exactly the friction this arc exists to remove.
Re-adding after a drop appends at the end, not back at the dropped slot.

Proposing (and `--drop`) take the session's advisory lock for the duration of the write and
release it after; `--list` never locks, since it only reads. A second writer on a session
already locked by a live process gets an error naming the holder's pid, verb, and how long ago
it started — a lock held by a dead pid (a crashed process, a killed agent) clears itself
automatically on the next attempt by anyone, rather than needing a human to notice and delete
`lock.json` by hand. See `--section session` for the full lock and gc story.
