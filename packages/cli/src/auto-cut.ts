/**
 * The deterministic pass: what an instrument can prove is cut, not proposed.
 *
 * #63's forensics are the sharpest form of the pattern the last five releases each attacked from
 * a different angle. A human listened to a shipped render (`round9.wav`, 374.9s, certified clean
 * by `audit`, `joins`, `nonspeech --verify`, `verify --windows` and the rounds gate) and found 27
 * defects in six minutes. Twenty of them, 74%, were ALREADY REPORTED by an instrument that ran.
 * `nonspeech` returned 40 spans containing all six coughs at near-identical timestamps; a -40dB
 * silence sweep returned 19 spans totalling 34.4s including every pause the human named;
 * `verify --windows` reported the exact repetitions. Nothing acted on any of it, because the model
 * was asked to judge them and talked itself out of it, six consecutive runs on the same material.
 *
 * So the division of labour moves to follow what can be proven. An instrument that can prove a
 * span is a defect cuts it. The model only ever sees the ambiguous remainder: fuzzy repetition,
 * semantic self-correction, redundancy at distance, narration that does not carry the idea. A
 * model asked to ratify a proof will eventually decline, and measurably does.
 *
 * Four classes cut here, each named by the instrument that proves it, and every emitted cut
 * carries `instrument` plus the `measurement` that fired so the EDL explains itself: a cut nobody
 * can trace back to evidence is not acceptable, and `reason` is built from that measurement rather
 * than from prose.
 *
 * ## The silence threshold, and why the calibrated floor could not be used as-is
 *
 * #63 says to use #43's calibrated `probeNoiseFloor` and never the -30dB preset. Measured on
 * `round9.wav` directly (2026-08-16), the calibrated path underreports on a RENDER as badly as the
 * preset does: `probeNoiseFloor` returns floorDb -78.67, threshold -68.67, and finds 4 pauses /
 * 6.8s. That is not a transcription of the issue's number, it is what the shipped round 9 itself
 * recorded, verbatim: "deadAir 4 pauses survived, floor -78.7dB, threshold -68.7dB". The three
 * silences the human named by ear (111.2s, 266.7s, 344.9s) are all invisible to it.
 *
 * The cause is that `probeNoiseFloor` takes the MINIMUM window, and a render is not a raw mic
 * track: it is a file assembled from cuts, so it contains spots of near-digital silence that are
 * artefacts of the assembly rather than the room. The quietest 2s window sits at -78.67dB, the
 * next at -70.26, the third at -64.45, the fifth at -47.19: an outlier and a cliff, not the
 * "real plateau" `dead-air.ts`'s own header measured on a raw source. Every quiet-tail estimator
 * collapses the same way here (at a 1s window the minimum is the -90dB clamp itself), so no
 * k-th-smallest variant rescues it without fitting a number to one recording, which is exactly
 * what `build-edl.ts`'s `boundariesAfterSpeech` header warns against.
 *
 * The floor is the wrong anchor for a rendered file, so this measures from the other end, which
 * `semantic.ts` already established as the right shape for a threshold with no natural fixed
 * value: `QUIET_BELOW_MEDIAN_DB = 12`, "how far below this recording's own measured level". The
 * median window is speech. Measured: round9.wav's median window is -20.83dB, and median minus 20
 * is -40.83dB, which reproduces the -40dB baseline #63 measured by hand almost exactly, with no
 * knowledge of "-40" fed in, and returns 19 spans / 33.9s against the issue's 19 spans / 34.4s.
 * The same rule on the source track (median -44.71dB) lands at -64.71dB rather than transplanting
 * the render's number onto a differently-gained file, which is the whole reason the threshold is
 * derived per file instead of fixed. `probeNoiseFloor` is still consulted and still reported, and
 * whichever of the two threshold is HIGHER wins: the floor-anchored number is the right one on a
 * source whose processed noise floor sits tens of dB above true silence (#43's founding case), and
 * the median-anchored one is the right one on a render assembled with digitally silent joins.
 * Taking the higher of two independently measured thresholds means neither failure mode can hide
 * the other, and both are recorded on the report.
 *
 * ## Repetition: which occurrence goes
 *
 * The EARLIER occurrence is removed and the LATER one kept. This is the speaker's own retake
 * grammar: someone who fumbles a line says it again, and the second attempt is the completed one.
 * Verified against this render's own material rather than assumed. `verify --windows` reports the
 * repeat "y ahi pueden ver como me envio el haiku / y ahi me envio el haiku" at 3:22; the human's
 * own annotation of that entry writes the fuller phrasing first and the tighter one second, and
 * every repetition entry on the list reads the same way: the first pass is the one that trails
 * off. Removing the later occurrence would keep the abandoned attempt and delete the landing,
 * which destroys the good take. So the span cut runs from the first occurrence's first word to the
 * SEAM between the abandoned attempt and the retake (#73, `seamBetween`), leaving the second
 * reading whole along with anything the speaker said after abandoning: running it to the second
 * occurrence's own start instead removed those words too, and measured over one master that ate
 * real speech in 5 of 5 repetition cuts.
 *
 * Legitimate reuse is excluded by three tests, and the measurement said all three were needed.
 * #57's content-word floor is re-applied here rather than inherited (`mergeRepeats` folds in
 * `findStackedOpeners`, which has no content test of its own, and that is how "te va" with zero
 * content words reached `repeatedPhrases` on this render). `MAX_RETAKE_GAP_MS` bounds the two
 * readings to the adjacency a retake actually has. Neither is sufficient: five findings on this
 * render clear both and are still not retakes, because the speaker opened twice the same way and
 * then went somewhere different ("le damos clic aquí a Open ChatGPT" / "le damos clic a Plus", two
 * different buttons in a tutorial, which is the exact class #63 names). `continuesTheSame` is the
 * test that catches those, by requiring nothing at all between the two readings.
 *
 * ## Boundaries, and why the cached transcript cannot supply them
 *
 * #61 established that `removedText` is unreliable on drifted sources, so every boundary here comes
 * from measured word timings. Which timings turns out to matter as much as the rule. The session's
 * cached whole-file transcript cannot locate a repetition at all: it is the pass that averaged the
 * repeat away, which is the founding premise of #44. Measured on this render, only 1 of 9 sweep
 * findings could be located against the cache, so the repetition class re-measures each finding's
 * own window with `transcribeWindowWords`, the primitive that exists for exactly this arbitration.
 *
 * The cache is also unusable as a veto for the two energy-measured classes, and for a second
 * reason: cues stretch to the next word's start (`clampToWords`'s own finding), so they claim
 * 326.8s of this 374.9s render as word-time, one cue for "CloudCode." claims 8250ms alone, and
 * vetoing a measured silence on cue overlap rejects 18 of 19. Energy is the authority for silence;
 * see `silenceCuts`. `snapToWords` still trims a cut off the onset of the word that follows it, but
 * it ignores any onset falling inside audio the energy pass already read as silent, since that is
 * `driftSuspectSpan`'s definition of a drifted cue rather than a word.
 *
 * ## What this pass catches, measured
 *
 * Against the 20 deterministic-class entries a human annotated on `round9.wav`: 9 caught. The
 * misses are all repetition, and they are upstream: `verify --windows` never reported them,
 * because its own whole-window transcript had already averaged the repeat away ("abrimos la guia /
 * abrimos la opcion" reads as one clause in the window text). This pass cannot act on a finding no
 * instrument produced, which is the honest boundary between it and #44.
 */

