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
`--start-ms`/`--end-ms` is the same escape hatch in raw milliseconds, the unit `say`,
`silences`, and `semantic export` already emit.

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

**`cut --list` (and the accept response, and `--drop`'s echo) carry the same `driftSuspect` flag
`edl build`'s report computes**, reusing its `driftSuspectSpan` check rather than a second
implementation of it: present and `true` only when a proposal's own span is built from cues that
claim a word starts inside the session's cached measured silence, absent when clean. `--human`
prints it as a warning line under the proposal, same convention `edl build`'s own warnings use.

```
testing-10m.mp4  1 proposal(s)
  [0] 660.93-670.37s        tangent: "que va a ser mucho mejor. Quiero estornudar."
                            reason: sneeze aside
  warning                   [660.93-670.37s] removedText is driftSuspect: built from cues that
                            claim a word starts inside measured silence. Do not trust it without
                            a check (vcut peek or say --transcribe over the span). This
                            proposal's own span, not commit's merged one — a clean read here does
                            not guarantee a clean read once commit builds it.
```

One scope limit remains, named in the warning itself: this checks each proposal's own raw span,
not the merged span `commit` produces once it fuses a proposal with a neighbouring silence cut or
another proposal touching the same place. A clean read here does not guarantee a clean read once
`commit` builds it — only that the words this proposal itself claims to remove do not already
contradict the session's cached silences. `driftSuspect` is never persisted to `proposals.json`;
it is recomputed from the session's cached transcript and detect report every time a proposal is
read back, so it can never go stale relative to the cache it is checked against. If `detect`'s own
drift warning fired on this recording, confirm a specific span with `peek` before treating what
`cut --list` shows as settled.

**`--literal` is the answer to that same scope limit, for a boundary you have already verified.**
By default, `commit`/`edl build` report a proposal's `removedText` against the *merged* span it
absorbs into once it lands beside a silence cut or another proposal — the exact expansion the
previous paragraph warns about. That is normally the honest read: a proposal genuinely can grow
once it merges. But when the boundary already came from a fresh windowed re-transcription
(`say --transcribe --words` over the exact span), the drifted cached transcript is the thing
that is wrong, not the boundary — and the clamp-expansion forces a drop-and-repropose loop
fighting a check that has nothing left to catch. `--literal` trusts `--start-ms`/`--end-ms` (or
`--span`) exactly:

```bash
vcut say recording.mp4 --transcribe --words --at 668.0 --through 671.0 --lang es   # verify first
vcut cut recording.mp4 --start-ms 668930 --end-ms 670370 --kind repetition \
  --reason "verified boundary, triple repeat" --literal
```

The proposal's own span is reported exactly as given, never the merged one — but `removedText`
and `driftSuspect` are still computed, against that exact span, so the warning surface stays
intact. `driftSuspect: true` on a literal cut still means re-verify; the flag names a boundary
as caller-trusted, it does not silence the check that would otherwise catch a bad one.
`--list`, the accept response, and `commit`'s own build report all carry `literal: true` on the
proposal record (present-and-true-only, same convention as `driftSuspect`), so a reader can see
which cuts were named exactly rather than resolved. `--literal` is a usage error together with
`--refs`: a ref's span already comes from the session's own measured block boundary, so there is
nothing left to bypass.

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
