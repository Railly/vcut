/**
 * The listener-grade window sweep: what a whole-file transcript cannot see because it is
 * exactly the pass that hides it.
 *
 * `rounds-methodology.md`'s own working-a-round section already names the reason: "A
 * whole-file transcript averages. Re-transcribe the passage." A model reading ninety seconds
 * collapses three attempts at the same line into one, because one line is the likelier
 * sentence; the same audio cut to twelve seconds returns all three. Every instrument in this
 * codebase that answers a disagreement question (`converge`, `say --transcribe`, `peek`,
 * `joins`, `nonspeech --verify`) already re-transcribes a short window for that reason. What
 * none of them did until now is run that sweep unconditionally, end to end, across a whole
 * render, and merge the result into one report. An agent found this the hard way, running the
 * method by hand: ~140 raw tool calls, serially, one window at a time, per round.
 *
 * `--windows` turns the hand loop into one call. It tiles the media in `--window`-sized spans
 * every `--stride` ms, transcribes every tile, and reports what a short window can see that a
 * long one cannot: a phrase one tile's own text repeats (a duplicated sentence: "reciben un
 * poema mio, reciben un poema mio"), two consecutive sentences opening on the same short phrase
 * (a stacked filler: "Y bueno, eso es todo. Y bueno, ya para cerrar"), and a tile whose own text
 * runs right up against its edge without landing (a truncated fragment, "the word whose span
 * extends past its segment's cut point").
 *
 * Concurrency, unlike every other trx caller in this codebase, runs windows in parallel rather
 * than sequentially. Every other command (`nonspeech --verify`, `converge`, `joins`, `say
 * --positions --transcribe`, `compare`'s reference chunks) is sequential because a live editing
 * session shares one machine with an already-heavy video editor, and each `trx` call loads a
 * whisper model into a fresh process. This command's own windows genuinely share no state: a
 * short ffmpeg extract followed by one `trx transcribe` call touches nothing any other window
 * touches. So nothing about correctness forces them apart, and the entire reason to build this
 * verb instead of documenting the hand loop is that a sweep of good length takes minutes
 * serially and seconds in parallel. Measured on this machine (2026-08-12, `ps aux` against a
 * live `whisper-cli` process, large-v3-turbo): each concurrent transcription process holds
 * roughly 1.8GB resident, independent of window length (a 25s window and a 358s file both
 * loaded ~1.8GB: the cost is the model, not the audio). `--concurrency` is a real flag rather
 * than an invented constant so a caller can raise or lower it against its own machine; its
 * default is `min(4, cpus)`, chosen so the worst case (4 x 1.8GB is under 8GB) leaves headroom
 * on any machine that can run a video editor at all, not tuned to this one's 24GB.
 *
 * vcut still calls no model of its own: every call here shells out to `trx`, already on the
 * caller's PATH, the same way every measurement in this codebase runs ffmpeg.
 *
 * #57: a fixed 3-word probe over a repeated sentence produces one finding per overlapping probe
 * rather than one finding per repeat (measured: 26 findings on a real render, three of them for
 * one phrase, "en la base de datos", said twice), because "en la base de datos" said twice reads
 * as three separate findings ("en la base", "la base de", "base de datos") and a 7-word sentence
 * repeated whole reads as five. `findRepeatedPhrases` grows each matched probe to the full span
 * both occurrences share and collapses overlapping grown spans, the same shape semantic.ts's own
 * repeatedPhrases already solved for a whole-file transcript; the stopword floor it measured
 * there (MIN_CONTENT_WORDS, `stopwordsFor`) is reused rather than reinvented, and a finding that
 * falls under it is reported through `discountedRepeats` rather than silently dropped. When
 * `--transcript` is given, each repeated-phrase finding is also marked `corroborated` against the
 * cached whole-file SRT, the same disagreement `findAnomalies` already surfaces for its own list;
 * an uncorroborated finding is a place to look, not a reason to drop it, since the cache is
 * exactly the whole-file pass that averages a repeat away in the first place.
 */

