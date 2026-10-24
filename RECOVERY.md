# Recovery & Operations — FlowPilot AI

## Restart procedures

### Dev server (local)

The dev server runs with `npx next dev -p 3100` from `~/workspace/flowpilot`
(JOE's Windows machine uses its own port — see his local run steps; the
procedure below is for this Linux environment).

**Find it:**
```bash
ss -ltn | grep 3100
ps aux | grep "next-server" | grep -v grep
```

**Stop it — read this first:** never `pkill -f "next dev -p 3100"`: the pattern
matches your own shell command line and SIGTERMs your exec session. Prefer:
```bash
pkill -f "next-server"          # kills the Next worker, not your shell
# or kill by PID from the ps output above
```
Then confirm the port is free: `ss -ltn | grep 3100` (empty = free).

**Start it:**
```bash
cd ~/workspace/flowpilot
rm -rf .next   # if static assets 404 after a crash — stale dev cache
nohup npx next dev -p 3100 > /tmp/nextdev.log 2>&1 & disown
```

**Never run `npm run build` while `next dev` is running** — it corrupts the dev
`.next` cache. Stop dev → build → restart with a fresh `.next`.

### Production (`next start`)

```bash
cd ~/workspace/flowpilot
npm run build        # runs `prisma generate && next build`
npx next start -p 3100
```
`npm run build` regenerates the Prisma client first, so deploys pick up schema
changes automatically.

### Database down

`GET /api/health` returns `{ ok: false, db: "down", … }` with HTTP 503 when the
database is unreachable. Steps:

1. Check the file exists and is readable: `ls -la prisma/dev.db`.
2. Run `sqlite3 prisma/dev.db "PRAGMA integrity_check;"` — anything other than
   `ok` means corruption → restore from backup (BACKUP_RESTORE.md).
3. Check `DATABASE_URL` in `.env` points at the right file (never commit `.env`).
4. Restart the server. If it still fails, capture the startup log — the Prisma
   error message names the exact problem.

## Health endpoint

`GET /api/health` — public (no auth, by design for load-balancer probes):

```json
{ "ok": true, "version": "0.1.0", "db": "up", "uptime": 1234 }
```

- `db: "down"` + HTTP 503 → database unreachable (see above).
- `version` mirrors `package.json`.
- `uptime` is process uptime in seconds — useful to confirm a restart took effect.
- Nothing secret is ever returned here (verified by test: response body is
  asserted to contain no token/secret/password/credential strings).

## Logging standards (structured logging check)

There is no log-aggregation library in this codebase; server code logs with
`console.*`. The rule, enforced by review and by the `check:logs` script, is:

- **Allowed in logs:** event names, HTTP status codes, redacted body previews,
  entity ids, timestamps, durations.
- **Never in logs:** access/refresh tokens, app secrets, passwords or hashes,
  cookies, authorization codes, full OAuth state values, raw webhook payloads
  containing credentials.

Existing examples of the safe pattern: `[auth] failed login: email="…" userFound=…
passwordValid=…` (email only), `[instagram-login]` lines (HTTP status +
sanitized body preview, secrets redacted, URLs stripped of query params).

**Run the check:**
```bash
npm run check:logs
```
It greps server-side `src/` for risky patterns (e.g. logging `accessToken`,
`password`, `clientSecret` values) and fails on matches. False positives are
fixed by renaming the variable or narrowing the grep, not by deleting the log
line's intent — when in doubt, log the id and the outcome, not the value.

## Background-job observability (`src/lib/queue.ts`)

Jobs run on the in-process durable queue: `enqueue(type, payload, opts)` with
retries, exponential backoff (`notBefore`), idempotency keys, and a dead-letter
list. Production is designed to swap `enqueue`/`startWorker` for BullMQ + Redis
behind the same interface.

How to observe it today:

| Question | How |
|---|---|
| Is the worker running? | `startWorker()` is called at server boot; look for its log line in the dev server output. No line = jobs enqueue but never execute. |
| What's queued / failing? | Add a temporary debug route or log: `queueDepth()`-style introspection isn't exposed over HTTP yet — check `deadLetters` via a REPL or add logging around `enqueue` for the job type you care about. |
| Why did a job die? | Dead letters keep `failedAt` + `lastError`. The last error is the provider's message verbatim — it names rate limits (429), auth failures (190), and validation rejections. |
| Did a duplicate fire? | Idempotency keys: `enqueue` returns `{ duplicate: true }` when the key was seen. Retargeting sends use `retargeting:<campaignId>:contact:<contactId>`; webhook ingest dedupes on `(workspaceId, providerEventId)`. |
| Rate-limited by a provider? | A 429 response is a hard stop for that provider in the current task — the job backs off instead of retrying hot. Do not manually re-enqueue; the backoff handles it. |

**Known limitation (honest):** the queue is in-memory in local dev — a server
restart drops pending jobs and dead letters. For anything that must survive
restarts, the BullMQ + Redis swap (documented in `src/lib/queue.ts` header) is
required before production use.

## Dependency health (`npm audit`)

Run `npm audit` before every release. Policy:

- Fix **only safe upgrades** (patch/minor within the declared range, or a
  targeted bump with a green `tsc` + full test suite + production build after).
- Do **not** break the build to silence an advisory: if the fix requires a
  major bump, document the advisory and the reason for deferring instead.
- The dated report lives next to this file: `NPM_AUDIT_<date>.md`.

## Incident checklist

1. `GET /api/health` — is it the app or the DB?
2. `PRAGMA integrity_check` on `prisma/dev.db` — corruption?
3. Dev server log (`/tmp/nextdev*.log`) — the last error before the failure.
4. Queue dead letters — did a background job die and take a flow with it?
5. If data loss is suspected: **stop writes first** (stop the server), then
   restore per BACKUP_RESTORE.md — restoring over a running writer risks a
   torn copy.
