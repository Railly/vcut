## What eleven runs taught

Eleven agents edited the same recording with nothing but this manual. Four shipped a defect a
listener caught immediately. What separates the runs that worked is not effort — every run read
the transcript, every run ran the checks — so these are the habits worth carrying, each with
what it cost to learn.

**Never let the empty round be the first.** Four of the five failures reported nothing after one
pass. The round that finds the largest cut is usually the second, because it reads a text the
first round produced and nobody had seen. The shortest run cut 33.78% and called itself done;
the one required to continue cut 44.04% and was right.

**Read the result, not the plan.** Every failure was a run that read its own proposals and
called them the outcome. The render's transcript is the only description of what a viewer hears.

**A number is not a verdict.** A repeated phrase, a low correlation, a classifier hit, a removal
percentage outside its range: each is a place to look. Three of them fired on runs whose masters
were perfect, and one detector was hardened into a gate that pushed toward deleting a line the
author wanted. Anything counting words cannot tell a callback from a retake.

**Say what you decided, in a reason.** Keeping a repeat is often right and leaves no trace on its
own, which makes it indistinguishable from missing it. A reason is the difference between a
judgement someone can review and one nobody can find.

**Distrust a boundary you verified.** Every attempt at a retake says the same words, so a window
opened anywhere inside one comes back complete and convincing. Three runs each verified a
boundary and each was wrong by about 1772ms. Step the window forward until the phrase stops
coming back; agreement between runs means they read the same wrong number.

**Spend on reading, save on auditing.** The run that cut fastest also cut worst. `audit` and the
non-speech pass never changed a decision across eleven runs — they are cheap insurance, run once
at the end, not a source of findings. The transcript is where the defects are. That held before
`--verify` existed: a raw non-speech span closed against the whole-file transcript really was
ceremony, because the transcript could not see what the classifier saw. `--verify` changes what
the pass finds, not this rule about when to run it — still once, at the end, still audio-only in
every round before it. See `--section muletillas`.

**Check the input before reporting a bug.** Two bug reports in this project were filed against
the wrong project, both after a premise nobody measured. `ffprobe` on the file you passed costs
less than an issue.
