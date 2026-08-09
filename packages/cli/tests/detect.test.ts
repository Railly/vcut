import { describe, expect, test } from 'bun:test'
import {
  PRESET_DB,
  parseBlackLog,
  parseClipping,
  parseFreezeLog,
  parseSilenceLog,
  parseSrt,
  withinSource,
} from '../src/detect.ts'

const realSilenceLog = `
[silencedetect @ 0x9cd07c480] silence_start: 0
[silencedetect @ 0x9cd07c480] silence_end: 1.196833 | silence_duration: 1.196833
[silencedetect @ 0x9cd07c480] silence_start: 4.534271
[silencedetect @ 0x9cd07c480] silence_end: 5.284354 | silence_duration: 0.750083
[silencedetect @ 0x9cd07c480] silence_start: 7.879521
[silencedetect @ 0x9cd07c480] silence_end: 8.2965 | silence_duration: 0.416979
`

describe('presets', () => {
  test('carry the production thresholds from the archived pipeline', () => {
    expect(PRESET_DB.noisy).toBe(-20)
    expect(PRESET_DB.clean).toBe(-30)
    expect(PRESET_DB.podcast).toBe(-35)
  })
})

describe('parseSilenceLog', () => {
  test('converts paired markers into millisecond intervals', () => {
    const silences = parseSilenceLog(realSilenceLog, 381_760)
    expect(silences).toHaveLength(3)
    expect(silences[0]).toEqual({ kind: 'silence', startMs: 0, endMs: 1197, durationMs: 1197 })
    expect(silences[1].startMs).toBe(4534)
    expect(silences[2].durationMs).toBe(417)
  })

  test('closes a trailing silence that ffmpeg never terminates', () => {
    const log = `${realSilenceLog}[silencedetect @ 0x1] silence_start: 380.375\n`
    const silences = parseSilenceLog(log, 381_760)
    expect(silences).toHaveLength(4)
    expect(silences[3]).toEqual({
      kind: 'silence',
      startMs: 380_375,
      endMs: 381_760,
      durationMs: 1385,
    })
  })

  test('drops a dangling start that begins after the media ends', () => {
    const silences = parseSilenceLog('[x] silence_start: 400.0\n', 381_760)
    expect(silences).toHaveLength(0)
  })

  test('returns nothing for a log without markers', () => {
    expect(parseSilenceLog('frame= 100 fps=25\n', 10_000)).toHaveLength(0)
  })
})

describe('parseSrt', () => {
  test('flags a sentence-level transcript as not word-level', () => {
    const srt = `1
00:00:00,000 --> 00:00:07,000
 Hola a todos, en este video vamos a ver como funciona

2
00:00:07,000 --> 00:00:12,320
 la herramienta por dentro.
`
    const transcript = parseSrt(srt)
    expect(transcript.words).toHaveLength(2)
    expect(transcript.wordLevel).toBe(false)
    expect(transcript.words[1].startMs).toBe(7000)
    expect(transcript.words[1].endMs).toBe(12_320)
  })

  test('flags a one-token-per-cue transcript as word-level', () => {
    const srt = `1
00:00:00,000 --> 00:00:00,400
Hola

2
00:00:00,400 --> 00:00:00,900
chicos
`
    expect(parseSrt(srt).wordLevel).toBe(true)
  })

  test('parses hours past the first', () => {
    const srt = `1
01:02:03,456 --> 01:02:04,000
palabra
`
    expect(parseSrt(srt).words[0].startMs).toBe(3_723_456)
  })
})

describe('review candidates', () => {
  test('parses black frame spans', () => {
    const log = '[blackdetect @ 0x1] black_start:12.5 black_end:13.25 black_duration:0.75\n'
    expect(parseBlackLog(log)).toEqual([
      { kind: 'black', startMs: 12_500, endMs: 13_250, detail: 'black frames' },
    ])
  })

  test('pairs freeze markers', () => {
    const log =
      '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 5\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 9.5\n'
    const frozen = parseFreezeLog(log)
    expect(frozen).toHaveLength(1)
    expect(frozen[0]).toEqual({
      kind: 'frozen',
      startMs: 5000,
      endMs: 9500,
      detail: 'frozen frames',
    })
  })

  test('flags clipping only when the peak crosses -1 dBFS', () => {
    expect(parseClipping('Peak level dB: -6.20\n', 10_000)).toHaveLength(0)
    const clipped = parseClipping('Peak level dB: -6.20\nPeak level dB: -0.10\n', 10_000)
    expect(clipped).toHaveLength(1)
    expect(clipped[0].kind).toBe('clipping')
    expect(clipped[0].detail).toContain('-0.10')
  })

  test('ignores an infinite peak from a silent track', () => {
    expect(parseClipping('Peak level dB: -inf\n', 10_000)).toHaveLength(0)
  })
})

describe('withinSource', () => {
  test('drops candidates the source no longer contains', () => {
    const candidates = [
      { startMs: 1_000, endMs: 1_400 },
      { startMs: 179_000, endMs: 179_500 },
      { startMs: 392_000, endMs: 392_600 },
    ]
    expect(withinSource(candidates, 180_000)).toHaveLength(2)
  })

  test('keeps a candidate ending exactly at the last millisecond', () => {
    expect(withinSource([{ startMs: 900, endMs: 1_000 }], 1_000)).toHaveLength(1)
  })

  test('keeps everything when the transcript fits the source', () => {
    const candidates = [{ startMs: 0, endMs: 500 }]
    expect(withinSource(candidates, 180_000)).toEqual(candidates)
  })
})

describe('fragmentRatio', () => {
  const srt = (cues: string[]): string =>
    cues.map((text, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i},500\n${text}`).join('\n\n')

  test('reports zero when every cue opens a word', () => {
    expect(parseSrt(srt([' Hola', ' a', ' todos'])).fragmentRatio).toBe(0)
  })

  test('counts the cues that continue a word instead of starting one', () => {
    // What a token split looks like: "Crafter" arrives as two cues, one of them a fragment.
    expect(parseSrt(srt([' Cra', 'fter', ' Station', ' y'])).fragmentRatio).toBe(0.25)
  })

  test('still calls a token-split transcript word-level, which is why the ratio exists', () => {
    // Every cue holds one token and no spaces, so a cue count cannot tell the two apart.
    const transcript = parseSrt(srt([' Cra', 'fter']))
    expect(transcript.wordLevel).toBe(true)
    expect(transcript.fragmentRatio).toBe(0.5)
  })

  test('reports zero for an empty transcript rather than dividing by nothing', () => {
    expect(parseSrt('').fragmentRatio).toBe(0)
  })
})
