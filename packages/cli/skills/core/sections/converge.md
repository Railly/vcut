## converge

```bash
vcut converge <media> --phrase "the wording that keeps recurring" --from <sec> --lang es
```

Where a repeated phrase stops coming back, which is the boundary of a retake. Steps a window
forward from `--from`, transcribing each one, and reports the first that no longer carries the
phrase along with every window it read getting there.

It exists because that judgement went wrong more often than any other: three runs cut the same
retake at 61000, 61020 and 61192ms, all about 1772ms short, and each had verified its number.
Every attempt at a retake says the same words, so a window opened anywhere inside one comes
back complete and convincing.

Matching is on the carrying words rather than the phrase as typed. A short window transcribes
without the context the rest of the file gives, so the same audio came back as "a la que
conocemos" in one window and "ahora que conocemos" in the next; comparing words of four letters
or more survives that, and separated cleanly on the case measured — 1.00 inside the retake,
0.00 past it.

`--to` bounds the search and defaults to twelve seconds past `--from`. A null `boundaryMs` with
exit 1 means the phrase was still recurring at the end of that span, which is a reason to widen
it rather than evidence there is nothing to cut.

**The boundary it reports is where the repetition ends, which is not where the telling you are
keeping begins.** Those differ, and cutting to the first is how you lose the opening of the
last attempt. On the recording above it answered 62000ms — past that the audio reads "ya
llegamos a mil miembros" — while the surviving segment starts at 61192ms and carries "Y a la
que conocemos, ya llegamos a mil miembros", the whole line. The last attempt begins before the
previous one has finished being recognisable.

So read the boundary as the far edge of what is safe to remove, then walk back to the start of
the final telling and end the cut there. `edl build` clamps to measured silence, which usually
lands it correctly, but the span you propose should already name the line you mean to keep
rather than the point where the words stopped repeating.

Both cuts were rendered and listened to. Ending at 61192ms keeps "Y a la que conocemos, ya
llegamos a mil miembros". Ending at 62000ms buys 0.7 seconds and leaves "Conocemos, ya llegamos
a mil miembros" — the line beheaded, and audibly wrong. Neither transcript reads as broken; the
difference only shows up in the ear, which is the reason the approval step is a human's.

**Two contract assumptions, both found on real stumbled speech (2026-08-10 run).** `converge`
steps forward from `--from` and reports the first window that lacks the phrase (`firstClear` in
the source, `probes.find((probe) => !probe.contains)`). That is only the boundary you want when
the retake is contiguous and the transcriber is stable window to window. Neither held on this
run.

- **`--from` starting outside the recurring wording returns an immediate false clear.** Probed
  from 84.0s, where the phrase occurred at 84.0-84.5s and was followed by discard babble
  ("perdón, crear, ok, eso no, básicamente era, ya") before the keeper attempt at 95s. The very
  first window past the original attempt already lacked the phrase, so `converge` stopped there:
  `boundaryMs` came back 84500 with `lastWithPhraseMs` at 84000. That looks exactly like an
  answer and is useless — the babble between the attempts is not the boundary, it is filler the
  loop still needs to name and cut on its own.
- **A flaky short-window transcription drops the phrase for one window and triggers an early
  first-clear.** Probing "agregar verificabilidad" from 204s, inside a quadruple retake, the
  204.5s window's transcript happened to omit the phrase — a transcription miss, not the phrase
  actually leaving — and `converge` stopped immediately, though the phrase recurs through 216s.
  `firstClear` has no notion of a false negative: one bad window ends the search the same as a
  clean one.

**Both share a cause: `converge`'s contract assumes contiguous retakes and stable
transcription.** It steps forward and trusts the first miss, whichever kind of miss it is. When
discard babble separates the attempts, or a short window is likely to drop a word it should have
kept, do not trust a single `converge` call. Use `silences` to see the shape of the gaps first,
then `say --transcribe` at the specific windows you need an anchor on — that is what resolved
both cases on the real run: `silences` showed where the babble sat apart from the attempts, and
windowed `say --transcribe` calls at the suspect offsets confirmed which window actually dropped
the phrase versus which one was past the retake for real.