import { existsSync, readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { resolve } from 'node:path'

import { parseSrt, probeDurationMs } from './detect.ts'
import { emitJson, heading, line, type Mode, nextStep, resolveMode, UsageError } from './output.ts'
import { contentWordCount, foldDiacritics, MIN_CONTENT_WORDS, stopwordsFor } from './semantic.ts'
import { transcribeWindow } from './transcribe-window.ts'

const HELP = `vcut verify --windows - the listener-grade window sweep over a render

Usage:
  vcut verify --windows <media> [flags]

Flags:
  --window <sec>       Width of each window (default 16, the width the hand method used)
  --stride <sec>       How far each window steps (default: half of --window, so every span
                        is covered by at least two differently-aligned windows; a repeat
                        straddling one window's boundary lands whole inside another)
  --lang <code>        Language passed to the transcriber
  --transcript <path>  A cached whole-file SRT to diff windows against (optional)
  --concurrency <n>    How many windows to transcribe at once (default min(4, cpus))
  --json / --human     Output mode
  --help                Show this message

Extracts every window with ffmpeg and transcribes it with trx, in parallel (short extracts
share no state, unlike every other trx caller in this codebase, which stays sequential because
each call loads a whisper model). Reports repeated phrases, truncated edges, and anomalies
against the cached transcript when --transcript is given.

A repeated phrase below the content-word floor (connective tissue like "es que" or "va a") is
reported through discountedRepeats instead of repeatedPhrases, never silently dropped. With
--transcript, each repeated phrase is also marked corroborated against the cached transcript:
false means the cache disagrees, a place to look rather than a verdict.

A whole-file transcript averages: a model reading ninety seconds collapses three attempts at a
line into one, because one is the likelier sentence. The same audio cut to sixteen seconds
returns what was actually said. This is the instrument that reads the short way every round.

Also accepts --fields/--jq. See vcut --help for the full picture.`

export type Window = {
  startMs: number
  endMs: number
  text: string
}

export type RepeatedPhrase = {
  phrase: string
  count: number
  windowStartMs: number
  windowEndMs: number
  // Undefined when no --transcript was given: there was nothing to corroborate against. true/false
  // only after corroborateRepeats' own cached-transcript comparison actually ran over this
  // finding's span. A disagreement is a place to look, not a verdict, the same stance
  // findAnomalies already takes on its own: this is never used to drop a finding, only to mark it.
  corroborated?: boolean
}

// The same shape semantic.ts's own DiscountedRepeat reports for the identical question (a
// repeated run too thin on content words to be a candidate retake): kept rather than dropped, so
// a caller can see what was filtered and why, the precedent this reuses rather than reimplements.
export type DiscountedRepeat = {
  phrase: string
  count: number
  windowStartMs: number
  windowEndMs: number
  reason: string
}

export type TruncatedEdge = {
  windowStartMs: number
  windowEndMs: number
  edge: 'start' | 'end'
  word: string
}

export type TranscriptAnomaly = {
  windowStartMs: number
  windowEndMs: number
  windowText: string
  cachedText: string
}

export type VerifyWindowsReport = {
  version: 1
  input: string
  durationMs: number
  windowMs: number
  strideMs: number
  windows: Window[]
  repeatedPhrases: RepeatedPhrase[]
  discountedRepeats: DiscountedRepeat[]
  truncatedEdges: TruncatedEdge[]
  anomalies: TranscriptAnomaly[]
}

const DEFAULT_WINDOW_S = 16
// Same reasoning nonspeech.ts states for its own concurrency choice, made explicit rather than
// left to a runtime read of free memory: a stable default is a reproducible one, and reading
// os.freemem() at call time would make the same command pick a different concurrency, and
// possibly a different result if a race ever crept in, on the same machine a minute apart.
const MAX_CONCURRENCY = 4

/**
 * Non-overlapping (or overlapping, if --stride < --window) tiles covering the whole duration.
 * The last tile is clamped to durationMs rather than dropped or padded past the end, so the
 * final seconds of a render are never silently unswept.
 */
export const buildWindows = (
  durationMs: number,
  windowMs: number,
  strideMs: number,
): Interval[] => {
  if (durationMs <= 0 || windowMs <= 0 || strideMs <= 0) {
    return []
  }
  const windows: Interval[] = []
  for (let startMs = 0; startMs < durationMs; startMs += strideMs) {
    const endMs = Math.min(durationMs, startMs + windowMs)
    windows.push({ startMs, endMs })
    if (endMs >= durationMs) {
      break
    }
  }
  return windows
}

export type Interval = { startMs: number; endMs: number }

/** Punctuation and case are delivery, not words: matching through them finds real repeats. */
const normalise = (text: string): string =>
  foldDiacritics(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

// Same run length semantic.ts's own repeatedPhrases uses for the identical question (a phrase
// repeated more than once in transcribed text): short enough to catch "reciben un poema mio"
// duplicated with only three carrying words, long enough that ordinary connective overlap
// between adjacent windows ("y bueno", "es que") does not read as a finding.
const RUN_LENGTH = 3

/**
 * Every pair of equal-length word runs that matches, grown to the longest span both occurrences
 * actually share.
 *
 * A sentence repeated whole ("pues este es un producto para personas") produces five overlapping
 * RUN_LENGTH-word matches at once ("pues este es", "este es un", "es un producto", "un producto
 * para", "producto para personas"): five 3-word windows sliding over one 7-word repeat, not five
 * different repeats. Reporting each fixed-width run as its own finding is what inflated one real
 * render's count to 26 (#57). Growing each matched pair left and right while the words on both
 * sides keep agreeing recovers the sentence the fixed width was only ever a probe into, and
 * collapsing overlapping grown spans in `mergeAdjacentSpans` turns the five probes back into the
 * one repeat they were always describing.
 */
const growMatch = (
  words: string[],
  left: number,
  right: number,
): { start: number; end: number } => {
  let start = left
  let matchStart = right
  while (start > 0 && matchStart > 0 && words[start - 1] === words[matchStart - 1]) {
    start -= 1
    matchStart -= 1
  }
  let end = left + RUN_LENGTH
  let matchEnd = right + RUN_LENGTH
  while (end < matchStart && matchEnd < words.length && words[end] === words[matchEnd]) {
    end += 1
    matchEnd += 1
  }
  return { start, end }
}

type MatchSpan = { start: number; end: number }

/**
 * Grown spans that overlap (share any word index) describe the same underlying repeat, seen
 * through differently-aligned RUN_LENGTH probes: kept once, at the widest bounds any of them
 * reached. Two grown spans that do not overlap are two different repeated phrases in the same
 * window and stay separate.
 */
const mergeAdjacentSpans = (spans: MatchSpan[]): MatchSpan[] => {
  const sorted = [...spans].sort((left, right) => left.start - right.start)
  const merged: MatchSpan[] = []
  for (const span of sorted) {
    const last = merged.at(-1)
    if (last !== undefined && span.start < last.end) {
      last.end = Math.max(last.end, span.end)
      continue
    }
    merged.push({ ...span })
  }
  return merged
}

/**
 * How many times `phraseWords` recurs in `words`, counted fresh over the phrase's own width
 * rather than carried over from the narrower RUN_LENGTH probes that found it (those probes
 * overlap each other by construction, so summing their own occurrence counts double-counts one
 * repeat of a phrase longer than RUN_LENGTH). Non-overlapping: a match consumes its own words
 * before the scan continues past them, so a phrase that happens to repeat with no gap between
 * occurrences ("vamos vamos vamos") is not counted as more occurrences than actually fit.
 */
const countNonOverlapping = (words: string[], phraseWords: string[]): number => {
  if (phraseWords.length === 0) {
    return 0
  }
  let count = 0
  let index = 0
  while (index + phraseWords.length <= words.length) {
    const matches = phraseWords.every((word, offset) => words[index + offset] === word)
    if (matches) {
      count += 1
      index += phraseWords.length
    } else {
      index += 1
    }
  }
  return count
}

/**
 * Repeats found by scanning each window's own text for a run of words the window says more than
 * once. Unlike semantic.ts's repeatedPhrases (which scans a transcript already split into
 * sentence-shaped lines and reports a phrase recurring ACROSS lines), this scans one window's
 * raw text and reports a phrase recurring WITHIN it, the direct catch for a duplicated sentence
 * a whole-file pass smooths into a single clean line: a whole-file transcript averages three
 * attempts at a line into the likeliest single reading, and only a short window is narrow enough
 * to return the repeat intact rather than resolved away. "si reciben un poema mio, reciben un
 * poema mio por WhatsApp" is exactly this shape: one window, one run of words, said twice.
 *
 * Deliberately not cross-window: two adjacent windows built with `--stride < --window`
 * legitimately share audio, and a phrase said once but covered by two overlapping windows would
 * otherwise report as a false repeat with no way to tell it from a real one.
 *
 * Below MIN_CONTENT_WORDS content words (the same floor and stopword sets semantic.ts's own
 * repeatedPhrases already measured for the identical question), a repeated span is connective
 * tissue rather than a candidate retake and is reported through `discounted` instead of silently
 * dropped, the same precedent semantic.ts's own DiscountedRepeat sets.
 */
export const findRepeatedPhrases = (
  windows: Window[],
  lang?: string,
): { repeated: RepeatedPhrase[]; discounted: DiscountedRepeat[] } => {
  const stopwords = stopwordsFor(lang)
  const repeated: RepeatedPhrase[] = []
  const discounted: DiscountedRepeat[] = []
  for (const window of windows) {
    const words = normalise(window.text).split(' ').filter(Boolean)
    const positions = new Map<string, number[]>()
    for (let start = 0; start + RUN_LENGTH <= words.length; start += 1) {
      const run = words.slice(start, start + RUN_LENGTH).join(' ')
      const where = positions.get(run) ?? []
      where.push(start)
      positions.set(run, where)
    }

    const spans: MatchSpan[] = []
    for (const where of positions.values()) {
      if (where.length < 2) {
        continue
      }
      for (let i = 0; i < where.length - 1; i += 1) {
        const left = where[i]
        const right = where[i + 1]
        if (left === undefined || right === undefined) {
          continue
        }
        spans.push(growMatch(words, left, right))
      }
    }

    for (const span of mergeAdjacentSpans(spans)) {
      const phraseWords = words.slice(span.start, span.end)
      const phrase = phraseWords.join(' ')
      const contentWords = contentWordCount(phrase, stopwords)
      // How many times the merged, full-length phrase itself recurs in the window, counted fresh
      // over the phrase's own width rather than carried over from the narrower RUN_LENGTH probes
      // that found it: those probes overlap each other, so summing their occurrence counts would
      // count one repeat of a long phrase multiple times.
      const count = countNonOverlapping(words, phraseWords)
      if (contentWords < MIN_CONTENT_WORDS) {
        discounted.push({
          phrase,
          count,
          windowStartMs: window.startMs,
          windowEndMs: window.endMs,
          reason: `${contentWords} content word${contentWords === 1 ? '' : 's'}, below the ${MIN_CONTENT_WORDS} needed to read as a candidate retake rather than connective tissue`,
        })
        continue
      }
      repeated.push({
        phrase,
        count,
        windowStartMs: window.startMs,
        windowEndMs: window.endMs,
      })
    }
  }
  return {
    repeated: repeated.sort((left, right) => left.windowStartMs - right.windowStartMs),
    discounted: discounted.sort((left, right) => left.windowStartMs - right.windowStartMs),
  }
}

// Two words, not RUN_LENGTH's three: a stacked filler is a short discourse marker ("Y bueno",
// "so anyway"), and requiring three words would miss it entirely while still reading like a
// stricter rule. Two consecutive sentences opening on the identical two words is specific enough
// that it does not need a curated filler lexicon (metaSpeech's own, a different problem) to stay
// language-agnostic: "Esto es todo" followed unrelated sentences later by "Esto es todo" again
// is not this shape, because OPENERS compares only sentences that are adjacent.
const OPENER_LENGTH = 2

/**
 * The restart defect (#72): a speaker who backs up mid-clause and starts the phrase over with a
 * different destination. "abrimos la guia para vincular, abrimos la opcion para vincular" at ~91.5s
 * of one recording is the shape exactly, and six of that material's annotated defects share it.
 *
 * It is invisible to every RUN_LENGTH scan in this codebase, and not because the width is wrong.
 * Normalised, the only runs occurring twice there are the BIGRAMS `abrimos la` and `para vincular`;
 * no trigram repeats at all, so `findRepeatedPhrases` returns zero findings on the real text.
 *
 * Why this is a separate structural check and not `RUN_LENGTH = 2`. Dropping the width wholesale
 * takes false positives from 8 to 64, nearly all of them connectives, and the content-word floor
 * that rescues the 3-word scan cannot rescue this one. Measured on the issue's OWN named strings:
 * the real restart prefixes score 0, 1, 1, 1, 1, 2, 2 content words (`es muy` 0, `abrimos la` 1,
 * `para vincular` 1, `la ia` 1, `para simplemente` 1, `ia tendria` 2, `voy a iterar` 2) and the
 * false positives it names score 0, 1, 1 (`para que` 0, `voy a` 1, `de normal` 1). The two
 * distributions overlap completely, so no floor on a 2-word run separates them. Scoring the grown
 * span or the shared prefix plus both destinations was measured too and does not separate them
 * either: `voy a mostrar / cerrar` scores 3, higher than two of the real restarts.
 *
 * So this takes the same escape `findStackedOpeners` already took for the identical problem (a
 * 2-word unit that is noise anywhere, made safe by structure rather than by a lexicon): not "these
 * two words recur somewhere", but "the speaker said them, went somewhere, and said them again
 * before getting as far as they had gone the first time". Three requirements, all structural:
 *
 * 1. The shared prefix repeats and then DIVERGES. `growMatch` already computes that divergence
 *    index as its own loop exit condition and discards it; for this class that index is the answer.
 *    Two attempts that never diverge are one phrase said twice, which `findRepeatedPhrases` owns.
 * 2. The abandoned attempt is shorter than the prefix the two attempts share. This is the
 *    "backed up" part and it is what excludes reuse: a speaker who completes a clause and reuses
 *    its opening later leaves the whole completed clause in between. No constant is picked here,
 *    the bound is the repeat's own width, the same self-referential shape `MAX_RETAKE_GAP_MS`
 *    derives from the sweep's own window rather than inventing a number.
 * 3. The prefix carries at least one content word, so a pair of bare connectives repeating
 *    ("para que ... para que") is not a restart on structure alone.
 *
 * Measured against the issue's own cases: fires on "la ia tendria / la ia tendria acceso" and
 * "para simplemente cifrar / para simplemente detectar", stays silent on all three false positives
 * it names (`para que`, `voy a`, `de normal`) and on the `le damos clic a Create / a Sign in`
 * reuse `auto-cut.ts` explicitly forbids cutting. It does NOT fire on "abrimos la guia para
 * vincular / abrimos la opcion para vincular", whose abandoned attempt (3 words) runs longer than
 * its shared prefix (2 words); catching that one needs a bound this evidence cannot justify, and
 * the honest boundary is stated here rather than fitted. See the changelog entry for #72.
 */
const RESTART_PROBE_LENGTH = 2

/**
 * The stacked-filler defect: two consecutive sentences inside one window that open on the exact
 * same short run of words. "Y bueno, eso es todo. Y bueno, ya para cerrar" is this shape
 * precisely: findRepeatedPhrases' 3-word run does not fire here (the run diverges at the third
 * word, "eso" against "ya"), and lowering RUN_LENGTH to catch it would also catch every ordinary
 * two-word connective repeated anywhere in a window's prose, most of which is not a defect. This
 * stays structural instead: not "these two words recur somewhere", but "the speaker opened two
 * sentences in a row with them", which is what a stacked filler actually is.
 */
export const findStackedOpeners = (windows: Window[]): RepeatedPhrase[] => {
  const result: RepeatedPhrase[] = []
  for (const window of windows) {
    const sentences = window.text
      .split(/[.!?]+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0)
    for (let index = 1; index < sentences.length; index += 1) {
      const previousWords = normalise(sentences[index - 1] ?? '')
        .split(' ')
        .filter(Boolean)
      const currentWords = normalise(sentences[index] ?? '')
        .split(' ')
        .filter(Boolean)
      if (previousWords.length < OPENER_LENGTH || currentWords.length < OPENER_LENGTH) {
        continue
      }
      const previousOpener = previousWords.slice(0, OPENER_LENGTH).join(' ')
      const currentOpener = currentWords.slice(0, OPENER_LENGTH).join(' ')
      if (previousOpener === currentOpener) {
        result.push({
          phrase: currentOpener,
          count: 2,
          windowStartMs: window.startMs,
          windowEndMs: window.endMs,
        })
      }
    }
  }
  return result.sort((left, right) => left.windowStartMs - right.windowStartMs)
}

/**
 * Restarts found by scanning each window's own text (#72). See RESTART_PROBE_LENGTH for the
 * measurement that decided the three requirements and for what this deliberately does not catch.
 *
 * Reported as a `RepeatedPhrase` carrying the shared prefix, so it merges through `mergeRepeats`
 * with the other two detectors and reaches the gate and `commit` by the path that already exists,
 * rather than as a fourth list every consumer has to learn about.
 */
export const findRestarts = (windows: Window[], lang?: string): RepeatedPhrase[] => {
  const stopwords = stopwordsFor(lang)
  const found: RepeatedPhrase[] = []
  for (const window of windows) {
    const words = normalise(window.text).split(' ').filter(Boolean)
    const positions = new Map<string, number[]>()
    for (let start = 0; start + RESTART_PROBE_LENGTH <= words.length; start += 1) {
      const run = words.slice(start, start + RESTART_PROBE_LENGTH).join(' ')
      const where = positions.get(run) ?? []
      where.push(start)
      positions.set(run, where)
    }
    const seen = new Set<string>()
    for (const where of positions.values()) {
      for (let index = 0; index < where.length - 1; index += 1) {
        const left = where[index]
        const right = where[index + 1]
        if (left === undefined || right === undefined) {
          continue
        }
        // Grow forward only, to the divergence index. Growing left as well would fold this into
        // the span `findRepeatedPhrases` already reports; what identifies a restart is where the
        // two attempts PART, which is exactly where this loop stops.
        let end = left + RESTART_PROBE_LENGTH
        let matchEnd = right + RESTART_PROBE_LENGTH
        while (end < right && matchEnd < words.length && words[end] === words[matchEnd]) {
          end += 1
          matchEnd += 1
        }
        const diverges = end < right && matchEnd < words.length && words[end] !== words[matchEnd]
        if (!diverges) {
          continue
        }
        const prefix = words.slice(left, end)
        // The abandoned attempt: what the speaker got through before backing up. Shorter than the
        // prefix means they never got as far as they had already agreed on, which is a restart;
        // longer means the first attempt completed something, which is reuse.
        const abandoned = right - end
        if (abandoned >= prefix.length) {
          continue
        }
        if (!prefix.some((word) => contentWordCount(word, stopwords) > 0)) {
          continue
        }
        const phrase = prefix.join(' ')
        if (seen.has(phrase)) {
          continue
        }
        seen.add(phrase)
        found.push({
          phrase,
          count: 2,
          windowStartMs: window.startMs,
          windowEndMs: window.endMs,
        })
      }
    }
  }
  return found.sort((left, right) => left.windowStartMs - right.windowStartMs)
}

// A stretched vowel or an unfinished word at the very edge of what a window heard: the last
// token butts against the boundary with no closing punctuation and no gap, which is what a
// clause cut off mid-word looks like in prose. Conservative on purpose (this reports a
// candidate to look at, not a verdict): it only fires when the edge token itself carries no
// terminal punctuation, since an ordinary sentence ending exactly at a window's own boundary is
// not truncated, it is well-placed.
const TERMINAL_PUNCTUATION = /[.!?…,;:]$/

export const findTruncatedEdges = (windows: Window[]): TruncatedEdge[] => {
  const edges: TruncatedEdge[] = []
  for (const window of windows) {
    const trimmed = window.text.trim()
    if (trimmed === '') {
      continue
    }
    const words = trimmed.split(/\s+/)
    const last = words.at(-1)
    if (last !== undefined && !TERMINAL_PUNCTUATION.test(last)) {
      edges.push({
        windowStartMs: window.startMs,
        windowEndMs: window.endMs,
        edge: 'end',
        word: last,
      })
    }
  }
  return edges
}

/**
 * Anomalies against a cached whole-file transcript: a window whose carrying words the cached
 * transcript's own span does not contain. Optional, since the cached transcript is exactly the
 * instrument under suspicion, reported as a place to look, the same honest-limits stance
 * `peek`'s viewsDisagree and `joins`'s reading already take, never a verdict on its own.
 */
export const findAnomalies = (
  windows: Window[],
  cachedWords: { text: string; startMs: number; endMs: number }[],
): TranscriptAnomaly[] => {
  const anomalies: TranscriptAnomaly[] = []
  for (const window of windows) {
    const windowCarrying = normalise(window.text)
      .split(' ')
      .filter((word) => word.length >= 4)
    if (windowCarrying.length === 0) {
      continue
    }
    const cachedText = cachedWords
      .filter((word) => word.endMs > window.startMs && word.startMs < window.endMs)
      .map((word) => word.text)
      .join(' ')
    const cachedNormalised = new Set(normalise(cachedText).split(' ').filter(Boolean))
    const hits = windowCarrying.filter((word) => cachedNormalised.has(word)).length
    const overlap = hits / windowCarrying.length
    // Same 0.6 bar converge's own containsPhrase uses for the identical question (does this
    // window's wording show up in another text), which measured cleanly on real material: every
    // window inside a retake scored 1.00 against it and every window past it scored 0.00.
    if (overlap < 0.6) {
      anomalies.push({
        windowStartMs: window.startMs,
        windowEndMs: window.endMs,
        windowText: window.text,
        cachedText,
      })
    }
  }
  return anomalies
}

/**
 * Marks each repeated-phrase finding with whether the cached whole-file transcript corroborates
 * it, without dropping the ones it does not.
 *
 * findAnomalies already answers "does this window's own text show up in the cached transcript"
 * for the anomalies list; this asks the same question, scoped to the phrase itself rather than
 * the window's whole text, and writes the answer onto the finding instead of feeding a separate
 * list. A repeat the cache does not corroborate is not thereby false: the cache is a whole-file
 * pass, and #57's own finding is that averaging is exactly what a whole-file pass does to a
 * repeated line, which is the entire reason `--windows` exists. Uncorroborated stays in
 * `repeated`, marked, never moved out: the same "place to look, not a verdict" stance
 * findAnomalies already takes, applied to this list instead of a separate one.
 */
export const corroborateRepeats = (
  entries: RepeatedPhrase[],
  cachedWords: { text: string; startMs: number; endMs: number }[],
): RepeatedPhrase[] =>
  entries.map((entry) => {
    const cachedText = cachedWords
      .filter((word) => word.endMs > entry.windowStartMs && word.startMs < entry.windowEndMs)
      .map((word) => word.text)
      .join(' ')
    const cachedNormalised = new Set(normalise(cachedText).split(' ').filter(Boolean))
    const phraseWords = entry.phrase.split(' ').filter(Boolean)
    const hits = phraseWords.filter((word) => cachedNormalised.has(word)).length
    // Same 0.6 bar findAnomalies and converge's own containsPhrase already use for this question.
    const corroborated = phraseWords.length > 0 && hits / phraseWords.length >= 0.6
    return { ...entry, corroborated }
  })

const numberFlag = (argv: string[], flag: string, fallback: number): number => {
  const index = argv.indexOf(flag)
  if (index === -1) {
    return fallback
  }
  const parsed = Number(argv[index + 1])
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} needs a positive number`)
  }
  return parsed
}

const flagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

/**
 * A bounded worker pool over Promise.all: `concurrency` windows in flight at once, the next one
 * starting the instant a slot frees up rather than waiting for a whole batch to finish. Plain
 * chunking (`windows.slice(i, i + n)`, await each chunk) would leave a fast window idle while a
 * slow one in the same chunk still runs; this keeps every slot busy until the queue empties.
 */
export const runPooled = async <T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index] as T, index)
    }
  })
  await Promise.all(runners)
  return results
}

export const defaultConcurrency = (): number =>
  Math.max(1, Math.min(MAX_CONCURRENCY, cpus().length))

const overlaps = (leftStartMs: number, leftEndMs: number, right: RepeatedPhrase): boolean =>
  leftStartMs < right.windowEndMs && right.windowStartMs < leftEndMs

/**
 * findRepeatedPhrases and findStackedOpeners check different shapes of the same defect class
 * (a run of words said twice, and two sentences opening on the same short phrase) and can
 * legitimately both fire on the same window without describing the same finding twice: a
 * three-word overlap and a two-word opener overlap are not required to coincide.
 *
 * With `--stride < --window`, the same real repeat is also heard by every window whose span
 * covers it, and reports the identical phrase once per window that heard it: a genuine repeat
 * at 224s shows up at the 216s, 224s and 232s windows alike when they overlap it. That is one
 * finding, not three, so entries reporting the same phrase from windows whose spans overlap in
 * time are collapsed into one, kept at the earliest window's span (where the repeat was first
 * audible). The overlap test walks the sorted run and grows a chain's own span as it absorbs
 * each entry, so a phrase spanning three overlapping windows in a row (A overlaps B, B overlaps
 * C, A does not directly overlap C) still collapses to one finding, not two.
 *
 * Two windows that merely happen not to overlap (`--stride >= --window`, or two overlapping
 * windows far enough apart that their spans do not touch) reporting the same short phrase is
 * not this shape: "y bueno" said once near 0s and again, unrelated, near 300s are two different
 * findings, and only a time overlap between the reporting windows tells them apart from that.
 */
export const mergeRepeats = (...groups: RepeatedPhrase[][]): RepeatedPhrase[] => {
  const seen = new Set<string>()
  const byPhrase: RepeatedPhrase[] = []
  for (const group of groups) {
    for (const entry of group) {
      const key = `${entry.windowStartMs}:${entry.phrase}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      byPhrase.push(entry)
    }
  }
  byPhrase.sort((left, right) => left.windowStartMs - right.windowStartMs)

  const merged: RepeatedPhrase[] = []
  const chainSpans = new Map<RepeatedPhrase, { startMs: number; endMs: number }>()
  for (const entry of byPhrase) {
    const existing = merged.find((kept) => {
      if (kept.phrase !== entry.phrase) {
        return false
      }
      const span = chainSpans.get(kept)
      return span !== undefined && overlaps(span.startMs, span.endMs, entry)
    })
    if (existing === undefined) {
      merged.push(entry)
      chainSpans.set(entry, { startMs: entry.windowStartMs, endMs: entry.windowEndMs })
      continue
    }
    const span = chainSpans.get(existing)
    if (span !== undefined) {
      span.endMs = Math.max(span.endMs, entry.windowEndMs)
    }
  }
  return merged.sort((left, right) => left.windowStartMs - right.windowStartMs)
}

