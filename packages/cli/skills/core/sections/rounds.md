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

**Without `--diff`, the summary carries the rounds gate too (#36).** `roundsGate.status` reads
`'insufficient-rounds'` below 2 committed rounds — the same refusal `commit`'s own output
gives, on the same field name, since this is the other surface an agent reads to decide a
session is done. It reads `'converged-pending-review'` at 2 or more, or
`'acknowledged-single-round'` when `commit --single-round` recorded the deliberate override for
this session. The second committed round has to contain a real propose pass against the first
round's render transcript; verification of round 1's own output does not count.

**`--diff` also reports whether round N's `metaSpeech` findings were addressed by round N+1
(#38).** Each round `commit` writes carries its own `rounds/round-N/metaspeech.json` — the same
`metaSpeech` field it emitted that round. `--diff` compares the earlier round's file against the
later one's by span identity: a finding present in the earlier round and gone from the later one
was cut (`addressed`); a finding present in both is `standing`, still unaddressed. `--human`
lists every `standing` span with its text, since that is the one a caller reading the diff still
has to act on. When either round predates #38 or had no transcript to check that round, the
comparison is `null` rather than a misleadingly empty list — there is no prior finding set to
diff against, and reading `null` as "nothing standing" would hide exactly the round that was
never checked.
