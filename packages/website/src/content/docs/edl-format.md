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
    "noiseReduction": "off",
    "externalAudioSourceId": null,
    "syncOffsetMs": 0
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

### Fields that are rejected, not ignored

The schema has room for `externalAudioSourceId`, `syncOffsetMs`, and `noiseReduction`. The renderer does not implement them, so it **rejects** an EDL that sets them rather than rendering something that quietly ignores half the instruction.

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
