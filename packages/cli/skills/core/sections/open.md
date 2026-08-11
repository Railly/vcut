## open

```bash
vcut open recording.mp4 --preset clean --lang es --transcript words.srt
```

A session keyed by the content of the source, not its path: `~/.vcut/sessions/<sha256-16>/`.
The same bytes at two paths share a session; the same path with new content gets a session of
its own rather than silently serving stale cache. Everything inside is disposable — a cache
`open` and later verbs read and write, never an artifact. The EDL a human approves still lives
where they wrote it, not inside a session directory a future `session gc` can clear.

`open` runs `detect` once and caches the report. A second `open` on unchanged media at the
same preset serves that cache instead of re-running ffmpeg: `cached: true` in the output, and
the difference is not subtle — seconds against a fraction of one. A `--preset` this session has
never used re-detects on purpose and assigns it a new `gen`, because a new threshold measures
different silences.

**`gen` derives from the effective preset, not from "did the immediately previous open
differ".** A session remembers every preset it has ever detected with and the `gen` each one
was first assigned, so returning to a preset already used returns to that preset's own
generation rather than minting a new one: `noisy` (gen 1) → `clean` (gen 2) → `noisy` again
reads gen **1**, not gen 3. Before this, three opens in that sequence produced gen 1, 2, 3 even
though the third open's blocks were byte-identical to the first's — same source, same
threshold, same silences — and a caller holding a `b`-ref from the first open saw it rejected
by name on the third despite nothing about the recording having changed.

Those silences are what `open` turns into **refs**: the speech blocks between them, numbered
`b001`, `b002`, ... in time order. A ref names a block the way a browser snapshot names an
element — something later verbs point at instead of a raw millisecond pair. Refs derive from
`detect`'s silence list, never from `vcut silences` (a different, caller-chosen resolution), and
a ref from a `gen` the session is not currently at describes boundaries the session no longer
resolves against — even if that same `gen` was correct a moment ago and will be correct again
after another `open`.

`--transcript` caches a copy of the SRT into the session and points the cached detect report's
own `transcript.path` at that session copy, so every later reader of `cachedDetect` — `commit`,
a hand-inspected `detect.json` — gets a path guaranteed to still resolve rather than whatever
external path this call happened to be given (which can move or be deleted after `open`
returns). Without `--transcript`, `open` still works — refs come from silences, not words —
and the output says a semantic pass will need one before it can run.

**This is the map, not the read.** `open`'s output reports counts: duration, preset, gen,
silence count, block count, whether a transcript is cached, and the top 10 suspects (same
ranking as `suspects`, each with the block ref nearest it) — never any spoken text. Reading
what is actually said at a ref is `peek`; cutting against refs (`cut`) and committing a
session to a render (`commit`) are later still. `open` only opens the session and draws the
map.
