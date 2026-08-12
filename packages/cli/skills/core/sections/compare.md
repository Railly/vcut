## compare

```bash
vcut compare --edl agent.json --reference approved-master.mp4 --lang es
```

**An approved master is ground truth.** This is the eval loop the CLI never had: once a human
has listened to a render and said yes to it, that file is a quality oracle for the next run on
similar material, and `compare` is the one command that reads it.

Every round in the agnostic-run series was graded by ear. The human listened, quoted what
should not have survived, and forensics went looking for it in the source — a transcription,
several `locate` calls, and a work order, every time. Runs 3, 4, and 5 each shipped or missed
cuts that only that listening caught.

Doing it once by hand collapsed the whole loop: transcribe the approved 9:11.5 reference edit
word-level, align its word stream against the source transcript, recover every span the human
implicitly removed, and diff that against the agent's EDL. The result was five concrete missed
spans, one of them a 6.4s flubbed clause at 165.0-171.5s that **no agent in five runs ever
found**. That analysis is this command.

### What it does

The reference's cut list is **recovered, not read**. A rendered master records nowhere what was
taken out of it; the only evidence is the difference between two word streams. So `compare`
transcribes the reference word-level, folds both streams to comparison tokens (diacritics
folded, punctuation stripped, lowercased — two transcriptions of the same speech disagree about
accents routinely, and every one of those disagreements would otherwise read as an edit), and
runs a longest-matching-subsequence opcodes walk over them, the same shape
`difflib.SequenceMatcher.get_opcodes` produces. Every run of source tokens the reference does
not carry is a span the human removed.

Then it diffs that recovered list against the EDL, both directions:

- **`missed`** — the reference removes this and the EDL keeps it. The primary product: material
  that survives into a render somebody will have to catch by ear. Each carries
  `coveragePercent` (how much of the span the EDL did reach) and `removedText` (the words it
  removes, quoted from the source transcript).
- **`overcut`** — the EDL removes this and the reference keeps it, with `keptText`.
- **`headline`** — durations on both sides, their delta, cut counts, and the two verdict totals.

### The reference can be three things

| `--reference` | What happens |
|---|---|
| edited media (`.mp4`, `.wav`, ...) | transcribed word-level in chunks, then aligned |
| a word-level `.srt` | aligned directly, no transcription |
| another EDL (`.json` with `segments`) | compared directly, no alignment at all |

An EDL reference states its cut list in source time already. Recovering one of them from audio
would be strictly worse evidence than the statement itself, so the alignment is skipped
entirely; a transcript there only supplies the quoted text, and its absence is a report without
quotes rather than a refusal.

The **source** transcript comes from `--transcript <srt>`, or from the session cached for the
EDL's own source when one exists (`vcut open <source> --transcript <srt>`). `compare` reads a
session, it never creates one.

### Transcription is the whole cost

```bash
# reuse a transcription you already have, instead of paying for another one
vcut compare --edl agent.json --reference master.mp4 \
  --reference-transcript master.srt --transcript source.srt
```

A media reference is real wall-clock time. `compare` transcribes it in chunks (`--chunk`,
default 120s), strictly sequentially — each chunk shells out to `trx`, which loads a Whisper
model into memory, the same reason `joins` and `nonspeech --verify` refuse to race — and streams
one progress line per chunk to **stderr**, the way `render` streams its ffmpeg reports. stdout
stays reserved for the result, so piping into `jq` still works while a human watches it move.

**Nothing is cached.** A chunk transcript keyed by nothing this command can invalidate is a
stale answer waiting to be trusted. `--reference-transcript <srt>` is the explicit,
caller-owned version of the same saving: you keep the SRT, you decide when it is still valid.

### The tolerances

Constants with evidence-based defaults, not flags. Each is a property of how two independent
transcriptions of the same speech differ, not a preference a caller has an opinion about.

| Constant | Value | Why |
|---|---|---|
| diacritic fold + punctuation strip | always | "información" vs "informacion" is not an edit |
| merge adjacent deletions | `< 0.8s` apart | a human cut lands where the sentence turns, not on a token boundary, so one removal comes back as two deletions with a survivor word between them |
| report spans | `>= 1.0s` | under a second, the difference between the two streams is transcription noise far more often than an edit |
| span counts as covered | `>= 60%` overlap | measured: every span both sides agreed on scored above 0.9, every span the human removed alone scored 0 — the bar sits between two clusters, not inside one |

A silence-only EDL cut (no words inside it) is never reported as an overcut. It carries no
speech to corroborate, and grading it against a speech alignment reports noise as findings.

### Reading the result

```bash
vcut compare --edl agent.json --reference master.mp4 --reference-transcript master.srt \
  --fields headline.missedCount,missed.startMs,missed.durationMs,missed.removedText
```

**A missed or overcut span is a place to look, not a verdict**, the same stance `joins` and
`peek` take. It rests on two independent transcriptions of the same speech agreeing about what
was said, and where they disagree the alignment reports an edit nobody made. Confirm a
surprising span with `vcut say --transcribe` over it before acting on it.

### The eval harness

A corpus of `(source, approved edit)` pairs turns any future change to vcut — or any agent run
against the same material — into a measurable regression test on edit quality. That is the
metric every release in this series was actually chasing, and until now the only instrument for
it was somebody listening.