/**
 * The tiles covering only `spans`, for a caller that already knows which parts of a render are
 * new (#44 sweeping a commit's delta rather than its whole render).
 *
 * Each span is tiled by the same `buildWindows` a whole-file sweep uses, then offset to the
 * span's own start, so a partial sweep and a full one produce the identical window geometry over
 * the same audio rather than two alignments that find different things. Each span is also widened
 * by one window on each side before tiling: a repeat is only visible to a window that contains
 * both of its occurrences, and the second occurrence of a phrase whose first is just outside a
 * changed segment lives in the material immediately around it. Overlapping tiles from adjacent
 * spans are collapsed, so a run of neighbouring changed segments costs one continuous sweep
 * rather than one sweep per segment with the shared audio transcribed twice.
 */
export const spanWindows = (
  spans: Interval[],
  durationMs: number,
  windowMs: number,
  strideMs: number,
): Interval[] => {
  const tiles: Interval[] = []
  for (const span of spans) {
    const startMs = Math.max(0, span.startMs - windowMs)
    const endMs = Math.min(durationMs, span.endMs + windowMs)
    if (endMs <= startMs) {
      continue
    }
    for (const tile of buildWindows(endMs - startMs, windowMs, strideMs)) {
      tiles.push({ startMs: startMs + tile.startMs, endMs: startMs + tile.endMs })
    }
  }
  const sorted = tiles.sort((left, right) => left.startMs - right.startMs)
  const deduped: Interval[] = []
  for (const tile of sorted) {
    const last = deduped.at(-1)
    // Identical tiles only: two overlapping spans tiled independently produce the same tile twice
    // (transcribing the same audio twice for the same answer), but two merely-overlapping tiles
    // are the differently-aligned coverage --stride exists to produce and must both survive.
    if (last !== undefined && last.startMs === tile.startMs && last.endMs === tile.endMs) {
      continue
    }
    deduped.push(tile)
  }
  return deduped
}