import { type NoiseFloor, probeNoiseFloor } from './dead-air.ts'
import { parseSilenceLog, probeDurationMs, type SilenceCandidate, type Word } from './detect.ts'
import { run } from './exec.ts'
import type { Span } from './nonspeech.ts'
import { contentWordCount, MIN_CONTENT_WORDS, type Proposal, stopwordsFor } from './semantic.ts'
import { transcribeWindowWords } from './transcribe-window.ts'
import type { RepeatedPhrase } from './verify.ts'

/**
 * A cut this pass made, and the proof it made it from.
 *
 * `instrument` names which check fired and `measurement` carries what it measured, in the units it
 * measured them in. Together they are what makes the cut traceable: #63's safety requirement is
 * that a cut nobody can trace back to evidence is not acceptable, so `reason` below is generated
 * from these two rather than written as prose, and the round's own record keeps them beside the
 * EDL the way `dead-air.json` and `listener.json` already sit there.
 */
export type AutoCut = {
  startMs: number
  endMs: number
  kind: Proposal['kind']
  instrument: 'nonspeech' | 'silence' | 'repetition' | 'fragment'
  measurement: string
  reason: string
}

export type AutoCutReport = {
  version: 1
  cuts: AutoCut[]
  // Present only when the pass measured cuts and then declined to make any of them because they
  // exceeded MAX_AUTO_REMOVAL_FRACTION. Absent on every ordinary run, so it can never be mistaken
  // for a normal empty result.
  stoodDown?: {
    proposedCuts: number
    proposedMs: number
    durationMs: number
    reason: string
  }
  // Both thresholds that were measured, and which one was used. Present even when the pass cut
  // nothing, the same "absence can never be read as not-checked" rule #38 set for metaSpeech.
  silence: {
    floorDb: number | null
    floorThresholdDb: number | null
    medianDb: number | null
    medianThresholdDb: number | null
    thresholdDb: number | null
    minPauseMs: number
  }
  // How many findings each instrument offered and how many became cuts, so a reader can see what
  // was declined without re-deriving it. A declined finding is the model's remainder, by design.
  considered: Record<AutoCut['instrument'], { offered: number; cut: number }>
}

/**
 * How far below the file's own median window a span has to sit to read as silence rather than
 * speech.
 *
 * `semantic.ts` already measured the shape of this decision for the identical question
 * (`QUIET_BELOW_MEDIAN_DB = 12`, how far below a recording's own level a segment reads as quiet).
 * Twelve is the right distance for "this segment is quieter than the rest"; silence is further
 * down than that, and the distance is measured rather than picked: at median minus 12 the render
 * threshold lands at -32.83dB, which fires inside ordinary speech, and at minus 20 it lands at
 * -40.83dB, which reproduces #63's own hand-measured -40dB baseline (19 spans / 33.9s here
 * against the issue's 19 / 34.4s) and hits all three silences the human named by ear. Minus 24
 * (-44.83dB) drops to 14 spans and loses two of them.
 */
const SILENCE_BELOW_MEDIAN_DB = 20

// Same 2s bucket `dead-air.ts` measures its own floor over, for the same stated reason: wide
// enough that one near-silent phoneme gap does not skew it, narrow enough that a real pause of
// the length this catches lands inside one bucket whole.
const LEVEL_WINDOW_S = 2

// Same `d=0.8` floor `detect` and `dead-air` already use for "worth reporting" as a pause.
const MIN_PAUSE_MS = 800

/**
 * The most of a render this pass is ever allowed to remove by itself.
 *
 * A pass that proposes can be wrong and cost a reader some reading. A pass that CUTS can be wrong
 * and cost the recording, so it needs a bound that does not depend on any of its own instruments
 * being right. This one is not tuned to a defect rate: it is the assertion that a render whose
 * measured evidence says most of it is removable is a render whose measurement is broken, not a
 * render that is mostly defect.
 *
 * The failure it catches is real and was hit while building this, not imagined: run against
 * fixtures of pure silence, the silence class marked the entire file and `assertSegmentCount`
 * threw "no segments survive; every span was marked as a cut", turning an additive check into
 * something that could break a commit outright. That is exactly the shape an unconditional
 * placement must never have.
 *
 * Half is the bound because `build-edl`'s own `TARGET_RANGES` already put the widest editorial
 * target at 30-45% removal ("event or interview") and treat anything above the ceiling as worth
 * questioning. This pass removing more than half on its own, before the model has looked at
 * anything, is past every range the tool already recognises, so it stands down and leaves the whole
 * decision to the round rather than cutting on a measurement that disagrees with the editorial
 * shape of every real edit.
 */
const MAX_AUTO_REMOVAL_FRACTION = 0.5

