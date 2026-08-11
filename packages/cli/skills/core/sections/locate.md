## locate

```bash
vcut locate --edl edl.json --master 50.2 --explain
vcut locate --edl edl.json --source 80.07
vcut locate --edl edl.json --all
```

Translates between a position in the master and the source it came from. Reviewing a cut
means asking this constantly, and there is a trap in answering it by hand.

**Do not derive the mapping yourself.** Accumulating `outMs - inMs` across segments gives a
total that can match the rendered file to the millisecond while individual positions land
seconds away from where they really came from. The sum agreeing with the container is not
evidence that any single position is right, and there is nothing in that agreement to warn
you. `locate` does the same arithmetic, but `--explain` reports the neighbourhood a position
sits in, and `--render <path>` measures the file instead of trusting the EDL.

```
master 50.200           -> source 84.239  (segment-020)
segment                 source 83.942-85.308, 0.297 in
previous                segment-019 ends master 49.903
cut before it           0.367 of source removed
```

`cut before it` is worth reading. A boundary with a large cut behind it is where the tail of
removed speech survives into the render.

Asking `--source` about material that was cut is a normal question: it reports the span as
removed and names the next surviving segment, rather than failing.

The EDL records intent. Only the render says what happened, which is why the two can disagree
and why `--render` exists.
