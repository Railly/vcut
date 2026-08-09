# Changelog

Notable changes to `@crafter/vcut`. Entries say what changed and, where it is not obvious, what measurement led to it.

## 0.3.0

### Added

- **`vcut semantic review`** reads an EDL back and returns the transcript as it survives the cuts, so what gets judged is the result rather than the plan. `--master` measures silence on the render itself, catching the pause two adjoining segments create together that neither of them contained. `--master-transcript` returns the render's own lines, which is the only place a mangled join is visible as text.
- **`unreviewed`** in the review output: the stretches between two cuts that no proposal ever touched. They look reviewed because their neighbours are, and that is where a defect survives round after round. On the recording this was built against, a discourse marker sat in one for four rounds with a cut ending 1.7s before it and another starting 140ms after.
- **`--crop <spec>`** on `edl build`, framing the whole edit at once. A traditional editor sets the frame per clip, so remembering the menu bar after cutting means redoing every segment by hand; here it is one decision and changing it never touches a cut boundary. Accepts `top|bottom|left|right:<fraction>` or `x,y,width,height`, as fractions so the EDL survives a source at another resolution.
- **Loudness normalisation.** The EDL had carried `speechTargetLufs` since V1 and nothing read it. Applied to the concatenated result rather than per segment, so a quiet passage stays quieter than a loud one. Measured: -25.4 LUFS in, -16.5 out, true peak -0.87 against a -1 ceiling.
- **`--edge-fade <ms>`** (default 50) ramps each segment edge to zero. Not a crossfade: overlapping the sides would shorten the render against concatenated video and drift the audio out of sync, so each side fades within its own segment. Measured 18 to 20 dB less at the joint.
- **Audio recorded separately.** `detect --audio <path>` measures silence on that file rather than on the camera track, which is the one being discarded. The path travels in the report, so `edl build` writes both sources without being told twice. `--audio-offset <ms>` corrects two recorders that did not start together by sliding the window the audio is read from.
- **`kind: "non-speech"`** in the proposal schema, with `skills/core/scripts/non-speech.py` to find those spans. Keyed on the absence of speech rather than the presence of breathing: on one recording a breath scored 0.087 for Breathing, too low to use, against 0.06 for Speech where every span holding words scored 0.64 and up.
- **`vcut setup classifier`** fetches that model into `~/.vcut/panns`, and `vcut doctor` reports whether it is present. Absent is a supported state, not a broken install: the check it performs falls back to a human ear.
- **`vcut skills list`** now lists bundled scripts alongside the guides, so a caller asking what is available learns the script exists.

### Changed

- **Cutting is documented as a loop, not a command.** Each class of defect only becomes visible once the one above it is gone, so the skill now carries the round in order, eight invariants stated about the render rather than the plan, and a stopping condition: a round that proposes nothing, not a removal percentage and not diminishing returns.
- `matchTarget` said "below every target range" for any value outside a range, so a 45% removal received the opposite of the message it needed.
- Filler words are documented as a deletion test rather than a vocabulary: delete the candidate, read what remains, ask whether a listener learns anything less. A word list only finds what someone thought to write down and has to be rewritten per language.

### Removed

- **`noiseReduction` is gone from the EDL schema.** Measured on one recording, the background floor already sat at -54 dB and a denoiser at a default setting pushed a weak syllable from -45 dB to -57, which is the same defect as a threshold set too high. There is no safe default because the right amount depends on the room, and unlike a cut it cannot be undone by editing the EDL.

### Fixed

- Cuts separated by a remainder too short to hold a word are merged. Two cuts with 216ms between them do not read as two cuts: the ear hears one broken passage, and a listener flagged exactly that before any metric showed it. Six such islands became zero on the test material.
- `detect` reported filler candidates past the end of the source when the transcript outlived the cut it was made from.
- The renderer's audio contract asked the segment's own source for sound, which fails for a video recorded mute; `audioTrackPolicy` had the same shape of bug, resolving to `explicit-silence` because the picture carried no audio.
- `renderedGaps` promised an empty list when it could not measure but threw if ffmpeg was absent from PATH.

## 0.2.0

### Removed

- **Breaking: `detect` no longer looks for filler words.** The `fillers` field, `--no-fillers`, and the three-language validation of `--lang` are gone. The list held six tokens per language; measured on one Spanish recording it caught 3 spans while the finished cut still carried 19 fillers in 332 words. What it missed were ordinary words that carry no meaning in one sentence and plenty in the next, which no list can distinguish. Filler words are now proposed by a model through `vcut semantic`.
- `--lang` survives as a free-form string, passed through to the semantic export so a model knows what it is reading.

## 0.1.1

### Added

- **`vcut semantic`**: `export` hands the transcript to a model as numbered lines, `check` validates the proposals it returns. vcut never calls a model itself, which keeps it dependency-free and its output reproducible.

### Fixed

- The renderer normalised sample rate but not channels, so a mono source produced a master its own validator rejected. Only visible with a mono source, which is how a separate microphone usually records.
- Word-level transcripts lost the leading space that marks where a word begins, making `"Cra"` + `"fter"` impossible to rebuild.

## 0.1.0

First release. `detect`, `edl build`, `render`, `schema`, `skills`, `doctor`.