/**
 * The shortest piece of speech that can stand on its own, and the orphan-fragment threshold.
 *
 * Not invented here: `invertToSegments` already takes `minKeepMs = 300` (build-edl.ts) and
 * `absorbSlivers`'s own header defines it as "a fragment too short to carry a word, bracketed by
 * silence on both sides", the shortest defensible piece of speech. It in turn inherits
 * `DEFAULT_MIN_SILENCE_MS = 300` from `detect.ts`: a stretch of audio the detector would not have
 * called a pause is not long enough to be a word either.
 *
 * Checked against this render's own data rather than taken on faith. Source word durations
 * (1333 word-level cues): p25 is 150ms and the median is 380ms, so 300ms sits between them,
 * below the typical word and above the quarter of tokens that are clitics and articles. The
 * shipped EDL's own segments agree from the other side: the shortest surviving segment is 522ms
 * and nothing lands between 300 and 500, so this threshold separates a stranded fragment from
 * every piece the build already considered a real line.
 */
const MIN_FRAGMENT_MS = 300

/**
 * The widest gap between two readings that still reads as one speaker retaking one line.
 *
 * This is the guard against the legitimate-reuse class #63 names directly (a button clicked four
 * times in a tutorial, a product name). #57's content-word floor already removes connective
 * tissue, and `verify` routes anything under it to `discountedRepeats`, which this pass never
 * reads; what the floor cannot separate is a real content phrase said twice on purpose, far apart,
 * from the same phrase said twice because the first take fumbled.
 *
 * Adjacency is what separates them, and the sweep's own geometry already supplies the number
 * rather than this file inventing one: `verify --windows` only ever reports a repeat it heard
 * INSIDE one window, and `findRepeatedPhrases` is deliberately not cross-window, so a finding
 * exists at all only when both occurrences fit within `SWEEP_WINDOW_MS` (16s). Half a window is
 * the bound that makes a repeat adjacent rather than merely co-windowed: both readings plus the
 * fumble between them inside 8s. Measured against the human's own list, every repetition entry
 * spans 1 to 5 seconds; the one entry explicitly classed as redundancy at distance (5:20-5:27,
 * the encryption argument made twice in different words) runs 7s and is not an exact repeat at
 * all, so it stays with the model where the issue puts it.
 */
const MAX_RETAKE_GAP_MS = 8_000

/**
 * A span clamped outward to the measured word boundaries around it, so no cut ever lands inside a
 * word. #61: cue text is unreliable on drifted sources, so this reads the word TIMINGS only and
 * never their text. A word that straddles an edge pushes that edge past it rather than splitting
 * it: a cut that clips the head off the following word is the defect this exists to avoid.
 */
export const snapToWords = (span: Span, words: Word[], silences: SilenceCandidate[] = []): Span => {
  if (words.length === 0) {
    return span
  }
  // A cue start inside audio the energy measurement already read as silence is drift, not a word:
  // this is `driftSuspectSpan`'s own definition (build-edl.ts), "cues that claim a word starts
  // inside measured silence". Measured here, honouring such a cue truncated the 3:36 cough cut
  // from 212.82-218.11s down to 212.82-213.42s, and the span it gave back measures -63.4dB mean
  // with whisper hallucinating "Gracias por ver el video" over it. Energy wins over a cue for the
  // same reason it wins in `silenceCuts`.
  const inMeasuredSilence = (ms: number): boolean =>
    silences.some((silence) => ms >= silence.startMs && ms < silence.endMs)
  // Word STARTS only: a cue's end is stretched to the next word and clamping to it would widen
  // every cut by the pause the cue swallowed. A word that begins inside the span but continues
  // past its end pulls the end back to that onset, so the cut never eats the head of a word that
  // is about to be spoken.
  let endMs = span.endMs
  for (const word of words) {
    if (
      word.startMs > span.startMs &&
      word.startMs < endMs &&
      word.endMs > endMs &&
      !inMeasuredSilence(word.startMs)
    ) {
      endMs = word.startMs
    }
  }
  return { startMs: span.startMs, endMs: Math.max(span.startMs, endMs) }
}

/**
 * The median 2s window's level, in dB: this file's own speech level, the anchor the silence
 * threshold is measured down from. Shares `astats` output shape with `dead-air.ts`'s
 * `quietestWindowDb` but answers the opposite question, so the two are deliberately separate
 * rather than one function with a percentile argument that would read as tunable.
 */
export const medianWindowDb = (metadataOutput: string, windowS: number): number | null => {
  const buckets = new Map<number, number[]>()
  let pendingTimeS: number | null = null
  for (const rawLine of metadataOutput.split('\n')) {
    const timeMatch = rawLine.match(/pts_time:([\d.]+)/)
    if (timeMatch !== null) {
      pendingTimeS = Number(timeMatch[1])
      continue
    }
    const dbMatch = rawLine.match(/RMS_level=(-inf|-?[\d.]+)/)
    if (dbMatch !== null && pendingTimeS !== null) {
      const bucket = Math.floor(pendingTimeS / windowS)
      const values = buckets.get(bucket) ?? []
      values.push(dbMatch[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(dbMatch[1]))
      buckets.set(bucket, values)
      pendingTimeS = null
    }
  }
  if (buckets.size === 0) {
    return null
  }
  const dbToLinear = (db: number): number => (Number.isFinite(db) ? 10 ** (db / 20) : 0)
  const levels: number[] = []
  for (const values of buckets.values()) {
    const meanLinear = values.reduce((total, db) => total + dbToLinear(db), 0) / values.length
    levels.push(meanLinear > 0 ? Math.max(-90, 20 * Math.log10(meanLinear)) : -90)
  }
  levels.sort((left, right) => left - right)
  return levels[Math.floor(levels.length / 2)] ?? null
}

export const probeMedianDb = async (input: string): Promise<number | null> => {
  const { stdout, stderr, exitCode } = await run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    input,
    '-af',
    'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f',
    'null',
    '-',
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `ffmpeg exited with ${exitCode}`)
  }
  return medianWindowDb(stdout, LEVEL_WINDOW_S)
}

/**
 * Silence measured on a file at the higher of two independently derived thresholds: #43's
 * floor-anchored one and this module's median-anchored one. See the header for why neither alone
 * is right on both a raw source and an assembled render.
 */
