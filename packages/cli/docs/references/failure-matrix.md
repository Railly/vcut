# Video preprocessing failure matrix

Date: 2026-07-23

## Policy

Automatic recovery is allowed only when it is deterministic, non-destructive, and does not change meaning.

Every failure emits:

- stage
- source or output ID
- detector
- observed value
- expected value
- severity
- automatic action
- human decision
- resumable checkpoint

## Doctor and storage

| Failure | Detection | Severity | Automatic action | Human decision |
|---|---|---:|---|---|
| Bun, FFmpeg, FFprobe, transcription, or Remotion missing | Version and executable probes | Block | None | Install or choose supported fallback |
| Requested burned captions but FFmpeg lacks text filters | Filter-list probe | Block only the burned derivative | Export reviewed SRT and structured captions, or use verified Remotion renderer | Re-run caption QA and preview approval |
| Incomplete executable path | Resolve every required binary | Block | Use declared full path for subprocess | Approve durable environment fix |
| Output directory absent | Filesystem check | Recoverable | Create campaign-owned directory | None |
| Output directory not writable | Write probe | Block | None | Choose writable destination |
| Insufficient disk for proxy and render | Free-space estimate with safety margin | Block | Skip optional proxy only when final still fits | Free space or change volume |
| Existing output path | Existence and hash check | Block | Generate a new versioned name | Approve replacement separately |
| Interrupted prior run | Check checkpoint and output receipts | Recoverable | Resume from last verified stage | Restart only if inputs changed |

## Source integrity

| Failure | Detection | Severity | Automatic action | Human decision |
|---|---|---:|---|---|
| Missing source | Absolute path and stat | Block | None | Locate source |
| Source hash differs from manifest | SHA-256 | Block | Preserve both observations | Decide whether it is a new take |
| Corrupt container | FFprobe and decode probe | Block | None | Recover or reject source |
| Video stream missing | FFprobe | Conditional | Audio-only transcript path | Confirm audio-only intent |
| Audio stream missing | FFprobe | Block for face-led speech | None | Supply external audio or reject |
| Rotation metadata conflicts with pixels | Probe and contact sheet | Review | Normalize preview only | Approve final orientation |
| Variable frame rate | Frame timestamps | Review | Normalize timeline in derived output | Confirm desired FPS |
| Unsupported codec or pixel format | Decoder capability probe | Recoverable | Create loss-controlled mezzanine | Approve storage cost |
| HDR or ambiguous color metadata | Color probe and sampled frame | Review | Preserve source and render test derivative | Choose SDR conversion policy |

## Privacy, consent, and retention

| Failure | Detection | Severity | Automatic action | Human decision |
|---|---|---:|---|---|
| Secret or private identifier visible | Screen contact sheet, transcript scan, and preview review | Critical | Stop packaging and mark source interval | Redact, replace, or reject |
| Another person appears without consent receipt | Session privacy contract | Block | None | Record consent or reject source |
| Consent disputed after approval | Updated session receipt | Critical | Block unpublished packages and mark published destinations for review | Withdraw, replace, or document resolution |
| Privacy review stale after source or EDL change | Hash dependency check | Block | Invalidate affected review | Re-run privacy review |
| Raw retention policy missing | Session schema | Block | None | Choose policy |
| Deletion requested while hold exists | Session retention state | Critical | Refuse deletion | Resolve hold |
| Deletion completed without receipt | Session schema and filesystem audit | Critical | Preserve observed state | Reconstruct evidence without inventing details |

## Audio and synchronization

| Failure | Detection | Severity | Automatic action | Human decision |
|---|---|---:|---|---|
| Clipped speech | Peak and sample clipping scan | Review | Prefer unclipped take | Approve repair if no alternate |
| Very low speech | Integrated loudness and speech region scan | Recoverable | Normalize preview | Approve final processing |
| High noise | Noise-floor estimate and listening marker | Review | Light denoise preview | Choose acceptable artifact level |
| External audio offset | Clap, waveform correlation, or slate | Review | Propose offset | Approve sync |
| External audio drift | Start and end correlation | Block | Propose time-stretch map | Approve drift correction |
| Channel phase or one-sided audio | Channel correlation and level | Recoverable | Propose mono fold-down | Approve |
| Unexpected silence after render | Stream and loudness scan | Block | None | Investigate pipeline |
| Audio discontinuity at cut | Short-window waveform scan | Review | Add small crossfade proposal | Approve rhythm |

## Transcription and semantics