/**
 * `spans` restricts the sweep to the named parts of the media (#44's delta sweep). Undefined
 * sweeps the whole file, which is what `verify --windows` itself always does: a caller asking
 * this question directly has no prior round to diff against and no reason to trust one.
 */
export const runVerifyWindows = async (
  mediaPath: string,
  windowMs: number,
  strideMs: number,
  lang: string | undefined,
  concurrency: number,
  cachedTranscriptPath: string | undefined,
  spans?: Interval[],
): Promise<VerifyWindowsReport> => {
  const durationMs = await probeDurationMs(mediaPath)
  const tiles =
    spans === undefined
      ? buildWindows(durationMs, windowMs, strideMs)
      : spanWindows(spans, durationMs, windowMs, strideMs)

  const windows = await runPooled(tiles, concurrency, async (tile) => {
    const text = await transcribeWindow(mediaPath, tile.startMs, tile.endMs, lang, 'vcut-verify')
    return { startMs: tile.startMs, endMs: tile.endMs, text }
  })

  const phrases = findRepeatedPhrases(windows, lang)
  const cachedWords =
    cachedTranscriptPath === undefined
      ? undefined
      : parseSrt(readFileSync(cachedTranscriptPath, 'utf8')).words

  const mergedRepeats = mergeRepeats(
    phrases.repeated,
    findStackedOpeners(windows),
    findRestarts(windows, lang),
  )
  const repeated =
    cachedWords === undefined ? mergedRepeats : corroborateRepeats(mergedRepeats, cachedWords)
  const truncated = findTruncatedEdges(windows)
  const anomalies = cachedWords === undefined ? [] : findAnomalies(windows, cachedWords)

  return {
    version: 1,
    input: mediaPath,
    durationMs,
    windowMs,
    strideMs,
    windows,
    repeatedPhrases: repeated,
    discountedRepeats: phrases.discounted,
    truncatedEdges: truncated,
    anomalies,
  }
}

