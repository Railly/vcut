## semantic

Repeated lines, false starts, and digressions need something reading the transcript. **vcut
never calls a model.** It exports the lines and takes back proposals, so you are the model in
this loop.

Call `review` once without `--terse` to read the instructions, then with it for every round
after: the block is identical each time and was 72% of the payload on one measured run.

```bash
vcut semantic export --detect detect.json > lines.json
# read lines.json, write proposals.json yourself
vcut semantic check --proposals proposals.json --detect detect.json
vcut edl build --detect detect.json --semantic proposals.json --output master.mp4 --campaign x
```

Export returns numbered lines with timings, rebuilt into words and split on measured pauses,
plus the instructions for what each `kind` means. Write back a JSON array of
`{startMs, endMs, kind, reason}` where `kind` is `false-start`, `repetition`, `tangent`, or
`filler`.

Two rules that are enforced, not advice. Every semantic cut lands as `semanticRisk: material`
on the segments around it, so a reviewer can find them without reading all of them. And
nothing malformed passes: an inverted span, a span past the end of the source, an unknown
kind, or an empty `reason` is refused by index and aborts the build. A proposal that vanished
between check and build would read as you choosing not to cut there, which is worse than a
refusal.

`semanticRisk: material` is measured against each proposal's **merged** span, not the raw span
you proposed. A proposal that sits close enough to a neighbouring silence cut (or another
proposal) absorbs into a wider cut before segments are inverted — the pipeline's own
merge/absorb step, the same one `edl build`'s `removedText` and `boundariesInSilence` already
read from. A ~9.4s proposal that absorbed a neighbour into a ~10s merged cut used to be
compared against its own raw 9.4s edges, so the segments touching the merged cut's real,
slightly wider boundary read `semanticRisk: none` — exactly the segments a reviewer approving
"what did the model choose to remove" needs flagged, since the render carries the full merged
span regardless of which raw proposal edge produced it.

`reason` is read by a human deciding whether to approve. Say what is lost, not what rule
matched. Proposing nothing is a valid answer.

**`export` and `review` answer different questions, and the names alone do not say so.**
`export` gives you lines to propose against — the raw material for a round that has not built
anything yet. `review` checks a finished round: it reads an EDL back and reports the transcript
as it survives the cuts, `repeated`/`unreviewed`/`metaSpeech` included, none of which `export`
computes because there is no EDL yet for them to be checked against. `commit` now carries
`review`'s own `metaSpeech` check itself (#38, below) — one more reason `export` was never the
place to look for it: an agent reaching for "the lines" via `export` gets exactly the lines and
nothing checked against a round.

## metaSpeech

`review`'s output carries a `metaSpeech` field: spans of first-person editing verbs and
self-directed commands ("rebobinando", "corta eso", "otra vez", "scratch that") that sit
outside every span this EDL already cut. It exists because a run's candidate search was a grep
over markers it had already seen: the recording carried five spoken self-directed edit markers,
the agent cut four, and "ah, ok, otra, rebobinando" chained grammatically into the next clause
and read straight past it. `metaSpeech` is checked structurally against every line instead,
regardless of what a round already looked at.

The lexicon is review vocabulary, not a detector run separately. Seeded from the issue: Spanish
stems `rebobin-`, `corta-`, `borra-`, `olvid-`, `repit-`/`repetir`, plus the fixed phrases "eso
no", "otra vez", "de nuevo", "mejor dicho", "no sirve"; English `rewind`, `again`, `redo`, plus
"cut that", "delete that", "scratch that", "forget that", "take two". Stems match conjugated
forms as a prefix of the folded, lowercased word, so "rebobinando", "rebobiné", and "córtalo"
all fire from one entry. Diacritics fold the same way `foldDiacritics` already does for
`repeated`.

It is a candidate list, not a verdict, same as `repeated`. `corta` fires on the imperative
("corta eso") and on the adjective ("una versión corta") alike: telling them apart needs
grammar this word-level lexicon does not parse, and building that parser for one ambiguous stem
was not worth it against reading the line (MSW). `REVIEW_INSTRUCTIONS` says so explicitly and
requires every `metaSpeech` entry to be answered the same way every entry in `repeated` is:
propose a cut, or say why it stays. This is not a search for imperative verbs — the marker that
motivated it, "ah, ok, otra, rebobinando", was narrated backtracking with no directive verb at
all. The test that classifies it correctly is the same deletion rule every other candidate here
answers to: a span that can be deleted without a listener learning anything less.

A lexicon on its own is not the fix for the failure that motivated it. The agent's own retro on
the run that shipped "rebobinando" put it plainly: a lexicon without the rounds gate just gives
the next run a bigger list to skim past. The gate — refusing to call an edit converged on fewer
than two committed rounds — is #36. `metaSpeech` makes the marker structurally visible in every
round's output; #36 stops a round from reading past it.

**Neither was enough on its own (#38).** A fourth agnostic run ran four gated rounds through
`open`/`cut`/`commit` and never once invoked `semantic review` — the only verb `metaSpeech`
lived inside — and shipped the same marker again. A finding-class that only exists inside a verb
the session loop never forces to run is optional by construction, whatever the gate around it
says. `commit` (`--section commit`) now runs the same `metaSpeech()` pass itself, on every round
that has a transcript, no verb required: the field rides in `commit`'s own output, the one
artefact a run reads in full every round, unprompted.