| Failure | Detection | Severity | Automatic action | Human decision |
|---|---|---:|---|---|
| Transcription backend fails | Exit status and receipt | Block | Retry once with same inputs | Choose alternate backend |
| Timed output fragments words | Token-boundary rules | Recoverable | Reassemble tokens | Review low-confidence joins |
| Technical term misrecognized | Campaign dictionary and fuzzy match | Review | Propose correction with provenance | Approve correction |
| Language or code-switch mismatch | Segment language detection | Review | Preserve raw output | Correct intended language |
| Repeated sentence uncertain | Transcript similarity plus time | Review | Mark candidate duplicate | Choose take |
| Pause mistaken for dead time | Silence plus neighboring transcript | Review | Keep by default | Approve removal |
| Edit removes a caveat or negation | Semantic-diff gate | Block | None | Approve or reject material change |
| Transcript confidence unavailable | Provider output inspection | Review | Mark unknown | Review affected intervals |

## Visual and composition

| Failure | Detection | Severity | Automatic action | Human decision |
|---|---|---:|---|---|
| Black frames | `blackdetect` | Review | Mark intervals | Distinguish fade from failure |
| Frozen frames | `freezedetect` | Review | Mark intervals | Distinguish intentional screen hold using segment type and audio activity |
| Face outside manual crop | Contact sheet and crop bounds | Review | Suggest alternate crop | Approve crop |
| Screen proof unreadable | Rendered pixel size and visual review | Review | Suggest layout or punch-in | Approve |
| Caption covers proof | Bounding-box collision | Block for captioned derivative | Shift within safe master area | Approve destination preview |
| Infinite filter source or inconsistent frame count | Compare duration, frame rate, and decoded frames | Block | Bound generated sources, use shortest overlays, and set output duration | Re-render twice and compare hashes |
| Missing font | Render log and screenshot diff | Block | Use approved fallback only if declared | Approve visual change |
| Overlay asset missing | Path and hash check | Block | None | Locate or remove asset |
| Platform UI covers essential element | Native destination preview | Review | Reposition derivative overlay | Approve package |

## EDL and render

| Failure | Detection | Severity | Automatic action | Human decision |
|---|---|---:|---|---|
| Segment source ID missing | Schema and referential check | Block | None | Repair EDL |
| `outMs` not greater than `inMs` | Semantic validator | Block | None | Repair EDL |
| Segment exceeds source duration | Probe and EDL check | Block | Clamp preview only for diagnosis | Repair EDL |
| Overlapping unintended source intervals | EDL analysis | Review | Mark overlap | Approve intentional reuse |
| Unapproved segment in final render | Approval-state check | Block | Preview only | Approve or reject |
| Render duration differs from EDL | Calculated versus probed duration | Block | None | Investigate frame rounding or composition |
| Start, middle, or end does not decode | Decode probes | Block | None | Re-render or change codec |
| Color metadata differs from contract | FFprobe | Block | Re-encode derived output | Approve contract change |
| No-audio policy mismatch | Stream probe | Block | Remove or add explicit silent track | Choose declared policy |
| Source hash changes after run | Repeat SHA-256 | Critical | Stop and preserve evidence | Investigate source mutation |

## Captions and delivery

| Failure | Detection | Severity | Automatic action | Human decision |
|---|---|---:|---|---|
| Cue order invalid | Timestamp validator | Block | Sort only when semantic order is unchanged | Review |
| Cue overlap | Timestamp validator | Block | Propose boundary adjustment | Approve |
| Cue exceeds duration | Timestamp validator | Block | Clamp preview only | Repair source timing |
| Technical name wrong | Dictionary and review | Review | Propose correction | Approve |
| Caption line unreadable | Length, duration, and visual preview | Review | Re-segment phrases | Approve style |
| Destination rejects upload | Native or API receipt | Block | Preserve failure receipt | Choose derivative or native fix |

## Resume semantics

A stage can be reused only when all its declared input hashes match.

| Stage | Resume key |
|---|---|
| Probe | Source SHA-256 and probe version |
| Transcript | Source SHA-256, backend, model, language, options |
| Corrected transcript | Raw transcript hash and dictionary hash |
| EDL | Source hashes, script version, corrected transcript hash |
| Preview | EDL hash, renderer version, asset hashes |
| Master | Approved EDL hash, renderer version, export contract |
| Captions | Corrected transcript hash, grouping configuration, master duration |
| Validation | Output hash and validation-tool versions |

Changing a platform caption does not invalidate the clean master. Changing the canonical story or EDL does.