export const measureSilence = async (
  input: string,
  // #43's floor for this same file, when the caller already measured it. `commit` runs
  // `findSurvivingDeadAir` on this exact render moments earlier and that call already paid for a
  // full astats pass (measured: 950ms of this pass's 2067ms on a 375s render), so re-probing here
  // would buy an identical number twice. Undefined means measure it.
  knownFloor?: NoiseFloor | null,
): Promise<{
  spans: SilenceCandidate[]
  floorDb: number | null
  floorThresholdDb: number | null
  medianDb: number | null
  medianThresholdDb: number | null
  thresholdDb: number | null
}> => {
  const durationMs = await probeDurationMs(input)
  // Each probe answers independently, and a probe that cannot read this file costs its own
  // threshold rather than the whole measurement: with one of the two still answering there is a
  // derived threshold to work from, and with neither the caller gets `thresholdDb: null` and cuts
  // nothing. `probeNoiseFloor` already returns null for the too-short case; this catches the
  // refusing-input case for both, which is what a render ffmpeg will not decode looks like.
  const floor =
    knownFloor === undefined ? await probeNoiseFloor(input).catch(() => null) : knownFloor
  const medianDb = await probeMedianDb(input).catch(() => null)
  const medianThresholdDb = medianDb === null ? null : medianDb - SILENCE_BELOW_MEDIAN_DB
  // The floor-anchored threshold only means anything when the file HAS a quiet end: it assumes the
  // quietest window is quieter than ordinary speech, and derives a threshold by adding a fixed
  // margin to it. On a file whose level barely varies that assumption is false and the result is
  // pathological. Measured on a constant-amplitude sine (the shape of this suite's own fixtures):
  // floor and median are both about -21dB, so the floor-anchored threshold lands at -11dB and
  // marks the ENTIRE file as silence, while the median-anchored one correctly lands at -41dB.
  // Requiring the floor to sit at least SILENCE_BELOW_MEDIAN_DB under the median is exactly the
  // statement "there is a quiet end to anchor to", tested rather than assumed.
  const floorUsable =
    floor !== null && medianDb !== null && floor.floorDb <= medianDb - SILENCE_BELOW_MEDIAN_DB
  const floorThresholdDb = floor === null ? null : floor.thresholdDb
  const candidates = [floorUsable ? floorThresholdDb : null, medianThresholdDb].filter(
    (value): value is number => value !== null,
  )
  // The higher of the two surviving thresholds, for the reason the module header states: the
  // floor-anchored one is right on a source whose processed noise floor sits tens of dB above true
  // silence (#43's founding case), the median-anchored one is right on a render assembled with
  // digitally silent joins, and taking the higher means neither failure mode can hide the other.
  const thresholdDb = candidates.length === 0 ? null : Math.max(...candidates)
  if (thresholdDb === null) {
    return {
      spans: [],
      floorDb: floor?.floorDb ?? null,
      floorThresholdDb,
      medianDb,
      medianThresholdDb,
      thresholdDb: null,
    }
  }
  const { stderr, exitCode } = await run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    input,
    '-af',
    `silencedetect=noise=${thresholdDb.toFixed(2)}dB:d=${(MIN_PAUSE_MS / 1000).toFixed(3)}`,
    '-f',
    'null',
    '-',
  ])
  return {
    // A sweep that could not run reports no spans rather than throwing, the same stance the two
    // probes above take: this pass cuts, so every failure it meets has to end in fewer cuts.
    spans: exitCode === 0 ? parseSilenceLog(stderr, durationMs) : [],
    floorDb: floor?.floorDb ?? null,
    floorThresholdDb,
    medianDb,
    medianThresholdDb,
    thresholdDb,
  }
}

/**
 * Non-language sound, cut on the classifier's own span.
 *
 * #63 asks how the automatic path handles a span the classifier cannot classify, since `nonspeech`
 * needs `--verify` to attach a reading and `--verify` costs one whisper model load per span. The
 * answer here is that the automatic path never asks for the classification. It requires a second
 * INSTRUMENT to agree instead: a classifier span is cut only where the energy measurement also
 * reads that audio as silence. Two independent measurements of the same span, neither of them a
 * transcript, is a proof; the classifier's own label is not needed and `--verify`'s per-span
 * whisper load is not paid.
 *
 * The corroboration is doing real work rather than rubber-stamping. Measured on this render, the
 * classifier offers 40 spans, and 640ms hits mid-sentence ("dan clic", "tenemos", "Marcamos") sit
 * next to the six coughs the human named. Requiring an overlapping measured silence is what
 * separates them: a cough in a pause is audible non-language sound inside audio that reads as
 * silent at speech level, while a breath clipped onto a spoken syllable is not. A span with no
 * silence under it is exactly the ambiguous case `--verify` exists to discuss, so it is declined
 * and left to the model. The failure this avoids is the one #63 documents: the classifier returned
 * all six coughs, `--verify` read them, and nothing cut them.
 *
 * What gets cut is the INTERSECTION of the two measurements, not the classifier's whole span, and
 * that distinction was worth a real defect. The classifier draws generously: its span at 206.40s
 * runs 1.60s while the silence under it is 1.02s, and cutting the classifier's own bounds removed
 * audio measuring -32.6dB mean with peaks to -6.6dB, which is speech, not a cough. Every span that
 * survives here is therefore bounded by the energy measurement on both sides: the proof covers the
 * intersection only, so only the intersection is removed.
 */
export const nonspeechCuts = (
  spans: Span[],
  silences: SilenceCandidate[],
  thresholdDb: number,
): AutoCut[] => {
  const cuts: AutoCut[] = []
  for (const span of spans) {
    if (span.endMs - span.startMs < MIN_PAUSE_MS) {
      continue
    }
    const overlap = silences.find(
      (silence) => silence.endMs > span.startMs && silence.startMs < span.endMs,
    )
    if (overlap === undefined) {
      continue
    }
    const startMs = Math.max(span.startMs, overlap.startMs)
    const endMs = Math.min(span.endMs, overlap.endMs)
    if (endMs - startMs < MIN_PAUSE_MS) {
      continue
    }
    const durationS = ((span.endMs - span.startMs) / 1000).toFixed(2)
    const measurement = `classifier span ${(span.startMs / 1000).toFixed(2)}-${(span.endMs / 1000).toFixed(2)}s, ${durationS}s, intersected with ${(overlap.durationMs / 1000).toFixed(2)}s below ${thresholdDb.toFixed(2)}dB at ${(overlap.startMs / 1000).toFixed(2)}-${(overlap.endMs / 1000).toFixed(2)}s`
    cuts.push({
      startMs,
      endMs,
      kind: 'filler',
      instrument: 'nonspeech',
      measurement,
      reason: `nonspeech: ${measurement}`,
    })
  }
  return cuts
}

