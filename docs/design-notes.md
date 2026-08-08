# Design notes

Why vcut is shaped the way it is. Written for someone deciding whether to trust it, or building something similar.

## The thresholds are inherited, not invented

The presets (-20 / -30 / -35 dB), the 0.3s minimum silence, the 0.10s margin, and the filler word lists come from a pipeline that ran in production on published video, not from tuning against one file. They are the least interesting and most valuable part of this tool: numbers that already survived contact with real recordings.

If you change them, change them against a measured distribution, not against what sounds reasonable.

## Detection and rendering are separate on purpose

`detect` never writes an EDL. `edl build` never renders. `render` never decides what to cut.

This is not layering for its own sake. Each boundary is a place a human can look at the intermediate artifact and disagree with it. A single command that went from video to master would be faster and would remove the only points where the work is reviewable.

## The renderer validates its own output

After rendering, vcut probes the file it just produced and compares it against the EDL: dimensions, pixel format, colour metadata, decoded frame count within one frame, sample rate, channel count, and the audio track contract.

A render that silently produced 1446 frames where the EDL implies 1444 is a bug, and without this check it ships as a working file. The strictness is the point; when a mismatch appeared during development, the fix was to correct the boundaries upstream rather than widen the tolerance here.

## Cuts land mid-frame, not on the frame edge

Cut points arrive as milliseconds. Frames do not land on millisecond boundaries: at 60fps a frame is 16.666...ms, so a frame edge rounded to a whole millisecond is never exactly on the edge. ffmpeg then rounds each `trim` to the nearest frame on its own, and near an edge that rounding can go either way.

The first version of `snapToFrame` aimed at the frame edge, which put every boundary at the exact point where ffmpeg's decision is least stable. It held for eight segments and broke at ten, when the accumulated drift crossed the renderer's one-frame tolerance. The bug was latent the whole time; a larger segment count only made it visible.

Aiming at the middle of the frame puts every boundary as far as possible from that flip point, so the same frame is chosen regardless of segment count. Verified by rendering the same EDL at 5, 10, 20, 40, and 115 segments.

The end of the source is clamped to the real duration rather than snapped: a segment must never claim material past the end of the file.

## Measured silence outranks a transcript boundary

Cuts are clamped so they never land inside a spoken word. That rule needs a caveat that only appears with a real word-level transcript.

`whisper --max-len 1` stretches each cue to the start of the next word, so a word's range routinely swallows the pause that follows it. On a six-minute recording, 118 of 119 silences overlapped some word's range, and naive clamping erased 57 of them outright: removal collapsed from 10.5% to 2.7% purely because a better transcript was supplied.

Silence measured from audio energy is stronger evidence than a transcript boundary inferred by a model. When clamping would shred a cut into a remainder shorter than the detector's own `--min-silence`, that remainder is overlap residue rather than a real pause, and the measured span wins.

## Silence detection needs the closing edge

ffmpeg emits `silence_start` and `silence_end` as separate log lines, and when a recording ends in silence it emits the start and never the end. Parsing only matched pairs drops the trailing silence, which is often the longest one in a recording that ends with the speaker sitting still.

The parser closes a dangling start against the source duration, and discards one that begins past the end of the media.

## Filler cutting fails loudly, not quietly

Filler words need word-level timestamps. A normal SRT carries one cue per sentence, spanning several seconds and a dozen words, which is not enough to cut a single word without guessing where it sits.

vcut detects this and reports zero fillers with a warning naming the fix, instead of interpolating positions inside a cue. A confident wrong timestamp cuts into speech; an honest zero costs a re-run of the transcriber.

## Machine output is the default, human output is designed

JSON when stdout is not a TTY, a summary when it is. Neither is a fallback for the other.

The human summary is not the JSON with fewer fields. It answers a different question: not "what did you find" but "is there enough here to bother cutting". That is why it leads with a proportion and a bar rather than a list of 119 intervals.

One consequence worth naming: `detect` reports both detected dead air and the net figure after margins are returned. Reporting only the first would show 16.5% where the EDL later removes 10.5%, and a reader would reasonably assume one of the two numbers is a bug. Two numbers with the reason for the gap is more honest than one number that reads wrong.

## Nothing approves itself

`edl build` writes every segment as `proposed` and the EDL as `draft`. `render --mode master` refuses an unapproved EDL, an unapproved segment, a changed source hash, or an existing output path.

There is no `--yes` for this. An agent operating vcut can do everything except decide that the cut is good.

## Reproducibility is checkable, not claimed

Renders pin the thread count, fix the creation timestamp, and avoid anything nondeterministic, so the same EDL produces a byte-identical file. The `sha256` in the render result exists so you can verify that yourself rather than take it on faith.

This is also how the port from one runtime to another was verified: same EDL, same hash, byte for byte.

## Unimplemented features are rejected, not ignored

The EDL schema has fields for external audio, sync offset, and noise reduction. The renderer does not implement them, so it rejects an EDL that sets them rather than rendering something that quietly ignores half the instruction.

A tool that silently drops a field you set is worse than one that refuses to run.
