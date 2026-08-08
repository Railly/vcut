# Accessible clean-master contract

Last verified: 2026-07-23

## Principle

Accessibility is a delivery requirement, not a claimed ranking boost.

The master package should preserve enough structure for each platform to choose closed captions, native captions, or a burned derivative without retranscribing the story.

## Required outputs

When speech exists, produce:

- corrected readable transcript
- timed word or phrase data
- UTF-8 SRT
- structured caption JSON
- captioned derivative when requested

Preserve the raw provider output and every approved correction.

## Text quality

Captions must:

- match the spoken claim
- preserve negations and caveats
- spell technical names correctly
- identify meaningful non-speech audio when needed
- use readable phrase boundaries
- remain ordered and within duration

Do not compress captions by deleting meaning.

W3C states that automatic captions are not sufficient unless confirmed fully accurate. Use them as a starting point, not a completed accessibility artifact.

Source:

- https://www.w3.org/WAI/media/av/captions/

## Readability diagnostics

Measure:

- cue duration
- characters per second
- characters per line
- line count
- overlap
- tail coverage
- technical-term corrections

Use initial warning thresholds:

- more than 20 characters per second
- more than 42 characters per line
- more than two lines

These are adjustable production defaults, not platform-ranking rules or universal language standards. Warnings require review; they do not automatically delete words or extend a cue beyond the spoken interval.

The real long-form fixture had valid timing and corrected terms but 77 of 109 cues longer than 42 characters and 16 above 20 characters per second. This demonstrates why transcript correction and caption segmentation are separate stages.

## Visual quality

Essential meaning should not depend only on:

- color
- audio
- a platform UI label
- tiny terminal text
- a fast single-frame receipt

Proof assets need enough size and duration to be read.

## Native versus burned captions

Prefer native closed captions when:

- the platform supports a reviewed caption file
- the viewer should be able to toggle or style captions
- translated tracks matter

Use a burned derivative when:

- native captions are unavailable or unreliable
- the intended visual treatment is part of the format
- the platform package explicitly selects it

Keep both when uncertainty is material.

## Dub-ready master

Preserve:

- original language
- corrected transcript
- approved technical-term dictionary
- clear separation between speakers
- warnings for unusually fast speech
- original audio without destination music

Automatic dubbing remains a destination decision. YouTube warns that language detection, fast speech, proper nouns, jargon, accents, background noise, and copyrighted content can cause errors or make a video ineligible. The destination package must review the dub before publication.

Source:

- https://support.google.com/youtube/answer/15569972?hl=en-EN

## Platform notes

### LinkedIn

- Supports an attached SRT on desktop.
- Supports auto-captions with an option to review before viewers see them.
- Warns creators to keep essential elements away from all edges.
- Full-screen vertical playback can crop depending on device and source aspect ratio.

Sources:

- https://www.linkedin.com/help/linkedin/answer/a552177/add-closed-captions-to-videos-on-linkedin?lang=en
- https://www.linkedin.com/help/linkedin/answer/a1327025
- https://www.linkedin.com/help/linkedin/answer/a7174587
- https://www.linkedin.com/help/linkedin/answer/a6828545

### Instagram Reels

- Exposes closed-caption controls for Reels in the mobile app.
- Validate the selected caption surface in the current account.

Source:

- https://www.facebook.com/help/instagram/225479678901832?locale=en_GB

### TikTok

- TikTok Studio exposes caption, cover, and copyright-check controls.
- Feature availability varies by region and app or web surface.

Source:

- https://support.tiktok.com/en/using-tiktok/creating-videos/creator-tools-on-tiktok

### YouTube Shorts

- Supports UTF-8 SRT and other timed-caption formats.
- Advises reviewing automatic captions.
- Native visual guides show interface-covered areas.

Sources:

- https://support.google.com/youtube/answer/2734698?hl=en
- https://support.google.com/youtube/answer/6373554?hl=en
- https://support.google.com/youtube/answer/16215842?hl=en-MP

## QA

Fail the caption package when:

- a cue begins before zero
- cues overlap unintentionally
- a cue ends after the master
- a technical name is unresolved
- the spoken and captioned claim differ
- essential proof is covered

Native preview remains required because UI geometry can change.