/**
 * Measured dead air, cut on the energy measurement alone.
 *
 * No word-level veto applies here, and that is a deliberate reversal of the obvious design. A
 * transcript cannot corroborate a silence: it is the instrument that disagrees with the audio
 * about where speech is, and `driftSuspectSpan` (build-edl.ts) exists precisely to flag "cues that
 * claim a word starts inside measured silence" as the transcript being wrong, not the audio.
 *
 * Measured on this render rather than argued: vetoing a silence whose cue spans overlap it rejects
 * 18 of 19; vetoing only where a word cue STARTS inside it still rejects 14 of 19, including all
 * three pauses the human named by ear. Those spans were then checked directly against the audio.
 * At 111.24-113.26s (where a cue claims "Prueba." begins at 111.77s) the span measures -67.7dB
 * mean / -39.6dB peak and `trx` re-transcribing that exact window returns no text at all; the same
 * holds at 266.67-268.15s (-63.2dB), 344.93-346.42s (-58.4dB) and 184.37-188.01s (-65.0dB). The
 * cues are drifted and the silence is real, so a word-level veto here would delete a true finding
 * on the strength of the weaker instrument.
 *
 * `silencedetect` at a threshold derived from this file's own level is the whole proof, which is
 * what makes this class deterministic in the first place. `snapToWords` still runs over the final
 * merged span so a cut never clips the onset of the word that follows it.
 */
export const silenceCuts = (spans: SilenceCandidate[], thresholdDb: number): AutoCut[] => {
  const cuts: AutoCut[] = []
  for (const span of spans) {
    if (span.durationMs < MIN_PAUSE_MS) {
      continue
    }
    const measurement = `${(span.durationMs / 1000).toFixed(2)}s below ${thresholdDb.toFixed(2)}dB at ${(span.startMs / 1000).toFixed(2)}-${(span.endMs / 1000).toFixed(2)}s`
    cuts.push({
      startMs: span.startMs,
      endMs: span.endMs,
      kind: 'filler',
      instrument: 'silence',
      measurement,
      reason: `silence: ${measurement}`,
    })
  }
  return cuts
}

const normaliseWord = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')

/**
 * Where a phrase's word runs actually sit in the measured timeline.
 *
 * The sweep reports a repeat as a phrase plus the WINDOW it was heard in, which is up to 16s wide
 * and says nothing about where inside it either occurrence falls. Cutting on the window would
 * remove sixteen seconds to delete a two-second stutter. So the phrase is relocated against the
 * word timings themselves (#61's rule: measured timings, never cue spans), by matching its
 * normalised word sequence inside the window's own words.
 */
export const locatePhrase = (
  phrase: string,
  words: Word[],
  windowStartMs: number,
  windowEndMs: number,
): Array<{ startMs: number; endMs: number }> => {
  const target = phrase.split(' ').map(normaliseWord).filter(Boolean)
  if (target.length === 0) {
    return []
  }
  const inWindow = words.filter((word) => word.endMs > windowStartMs && word.startMs < windowEndMs)
  const found: Array<{ startMs: number; endMs: number }> = []
  for (let index = 0; index + target.length <= inWindow.length; index += 1) {
    const matches = target.every(
      (token, offset) => normaliseWord(inWindow[index + offset]?.text ?? '') === token,
    )
    if (!matches) {
      continue
    }
    const first = inWindow[index]
    const last = inWindow[index + target.length - 1]
    if (first === undefined || last === undefined) {
      continue
    }
    found.push({ startMs: first.startMs, endMs: last.endMs })
    index += target.length - 1
  }
  return found
}

/**
 * The most words that can sit between two readings and still be provably one abandoned attempt.
 *
 * Zero: the two readings must be adjacent, with nothing spoken between them ("es esta, es esta
 * validacion"). See `continuesTheSame` for why this is stricter than the measured populations
 * would allow. Briefly: 0-1 words separate real retakes on this render and 8-14 separate real
 * reuse, so 2 looks safe, but the single one-word case in the material is reuse whose leftover word
 * is the first reading's object ("le damos clic a Create"), and no instrument here can tell that
 * from a retake's one-word fumble. A pass that cuts without asking takes the provable subset.
 */
const MAX_FUMBLE_WORDS = 0

/**
 * Whether the two readings are adjacent enough to be one retake: what separates it from reuse.
 *
 * This is the discriminator #63's legitimate-reuse requirement actually needs, and #57's
 * content-word floor alone does not supply it. Measured on this render, four findings clear the
 * floor and are still not retakes, because the speaker said the same opening twice and then
 * continued somewhere different: "le damos clic aquí a Open ChatGPT ... le damos clic a Plus" (two
 * different buttons in a tutorial, the exact class the issue names), "Te va a preguntar qué número
 * ... Te va a pedir permisos", "en el servidor y en la base de datos ... Y me hackeé en la base de
 * datos", "voy a seguir leyéndolos ... voy a seguir iterando". Cutting any of them deletes real
 * content, which is the failure mode an automatic pass has to be most afraid of.
 *
 * A retake is the opposite shape: the speaker abandons the line mid-way and starts it over, so the
 * second reading follows the first with at most a fumble in between. What separates the two is
 * therefore how much SPEECH sits between the readings, and on this render's own six candidates
 * that measure does not overlap at all: 0 and 1 word for the two retakes, 8 to 14 for the four
 * reuses (see `MAX_FUMBLE_WORDS`). Reuse is not two attempts at one line, it is one line said,
 * completed, and its opening reused later for a different point.
 *
 * Comparing the word that FOLLOWS each occurrence was the first attempt and it does not work: after
 * a retake's first occurrence sits the repeat's own opening word, always, so every retake reads as
 * divergence. Measured, it got 4 of these 6 right; counting the words between gets 6 of 6.
 *
 * `MAX_RETAKE_GAP_MS` already bounds the same question in TIME, and both bounds stay: time alone
 * cannot tell a fast reused phrase from a retake, and word count alone would accept two readings
 * separated by one very long word.
 *
 * Why the bound is 0 words and not the 2 the populations would allow. With one word permitted this
 * pass cut a real false positive on this very render: at 109.9s the speaker says "le damos clic a
 * Create. Le damos clic a Sign in", reuse separated by exactly one word, and removing it deletes
 * "Create" and a real step of the tutorial. That case is NOT separable from a true retake by any
 * instrument available here: `contentWordCount` scores "Create" 1 and scores the genuine retake's
 * own fumble ("probablemente") 1 too, so any test that rejects the first rejects the second. The
 * difference is that "Create" is the OBJECT of the first reading, which is a semantic judgement and
 * therefore the model's half of #63's own division of labour.
 *
 * So the deterministic half keeps only what it can prove: two readings with NOTHING between them,
 * where there is no leftover word to misjudge. That costs one true positive on this render (the
 * "poema" retake, whose fumble is a single word) and removes one content-destroying cut. For a pass
 * that cuts without asking, refusing an ambiguous case is the correct trade, and the refused case
 * is exactly the ambiguous remainder the model is supposed to receive.
 */
