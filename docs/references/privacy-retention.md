# Face-video privacy and retention

## Purpose

Prevent a faster recording workflow from accumulating exposed secrets, untracked consent, or indefinite raw-media debt.

## Privacy gates

Before recording:

- choose private, shared, or public environment
- enable Do Not Disturb
- use a clean browser profile for screen proof
- hide tokens, emails, account identifiers, customer data, private messages, local paths, and confidential work
- declare whether another person is incidental or participating
- block the session when required consent is unresolved

After ingest:

- inspect screen contact sheets
- search transcript text for named sensitive terms
- review the preview frame by frame around notifications, tab switches, terminals, and account menus
- record disclosure risks without copying the sensitive value into the manifest

Do not write a secret into a warning receipt. Record the category, source ID, and time interval.

## Consent

When no other person appears, use `not-required`.

When another person is incidental or participating:

- preserve `pending` or `blocked` when consent is unresolved
- block external packaging and session review while unresolved
- require `recorded` before the session reaches `reviewed` or `closed`
- preserve at least one consent receipt path
- do not infer consent from presence or prior collaboration
- stop external packaging when consent becomes disputed

The receipt records the workflow decision. It does not replace jurisdiction-specific legal review when needed.

## Raw retention

Choose one policy per session:

- `retain-until-campaign-closed`
- `retain-until-date`
- `retain-manually`

Raw media is never deleted merely because a master rendered successfully.

Before deletion:

1. Verify the approved master, transcript, EDL, captions, and publication receipts remain readable.
2. Confirm no campaign, correction, rights, or dispute hold exists.
3. Resolve the exact raw paths from the session manifest.
4. Present the deletion set for the owner's approval.
5. Prefer a recoverable trash operation when the volume supports it.
6. Record a deletion receipt after the operation.

Use `held` with a reason when deletion must pause.

## Session closure

A session can become `reviewed` or `closed` only when:

- screen privacy review passed
- preview privacy review passed
- consent state is valid
- every retained source has a path and SHA-256
- retention policy is explicit
- unresolved disclosure risks block the affected destination

## Resume

Privacy review is tied to the source and preview hashes.

- New screen media invalidates screen and preview privacy review.
- A changed EDL invalidates preview privacy review.
- A caption-only change does not invalidate screen privacy review but still requires caption QA.
- A new destination package requires its own native preview and disclosure check.
