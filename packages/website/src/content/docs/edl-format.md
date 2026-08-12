---
title: The EDL
description: What an edit decision list contains, what approval means, and what the renderer refuses.
order: 4
---

## The EDL

The edit decision list is the artifact between detection and rendering. It exists so there is something a human can read and disagree with before any file gets written.

It describes the material that **survives**, not the material that gets deleted.

### Shape

```json
{
  "version": 1,
  "campaignId": "my-video",
  "createdAt": "2026-01-15T18:00:00.000Z",
  "timebase": "milliseconds",
  "sources": [
    {
      "id": "recording-mp4",
      "path": "/absolute/path/recording.mp4",
      "sha256": "…",
      "durationMs": 381760,
      "hasVideo": true,
      "hasAudio": true
    }
  ],
  "segments": [
    {
      "id": "segment-001",
      "sourceId": "recording-mp4",
      "inMs": 1100,
      "outMs": 4633,
      "reason": "approved-line",
      "handlesMs": { "before": 100, "after": 100 },
      "approval": "proposed",
      "semanticRisk": "none",
      "crop": null
    }
  ],
  "audio": {
    "speechTargetLufs": -16,
    "truePeakMaxDbtp": -1,
    "externalAudioSourceId": null,
    "syncOffsetMs": 0,
    "edgeFadeMs": 50
  },
  "output": {
    "path": "/absolute/path/master.mp4",
    "width": 1920,
    "height": 1080,
    "fps": 60,
    "videoCodec": "h264",
    "pixelFormat": "yuv420p",
    "colorSpace": "bt709",
    "audioTrackPolicy": "required",
    "overwrite": false
  },
  "approval": {
    "status": "draft",
    "approvedAt": null,
    "approvedBy": null
  }
}
```

The full JSON Schema ships in the package under `schemas/edl.schema.json`.

### Audio-only sources

A source with no video stream — a meeting-recorder mic track, a podcast export, an m4a in an mp4 container — produces a legal EDL, not an error. Its source entry carries `"hasVideo": false`, and `output` carries only `path`, `audioTrackPolicy`, and `overwrite`: `width`, `height`, `fps`, `videoCodec`, `pixelFormat`, and `colorSpace` are all absent, since the V1 video contract they describe has no picture to apply to on this EDL. `durationMs` on the source is the audio stream's own duration, since that is what segments are actually trimmed against.

```json
{
  "sources": [
    {
      "id": "meeting-mp4",
      "path": "/absolute/path/meeting.mp4",
      "sha256": "…",
      "durationMs": 1_145_000,
      "hasVideo": false,
      "hasAudio": true
    }
  ],
  "output": {
    "path": "/absolute/path/master.m4a",
    "audioTrackPolicy": "required",
    "overwrite": false
  }
}
```

`render` reads the absence of a video source and implies `--audio-only` rather than requiring it; `--mode master` on an EDL shaped this way produces an AAC audio master instead of a video. `--crop` is refused at build time on a video-less source rather than silently accepted and ignored.

### Approval

Two levels, and both start closed.

- **`segment.approval`** is `proposed`, `approved`, or `rejected`.
- **`approval.status`** on the EDL is `draft`, `approved`, or `rejected`.

`vcut render --mode preview` accepts proposed segments, so you can watch the cut before committing to it. `--mode master` requires the EDL approved, every segment approved, and an approval identity recorded.

**vcut never writes `approved`.** There is no flag for it and no `--yes`. Changing it is a human act, whether by hand or through a tool a human drives.

### What the renderer refuses

A master render aborts on any of these:

- the EDL or any segment is not approved
- a source file is missing
- a source hash no longer matches what the EDL recorded
- the output path already exists
- a segment references an unknown source or an interval outside the source duration
- a crop falls outside the frame
- `audioTrackPolicy` is `required` but a source has no audio

Hashing sources and refusing on a mismatch is what makes an approval mean something: you approved *that* footage, not whatever now sits at that path.

### Audio recorded separately

`externalAudioSourceId` names a second entry in `sources` that carries sound and no picture. The renderer reads every segment's audio from there instead of from the video, which is the case a separate microphone exists for.

`syncOffsetMs` corrects two recorders that did not start together. It slides the window the audio is read from rather than shifting the audio afterwards, because shifting changes the length and the length is what the duration contract checks. Two recordings started by the same app share a clock, so zero is the common case.

`edgeFadeMs` ramps the last and first milliseconds of each segment to zero. It is not a crossfade: overlapping the two sides would shorten the render against concatenated video and drift the audio out of sync, so each side fades within its own segment.

`speechTargetLufs` and `truePeakMaxDbtp` are applied to the concatenated result rather than per segment, so a quiet passage stays quieter than a loud one instead of every piece being dragged to the same number.

### Fields that are rejected, not ignored

An `externalAudioSourceId` naming nothing, or naming a source with no audio, is refused rather than silently falling back to the camera track. So is a crop outside the source bounds, a segment whose source is unknown, and a master render whose EDL is not approved.

A tool that silently drops a field you set is worse than one that refuses to run.

### Self-validation

After rendering, vcut probes the file it just produced and compares it against the EDL: dimensions, pixel format, colour metadata, decoded frame count within one frame, sample rate, channel count, and the audio track contract.

A render that quietly produced two extra frames is a bug, and without this check it ships as a working file.

### Reproducibility

Renders pin the thread count, fix the creation timestamp, and avoid anything nondeterministic, so the same EDL produces a byte-identical file. The `sha256` in the render result exists so you can verify that yourself rather than take it on faith.

### Frame boundaries

Cut points are milliseconds, but frames are not whole milliseconds: at 60fps a frame is 16.666…ms. ffmpeg rounds each trim to the nearest frame on its own, and near a frame edge that rounding can go either way.

vcut places every boundary in the **middle** of its frame, as far as possible from the point where the rounding flips, so the same frame is chosen regardless of how many segments the EDL has. Aiming at the frame edge instead held for eight segments and drifted past tolerance at ten.

The end of the source is clamped to the real duration rather than snapped: a segment must never claim material past the end of the file.
