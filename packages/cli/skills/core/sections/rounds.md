## rounds

```bash
vcut rounds recording.mp4
vcut rounds recording.mp4 --diff 1 2
vcut rounds recording.mp4 --diff
```

A session's own history of what got built. Without `--diff`, lists every round number this
session has committed, ascending. With `--diff <N> <M>`, compares round `N`'s build report
against round `M`'s; omitting the two numbers diffs the latest two rounds — the common case of
"what did the last commit change".

```
round 1 -> round 2
  removalPercent          +13.33%
  segments                +1
  added                   3.00-4.00s  tangent: "..."
```

`removalPercentDelta` and `segmentCountDelta` are arithmetic on the two rounds' own build
summaries. `semanticCuts` is the more useful part: each round's semantic cuts are matched
against the other's **by span overlap**, not by array position, so a proposal whose exact edges
shifted slightly between rounds (a neighbouring cut absorbed it, or a re-clamp moved an edge a
few milliseconds) still reads as the same cut rather than one removed and one added. An entry
reports `added` (only in the later round), `removed` (only in the earlier one), `changed`
(matched, but kind/reason/removedText differ), or `unchanged` (matched and identical) — and a
session with nothing semantically different between two rounds says so explicitly rather than
printing an empty list a reader has to interpret.

**This diffs what each round's build asked for, not what either round's render actually
says.** The build report `rounds/round-N/report.json` already carries — `removalPercent`,
`segments`, `semanticCuts` with their `removedText` — is what gets compared. A text-level diff
of what a render's own transcript changed needs a transcript of that render, and a session
never stores one: renders and their transcripts stay out of the session on purpose (B2-Q2,
same reasoning `commit`'s own manual entry gives — cheap to regenerate, expensive to keep).
Confirm a semantic diff against what a render actually sounds like with `peek` or
`say --transcribe` on the renders themselves before trusting it alone.

**The session must already exist, with at least two committed rounds for `--diff`.** Like `cut`
and `commit`, `rounds` reads a session's history rather than creating one; the error for a
missing session or a session with fewer than two rounds names exactly what to run first.
