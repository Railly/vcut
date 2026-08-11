## session

```bash
vcut session list
vcut session gc
vcut session gc --apply
vcut session gc --older-than 14 --apply
```

`list` shows every session under `~/.vcut/sessions/`: its source path and whether that source
file still exists, size on disk, when it was created, how many rounds it has committed, and
whether a live process currently holds its advisory lock right now.

```
sessions  1
  3598be07ca334db2       source ok  0.25MB  2 round(s)
                         /Users/name/Documents/recording.mp4
```

`gc` classifies every session against the reasons it could be cleared, **without deleting
anything unless `--apply` is also given** — dry-run is the default behaviour, not a flag you
have to remember to add. A session is a candidate when:

- **`orphan`** — its source file no longer exists (moved, renamed, deleted).
- **`committed`** — at least one `commit` ran successfully against it. The spike's B7-Q2 rule
  in one sentence: a successful commit is what marks a session disposable, and nothing marks it
  automatically before that.
- **`older-than`** — only when `--older-than <days>` is passed; omitted, age alone never
  qualifies a session. There is no default threshold to guess at here.

A session a live process currently holds the **lock** on is always `locked-protected` and
**never deletable**, whatever else is true of it — `gc` racing a `cut` or `commit` in progress
would delete state out from under a real write, which is exactly the failure mode the lock
exists to prevent.

```
gc dry-run  1 of 3 session(s) would go
  a1b2c3d4e5f60718        orphan  0.31MB  would delete
  3598be07ca334db2        (none)  0.25MB  protected

  Next:
    vcut session gc --apply
```

**The EDL a human approved is never at risk.** `commit` writes it wherever `--output`/`--edl`
pointed — the current directory by default, never inside a session directory `gc` manages — so
clearing a whole session directory can only ever remove the disposable detect cache, transcript
copy, refs, proposals, and round history behind it. This is the same guarantee `session.ts`'s
own header comment states from the writer's side, restated here from the reader's: `session gc`
cannot eat an approved edit by construction, not by care taken at call time.

### Advisory lock

`cut`'s mutating paths (propose, `--drop`) and `commit` take the session's advisory lock before
writing and release it in a `finally`, so it clears even when the write itself fails. Readers —
`open`, `peek`, `cut --list`, `rounds` — never lock, per the spike's B7-Q1 resolution: locking a
read would block a second agent from merely looking at a session another agent is actively
writing to, which is a cost this arc has no reason to pay.

The lock lives at `lock.json` inside the session: `{ pid, startedAt, verb }`. A second writer
finding a lock whose pid is still alive gets refused with an error naming that pid, the verb it
is running, and how long ago it started — enough for a human or another agent to decide whether
to wait or investigate. A lock whose pid is no longer alive (the process that held it crashed,
was killed, or the machine restarted) is stale, and clears itself automatically the next time
anyone attempts to acquire it — nobody has to notice a stale lock and delete `lock.json` by
hand for the session to become writable again.

This is deliberately not a kernel-level lock (`flock`/`fcntl`). It is a courtesy between
cooperating writers — two agents, or an agent and a human, sharing one session — and honest
about the gap that leaves: two writers racing the exact same instant could both pass the check
before either writes `lock.json`. That gap is not the failure mode B7-Q1 was written against
(the real case is one writer actively working a session while a second one starts later), and
closing it would need a kernel primitive this store does not use.

`open` writing `--transcript` and `open`'s own re-detect on a new preset never lock: they are
read/derive operations from the session's own model (B7-Q1 says readers never lock), even
though `open` does write `detect.json` and `refs.json`. Those writes are idempotent derivations
of the source file's own bytes — running `open` twice with the same preset produces byte-identical
detect and refs output, so two concurrent `open` calls racing each other converge on the same
answer rather than corrupting anything, which is a different guarantee than "two proposals
racing each other must not interleave into `proposals.json`". If a real corruption path from a
concurrent `open` ever surfaces (a partial write of `detect.json` observed mid-write by a second
reader, say), that would be the trigger to lock it too — none has been found, so it stays
lockless per B7-Q1's letter and its actual reasoning.