export const continuesTheSame = (
  words: Word[],
  first: { startMs: number; endMs: number },
  second: { startMs: number; endMs: number },
): boolean => {
  // What the first reading ran into, before the second reading begins. In a retake the speaker
  // abandons the line and starts it over, so at most a fumble sits here; in reuse the first
  // reading finished its own different sentence, and that sentence sits here.
  const between = words.filter(
    (word) => word.startMs >= first.endMs && word.startMs < second.startMs,
  )
  return between.length <= MAX_FUMBLE_WORDS
}

/**
 * The seam between an abandoned attempt and the retake that replaces it: the point the repetition
 * cut ends at (#73).
 *
 * The cut used to run from the first occurrence's first word to the SECOND occurrence's first
 * word, which removes occurrence 1 plus every word spoken between the two readings. That is wrong
 * whenever the speaker got further into the first attempt than the repeated phrase itself, because
 * what sits between the readings is not only the trailing-off: it is the continuation the surviving
 * sentence was going to complete. Measured while building a corroborated detection pipeline over
 * one master, **5 of 5 repetition cuts ate real words**, one of them removing "cual es la
 * diferencia" outright.
 *
 * The seam is the widest measured gap between two consecutive words in that stretch, which is the
 * micro-pause a speaker leaves when they stop one attempt and start another. Ending the cut there
 * removes the abandoned attempt and leaves everything after it standing, so the retake arrives with
 * the words it needs rather than with a hole in front of it.
 *
 * No threshold is introduced. The seam is chosen as the largest gap present rather than the first
 * gap over some minimum duration, so this asks "where is the break" rather than "is this break big
 * enough", and a stretch with no gap at all (two readings butting up against each other, the only
 * shape `MAX_FUMBLE_WORDS = 0` admits today) falls back to the retake's own start, which is where
 * the old span already ended and is correct when there is nothing in between to preserve.
 *
 * Verified by transcribing 4s around every junction in source and render after the change: 9
 * junctions identical, 6 differing only by ASR variance (`click`/`clic`, `aprobar`/`a probar`),
 * 0 words lost.
 */
export const seamBetween = (
  words: Word[],
  first: { startMs: number; endMs: number },
  second: { startMs: number; endMs: number },
): number => {
  // Everything spoken after the first reading and before the retake begins. With
  // MAX_FUMBLE_WORDS at 0 this is empty today, which is exactly why #73 is latent rather than
  // shipping: raising the sensitivity is what exposes the geometry.
  const between = words
    .filter((word) => word.startMs >= first.endMs && word.startMs < second.startMs)
    .sort((left, right) => left.startMs - right.startMs)
  if (between.length === 0) {
    return second.startMs
  }
  // Walk the boundaries from the end of the abandoned attempt through to the retake, and take the
  // widest one. The candidates include the gap before the first intervening word and the gap after
  // the last, so a speaker who pauses immediately after abandoning is handled the same way as one
  // who trails off through a word or two first.
  let seamMs = second.startMs
  let widestMs = -1
  let previousEndMs = first.endMs
  for (const word of between) {
    const gapMs = word.startMs - previousEndMs
    if (gapMs > widestMs) {
      widestMs = gapMs
      seamMs = word.startMs
    }
    previousEndMs = Math.max(previousEndMs, word.endMs)
  }
  const trailingGapMs = second.startMs - previousEndMs
  if (trailingGapMs > widestMs) {
    seamMs = second.startMs
  }
  return seamMs
}

/**
 * Exact repeated runs, cutting the EARLIER occurrence and keeping the LATER one.
 *
 * See the header for why that direction and not the other: the second attempt is the speaker's
 * completed one, and reversing this deletes the landing and keeps the fumble. The removed span runs
 * from the first occurrence's first word to the SEAM between the abandoned attempt and the retake
 * (#73, see `seamBetween`), not to the second occurrence's own start: ending it there removes the
 * words the speaker said in the failed attempt that belong to the sentence that survives.
 *
 * Only `repeatedPhrases` is read. `discountedRepeats` is #57's content-word floor already having
 * decided a finding is connective tissue, and legitimate reuse spread across a render is excluded
 * by `MAX_RETAKE_GAP_MS` rather than by judgement.
 *
 * Each finding brings its OWN word timings, re-measured over its window, rather than sharing the
 * session's cached whole-file transcript. This is not an optimisation, it is the only thing that
 * works: the cached transcript is the pass that averaged the repeat away in the first place, which
 * is the entire premise of #44 and `verify --windows`. Measured on this render, the sweep hears
 * "Y ahí pueden ver como ya me envió el haiku. Y ahí pueden ver el..." at 192s while the cached
 * cues over the same span read "el haiku. Y haiku." — the second reading is simply not in them, so
 * locating either occurrence against the cache finds zero of the two and cuts nothing. Only 1 of
 * this render's 9 sweep findings could be located against the cache; re-measuring the window with
 * `transcribeWindowWords` (which exists for exactly this arbitration, per its own header) is what
 * turns a heard repeat into a cuttable span.
 */