// --windows itself takes no value (it selects the sweep, the only mode this command has today),
// so a naive "previous flag consumed a value" positional scan reads <media> as --windows's own
// argument and reports a missing positional. Same trap commit.ts's own BOOLEAN_FLAGS set exists
// to avoid.
const BOOLEAN_FLAGS = new Set(['--windows', '--json', '--human', '--help'])

const positional = (args: string[]): string | undefined => {
  for (const [index, arg] of args.entries()) {
    if (arg.startsWith('-')) {
      continue
    }
    const previous = args[index - 1]
    if (previous?.startsWith('--') && !BOOLEAN_FLAGS.has(previous)) {
      continue
    }
    return arg
  }
  return undefined
}

export const verifyCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  if (!argv.includes('--windows')) {
    throw new UsageError(HELP)
  }
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const target = positional(argv)
  if (target === undefined) {
    throw new UsageError(HELP)
  }
  const mediaPath = resolve(target)
  if (!existsSync(mediaPath)) {
    throw new UsageError(`no media at ${mediaPath}`)
  }

  const windowS = numberFlag(argv, '--window', DEFAULT_WINDOW_S)
  // Half the window, not the window itself: adjacent non-overlapping tiles put an interior
  // boundary at every window edge, and a phrase repeated across that edge (first half in one
  // window's tail, second half in the next window's head) is invisible to a detector that only
  // reads a window's own text. Striding at half the width means every point in the media falls
  // inside at least two differently-aligned windows, so a repeat pair can no longer straddle
  // every window that would otherwise have seen it whole. An explicit --stride still wins.
  const strideS = numberFlag(argv, '--stride', windowS / 2)
  const concurrency = numberFlag(argv, '--concurrency', defaultConcurrency())
  if (!Number.isInteger(concurrency)) {
    throw new UsageError('--concurrency needs a positive integer')
  }
  const transcriptArg = flagValue(argv, '--transcript')
  if (transcriptArg !== undefined && !existsSync(resolve(transcriptArg))) {
    throw new UsageError(`no transcript at ${resolve(transcriptArg)}`)
  }

  const report = await runVerifyWindows(
    mediaPath,
    Math.round(windowS * 1000),
    Math.round(strideS * 1000),
    flagValue(argv, '--lang'),
    concurrency,
    transcriptArg === undefined ? undefined : resolve(transcriptArg),
  )

  if (mode === 'json') {
    emitJson(report)
    return
  }

  const lines = [
    heading('verify --windows'),
    line('windows', String(report.windows.length)),
    line('repeated phrases', String(report.repeatedPhrases.length)),
    line('discounted repeats', String(report.discountedRepeats.length)),
    line('truncated edges', String(report.truncatedEdges.length)),
    line('anomalies', String(report.anomalies.length)),
  ]
  for (const repeat of report.repeatedPhrases) {
    const corroboration = repeat.corroborated === false ? ' (uncorroborated)' : ''
    lines.push(
      line(
        `${(repeat.windowStartMs / 1000).toFixed(2)}s`,
        `repeated x${repeat.count}: "${repeat.phrase}"${corroboration}`,
      ),
    )
  }
  for (const discounted of report.discountedRepeats) {
    lines.push(
      line(
        `${(discounted.windowStartMs / 1000).toFixed(2)}s`,
        `discounted: "${discounted.phrase}" (${discounted.reason})`,
      ),
    )
  }
  for (const edge of report.truncatedEdges) {
    lines.push(line(`${(edge.windowEndMs / 1000).toFixed(2)}s`, `truncated at "${edge.word}"`))
  }
  for (const anomaly of report.anomalies) {
    lines.push(
      line(
        `${(anomaly.windowStartMs / 1000).toFixed(2)}s`,
        `window/cache disagree: "${anomaly.windowText.slice(0, 60)}"`,
      ),
    )
  }
  if (report.repeatedPhrases.length > 0 || report.truncatedEdges.length > 0) {
    lines.push(nextStep(`listen at the timestamps above in ${target}`))
  }
  console.log(lines.join('\n'))
}
