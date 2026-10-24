# Backup & Restore — FlowPilot AI

Local dev database is SQLite (`prisma/dev.db`, via `DATABASE_URL`). There is no
managed backup service in this setup — backups are file copies you make
yourself. Follow this runbook.

## What to back up

| Item | Path | Why |
|---|---|---|
| SQLite database | `prisma/dev.db` (+ `prisma/dev.db-journal` if present) | All workspaces, contacts, workflows, events, credentials (encrypted) |
| Environment file | `.env` | Secrets and provider config — **never commit, never share** |
| Uploaded media (if any) | `~/workspace/user/media_library/` | User uploads referenced by the app |

The Prisma schema (`prisma/schema.prisma`) is versioned with the code — you do
not need to back it up separately, but note which code version a backup belongs
to (see `version` in `package.json`, also reported by `GET /api/health`).

## Backup procedure (SQLite file copy)

SQLite is a single file. The only safe way to copy it is when no writer is
active — stop the dev server first, or use the SQLite backup API.

**Option A — server stopped (simplest, recommended):**
```bash
# 1. Stop the dev server (see RECOVERY.md for how to find/kill it)
# 2. Copy with a timestamp:
cp prisma/dev.db "backups/dev-$(date +%F_%H%M%S).db"
```

**Option B — hot backup while running (SQLite online backup):**
```bash
sqlite3 prisma/dev.db ".backup 'backups/dev-$(date +%F_%H%M%S).db'"
```
This is transactionally consistent even while the server runs. Plain `cp` on a
live database can produce a corrupt copy — do not do that.

Store backups outside the repo working tree (e.g. `~/workspace/flowpilot-backups/`)
so a `git clean` or archive rebuild can never delete them.

## Restore — test steps

Restoring is replacing the live file. **Test every restore on a copy first.**

```bash
# 1. Stop the dev server.
# 2. Keep the current file as a safety copy:
cp prisma/dev.db "backups/dev-before-restore-$(date +%F_%H%M%S).db"
# 3. Put the backup in place:
cp "backups/<chosen-backup>.db" prisma/dev.db
# 4. Verify integrity:
sqlite3 prisma/dev.db "PRAGMA integrity_check;"
#    → must print: ok
# 5. Sanity-check row counts against what you expect:
sqlite3 prisma/dev.db "SELECT 'workspaces', COUNT(*) FROM Workspace UNION ALL SELECT 'contacts', COUNT(*) FROM Contact;"
# 6. Start the dev server and hit GET /api/health → { ok: true, db: "up" }.
# 7. Log in and spot-check the workspace that matters.
```

If `PRAGMA integrity_check` prints anything other than `ok`, do not use that
file — pick an older backup.

### Restore test (do this monthly)

A backup you have never restored is a hope, not a backup. Once a month:

1. Copy the newest backup to `/tmp/restore-test.db`.
2. Point a scratch copy at it: `DATABASE_URL="file:/tmp/restore-test.db" npx prisma db push --skip-generate`
   (validates the schema still applies cleanly).
3. Run `PRAGMA integrity_check` and the row-count sanity queries above.
4. Delete `/tmp/restore-test.db`.

## Retention guidance

- **Daily** automated copy (cron) → keep 7.
- **Weekly** copy → keep 4.
- **Before every upgrade or schema change** → keep 1 labeled copy (`pre-<version>-<date>.db`).
- Prune anything older than 30 days unless it is a labeled pre-upgrade copy.

Example cron (runs daily at 03:00, keeps 7):
```cron
0 3 * * * sqlite3 /home/hatch/workspace/flowpilot/prisma/dev.db ".backup '/home/hatch/workspace/flowpilot-backups/dev-$(date +\%F).db'" && ls -t /home/hatch/workspace/flowpilot-backups/dev-*.db | tail -n +8 | xargs -r rm
```

## Migration-safety notes

- This project has **no Prisma migrations directory** — schema changes are
  applied with `prisma db push`. That is fine for local dev, but `db push`
  can destroy data if the change is destructive.
- **Before any `prisma db push`:**
  1. Take a labeled backup (see above).
  2. Make sure the schema diff is **additive only**: new models, new optional
     fields, new indexes. Renames, dropped columns/tables, and changed types
     are destructive — they need a planned migration, not a push.
  3. Run `npx prisma validate` first; run `npx tsc --noEmit` after generate.
- **Never** run `prisma db push --accept-data-loss` or `prisma migrate reset`
  against a database with real data. Those commands are for throwaway test
  databases only (the test suite uses its own `test.db`, rebuilt per run).
- The Phase 4 `OnboardingProgress` model was added additively (new table,
  two new relation fields) — a plain `npx prisma db push` applies it with no
  data loss.