export const repetitionCuts = (
  findings: Array<RepeatedPhrase & { words: Word[] }>,
  lang?: string,
): AutoCut[] => {
  const stopwords = stopwordsFor(lang)
  const cuts: AutoCut[] = []
  for (const finding of findings) {
    // #57's floor, re-applied here rather than trusted from upstream. `verify` routes a finding
    // under it to `discountedRepeats`, but `mergeRepeats` also folds in `findStackedOpeners`,
    // which is a structural check with no content-word test of its own: measured on this render
    // that is how "te va" (0 content words) reached `repeatedPhrases`. An auto-cut path cannot
    // inherit a floor that one of its inputs bypasses.
    if (contentWordCount(finding.phrase, stopwords) < MIN_CONTENT_WORDS) {
      continue
    }
    const occurrences = locatePhrase(
      finding.phrase,
      finding.words,
      finding.windowStartMs,
      finding.windowEndMs,
    )
    if (occurrences.length < 2) {
      continue
    }
    const first = occurrences[0]
    const second = occurrences[1]
    if (first === undefined || second === undefined) {
      continue
    }
    const gapMs = second.startMs - first.endMs
    if (gapMs < 0 || gapMs > MAX_RETAKE_GAP_MS) {
      continue
    }
    if (!continuesTheSame(finding.words, first, second)) {
      continue
    }
    // #73: the seam, not the retake's start. Everything after the abandoned attempt survives.
    const seamMs = seamBetween(finding.words, first, second)
    const measurement = `"${finding.phrase}" x${finding.count}, first reading ${(first.startMs / 1000).toFixed(2)}-${(first.endMs / 1000).toFixed(2)}s, second at ${(second.startMs / 1000).toFixed(2)}s, ${(gapMs / 1000).toFixed(2)}s apart; earlier removed to the seam at ${(seamMs / 1000).toFixed(2)}s, later kept`
    cuts.push({
      startMs: first.startMs,
      endMs: seamMs,
      kind: 'repetition',
      instrument: 'repetition',
      measurement,
      reason: `repetition: ${measurement}`,
    })
  }
  return cuts
}

/**
 * Speech stranded between two cuts, too short to carry a line.
 *
 * Once the three classes above land, some of what survives between them is a fragment the build
 * would have had to keep as a segment of its own: `absorbSlivers` already merges cuts across such
 * a remainder at build time, and this reports the same shape as its own cut so the round's record
 * names it rather than leaving it as an unexplained widening. See MIN_FRAGMENT_MS for the
 * threshold's derivation, which is `invertToSegments`' own `minKeepMs` rather than a new number.
 */
export const fragmentCuts = (cuts: AutoCut[], words: Word[]): AutoCut[] => {
  const ordered = [...cuts].sort((left, right) => left.startMs - right.startMs)
  const found: AutoCut[] = []
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]
    const current = ordered[index]
    if (previous === undefined || current === undefined) {
      continue
    }
    const gapMs = current.startMs - previous.endMs
    if (gapMs <= 0 || gapMs >= MIN_FRAGMENT_MS) {
      continue
    }
    const stranded = words.filter(
      (word) => word.endMs > previous.endMs && word.startMs < current.startMs,
    )
    const measurement = `${gapMs}ms of speech stranded between two cuts, under the ${MIN_FRAGMENT_MS}ms invertToSegments already treats as the shortest keepable line${stranded.length === 0 ? '' : ` (${stranded.length} word cue${stranded.length === 1 ? '' : 's'})`}`
    found.push({
      startMs: previous.endMs,
      endMs: current.startMs,
      kind: 'filler',
      instrument: 'fragment',
      measurement,
      reason: `fragment: ${measurement}`,
    })
  }
  return found
}

/**
 * Each repeat finding with word timings re-measured over its own window.
 *
 * Sequential, matching every other per-span trx caller in this codebase (`nonspeech --verify`,
 * `converge`, `joins`): each call loads a whisper model into a fresh process, and this runs once
 * per repeat finding rather than once per window. On the render that opened #63 that is 9 calls
 * against the sweep's own 46, so the deterministic pass costs a fraction of the sweep `commit`
 * already runs unconditionally. A window trx cannot read is skipped rather than failing the pass:
 * the finding stays with the model, which is where an unlocatable repeat belongs anyway.
 *
 * Two filters run before any transcription, both of them tests this pass would apply afterwards
 * anyway. Findings under the content-word floor can never become cuts, and findings sharing one
 * window are one clip: `--stride` half a window means the same audio is reported by two
 * differently-aligned windows by construction, so transcribing per finding rather than per
 * distinct window pays repeatedly for identical audio. Neither filter changes which cuts come out.
 */
export const measureRepeatWindows = async (
  renderPath: string,
  findings: RepeatedPhrase[],
  lang: string | undefined,
): Promise<Array<RepeatedPhrase & { words: Word[] }>> => {
  const stopwords = stopwordsFor(lang)
  const measured: Array<RepeatedPhrase & { words: Word[] }> = []
  const byWindow = new Map<string, Word[]>()
  for (const finding of findings) {
    // The content-word floor is applied BEFORE the transcription, not only inside
    // `repetitionCuts`. A finding under it can never become a cut, so paying a whisper load to
    // locate it precisely buys nothing, and the sweep's own findings are dominated by exactly
    // this class. Same test, one step earlier, purely so the pass does not transcribe what it has
    // already decided not to act on.
    if (contentWordCount(finding.phrase, stopwords) < MIN_CONTENT_WORDS) {
      measured.push({ ...finding, words: [] })
      continue
    }
    const key = `${finding.windowStartMs}:${finding.windowEndMs}`
    const cached = byWindow.get(key)
    if (cached !== undefined) {
      measured.push({ ...finding, words: cached })
      continue
    }
    let words: Word[] = []
    try {
      const heard = await transcribeWindowWords(
        renderPath,
        finding.windowStartMs,
        finding.windowEndMs,
        lang,
        'vcut-autocut',
      )
      words = heard.words
    } catch {
      words = []
    }
    byWindow.set(key, words)
    measured.push({ ...finding, words })
  }
  return measured
}

/** Overlapping cuts fused, keeping the evidence of every instrument that fired on the span. */
export const mergeAutoCuts = (cuts: AutoCut[]): AutoCut[] => {
  const sorted = [...cuts].sort((left, right) => left.startMs - right.startMs)
  const merged: AutoCut[] = []
  for (const cut of sorted) {
    const last = merged.at(-1)
    if (last !== undefined && cut.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, cut.endMs)
      if (last.instrument !== cut.instrument || last.measurement !== cut.measurement) {
        last.measurement = `${last.measurement}; ${cut.measurement}`
        last.reason = `${last.reason}; ${cut.reason}`
      }
      continue
    }
    merged.push({ ...cut })
  }
  return merged
}

/**
 * The whole deterministic pass over one render, given what the instruments already produced.
 *
 * Pure apart from the silence measurement it is handed: `commit` runs the classifier and the sweep
 * for its own reporting anyway, so this consumes their output rather than running them a second
 * time. Every emitted span is word-snapped last, after merging, so the fused span is the one that
 * gets checked against word boundaries rather than each contributor separately.
 */
export const planAutoCuts = (input: {
  nonspeechSpans: Span[]
  silence: {
    spans: SilenceCandidate[]
    floorDb: number | null
    floorThresholdDb: number | null
    medianDb: number | null
    medianThresholdDb: number | null
    thresholdDb: number | null
  }
  repeats: Array<RepeatedPhrase & { words: Word[] }>
  words: Word[]
  durationMs: number
  lang?: string
}): AutoCutReport => {
  const { nonspeechSpans, silence, repeats, words, durationMs, lang } = input
  const fromNonspeech =
    silence.thresholdDb === null
      ? []
      : nonspeechCuts(nonspeechSpans, silence.spans, silence.thresholdDb)
  const fromSilence =
    silence.thresholdDb === null ? [] : silenceCuts(silence.spans, silence.thresholdDb)
  const fromRepetition = repetitionCuts(repeats, lang)
  const beforeFragments = mergeAutoCuts([...fromNonspeech, ...fromSilence, ...fromRepetition])
  const fromFragments = fragmentCuts(beforeFragments, words)
  const merged = mergeAutoCuts([...beforeFragments, ...fromFragments])
  const proposed = merged
    .map((cut) => {
      const snapped = snapToWords({ startMs: cut.startMs, endMs: cut.endMs }, words, silence.spans)
      return { ...cut, startMs: snapped.startMs, endMs: snapped.endMs }
    })
    .filter((cut) => cut.endMs > cut.startMs)

  // The standing-down bound (see MAX_AUTO_REMOVAL_FRACTION). All or nothing rather than trimming
  // to fit: dropping cuts until the total fits would keep cutting on the same measurement that
  // just failed its own sanity check, and picking WHICH ones to keep would be exactly the
  // judgement call this pass exists to avoid making.
  const proposedMs = proposed.reduce((total, cut) => total + (cut.endMs - cut.startMs), 0)
  const overBudget = durationMs > 0 && proposedMs > durationMs * MAX_AUTO_REMOVAL_FRACTION
  const cuts = overBudget ? [] : proposed

  const counted = (instrument: AutoCut['instrument'], offered: number) => ({
    offered,
    cut: cuts.filter((cut) => cut.reason.includes(`${instrument}:`)).length,
  })

  return {
    version: 1,
    cuts,
    // Present only when the bound actually fired, same present-and-true-only convention
    // `driftSuspect` and `literal` already follow. A reader seeing this knows the pass measured
    // something it did not act on, which is a very different state from measuring nothing.
    ...(overBudget
      ? {
          stoodDown: {
            proposedCuts: proposed.length,
            proposedMs,
            durationMs,
            reason: `${(proposedMs / 1000).toFixed(1)}s of ${(durationMs / 1000).toFixed(1)}s (${((proposedMs / durationMs) * 100).toFixed(0)}%) exceeded the ${(MAX_AUTO_REMOVAL_FRACTION * 100).toFixed(0)}% an automatic pass may remove on its own; cut nothing and left the whole decision to the round`,
          } as const,
        }
      : {}),
    silence: {
      floorDb: silence.floorDb,
      floorThresholdDb: silence.floorThresholdDb,
      medianDb: silence.medianDb,
      medianThresholdDb: silence.medianThresholdDb,
      thresholdDb: silence.thresholdDb,
      minPauseMs: MIN_PAUSE_MS,
    },
    considered: {
      nonspeech: counted('nonspeech', nonspeechSpans.length),
      silence: counted('silence', silence.spans.length),
      repetition: counted('repetition', repeats.length),
      fragment: counted('fragment', fromFragments.length),
    },
  }
}

/**
 * The deterministic pass over a render, running the measurements it needs itself.
 *
 * The classifier is optional the same way `nonspeech` already treats it (absent is a supported
 * state that reports itself rather than failing), and trx being absent costs only the repetition
 * class, matching `sweepForRound`'s own stance that a missing transcriber reports "did not run"
 * rather than failing the commit. Both degrade to fewer cuts, never to a wrong one.
 *
 * A render this cannot measure at all (no such file, no audio stream, ffprobe refusing it) returns
 * `null` for the same reason, and this is the sharper case: a pass that CUTS has a strictly higher
 * duty than one that reports, so it either has its evidence or it does nothing. Failing the commit
 * would make a check that is additive to an already-working pipeline able to break it, which is the
 * one outcome an unconditional placement must not have.
 *
 * Master-time throughout: every input is measured on the render itself, so `commit` translates the
 * resulting spans into source time before they become proposals.
 */
export const runAutoCut = async (input: {
  renderPath: string
  classifierSpans: Span[]
  repeats: RepeatedPhrase[]
  words: Word[]
  lang: string | undefined
  knownFloor?: NoiseFloor | null
}): Promise<AutoCutReport | null> => {
  let silence: Awaited<ReturnType<typeof measureSilence>>
  let durationMs: number
  try {
    durationMs = await probeDurationMs(input.renderPath)
    silence = await measureSilence(input.renderPath, input.knownFloor)
  } catch {
    return null
  }
  const repeats = await measureRepeatWindows(input.renderPath, input.repeats, input.lang)
  return planAutoCuts({
    nonspeechSpans: input.classifierSpans,
    silence,
    repeats,
    words: input.words,
    durationMs,
    lang: input.lang,
  })
}
