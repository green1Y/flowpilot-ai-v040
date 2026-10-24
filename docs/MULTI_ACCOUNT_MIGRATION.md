# Multi-Account Migration & Recovery (Batch B)

**What changed, how it was applied, how to verify it, and how to recover
from a failed migration — using only non-destructive steps.**

## What changed

FlowPilot previously allowed **one** connected account per provider per
workspace (`Integration @@unique([workspaceId, provider])`), so connecting
a second WhatsApp number / Instagram account / Facebook Page overwrote
the first account's credentials. Batch B moves to the selected
architecture: **multiple connected accounts within one workspace**.

Schema changes (all additive except the uniqueness swap):

| Change | Detail |
|---|---|
| `Integration` uniqueness | `@@unique([workspaceId, provider])` → `@@unique([workspaceId, provider, externalAccountId])` — one row per *account*, not per provider |
| `Integration.isDefault` | New, `Boolean @default(false)` — the deterministic default account per (workspace, provider) |
| `Conversation.integrationId` | New, nullable — the exact account a conversation belongs to |
| `OutboundSend.integrationId` | New, nullable — the exact account a send went through (null = mock/demo path) |
| `CustomerEvent.integrationId` | New, nullable — the account an event came through / went out on |
| `WorkflowExecution.integrationId` | New, nullable — the account an execution is scoped to |
| `Plan.connectedAccountLimit` | New, `Int @default(3)` — seeded Starter 3 / Growth 10 / Agency 50, enforced at connect time (402 `PLAN_LIMIT_EXCEEDED`) |

No columns were removed, no rows were deleted, and no credential values
were read, printed, or rewritten by the migration.

**SQLite note:** a unique index treats rows with `NULL` in a key column as
distinct, so legacy placeholder/demo rows (`externalAccountId = NULL`)
never collide under the new key — they survive untouched.

## How the migration was applied (2026-10-20)

1. **Backup first.** A timestamped copy of the live database was taken
   *before* any schema change and validated:
   - `prisma/dev.db.bak-batchB-20261020105428` (SQLite `PRAGMA integrity_check` → `ok`, same result for the live DB).
2. **Pre-migration inspection (counts only — no credential contents):**
   - `dev.db`: 60 Integration rows across 5 workspaces × 12 providers; 59 `DEMO` + 1 `CONNECTED`; `externalAccountId` set on 0 rows, null on 60; encrypted credentials present on 1 row.
   - `test.db`: 3,086 rows (test-suite residue; the suite recreates this DB from the schema on every run).
   - Duplicate `(workspaceId, provider, externalAccountId)` triples with a non-null external id: **0** in both databases → the new unique index could not conflict.
   - Credential integrity fingerprint (SHA-256 over `id + encryptedCredentials`, ordered by id): `fdaf9c1af8b155ce2bf2d3e4b96946ad817b47642548e1506af271abadeb2213`.
3. **Apply:** `npx prisma db push` (no `--accept-data-loss`, no reset).
4. **Post-migration verification:**
   - Row count unchanged: 60 → 60.
   - Credential integrity fingerprint **identical** before/after: `fdaf9c1af8b155ce2bf2d3e4b96946ad817b47642548e1506af271abadeb2213` → every account row and its encrypted credentials survived byte-identical.
   - New index present: `Integration_workspaceId_provider_externalAccountId_key`; `PRAGMA integrity_check` → `ok`.

## How to verify success on any install

```sql
-- Row + credential survival (compare against your pre-migration counts)
SELECT COUNT(*) FROM Integration;
SELECT COUNT(*) FROM Integration WHERE encryptedCredentials IS NOT NULL;

-- New shape present
SELECT name FROM sqlite_master
 WHERE type = 'index' AND name = 'Integration_workspaceId_provider_externalAccountId_key';

-- No accidental duplicate accounts
SELECT workspaceId, provider, externalAccountId, COUNT(*) AS c
  FROM Integration
 WHERE externalAccountId IS NOT NULL
 GROUP BY 1, 2, 3 HAVING c > 1;   -- expect: no rows
```

## Failed-migration recovery (non-destructive)

If `prisma db push` fails partway or the app misbehaves after migrating:

1. **Stop the app** (dev server / workers) so nothing writes to the DB.
2. **Preserve the failed state for diagnosis** — do not delete it:
   `cp prisma/dev.db prisma/dev.db.failed-batchB-<timestamp>`
3. **Restore the pre-migration backup** taken in step 1 of the apply
   procedure (this is a file copy, not a database reset — it restores the
   exact pre-migration rows, including all credentials):
   `cp prisma/dev.db.bak-batchB-<timestamp> prisma/dev.db`
4. **Revert the code** to the pre-Batch-B commit (`git revert` / checkout
   of the Batch B commit) so the old schema and the restored DB match,
   then `npx prisma generate`.
5. Restart the app and confirm the Integrations page loads and existing
   accounts still show their previous statuses.

Never run `prisma migrate reset`, `prisma db push --accept-data-loss`,
or delete Integration rows as a "fix" — every account's encrypted
credentials live in those rows and are not recoverable from anywhere
else.

## Behavior after migration (explicit routing rules)

- Inbound events are stamped with the exact account that received them
  (`Conversation.integrationId`, `CustomerEvent.integrationId`), matched
  by provider asset id + credential confirmation. If account identity is
  ambiguous (multiple same-provider accounts match one event and none is
  credential-confirmed), the event is **not** ingested into a guessed
  account — it is skipped with a diagnostic log (counts/ids only).
- Workflow executions retain the trigger's account
  (`WorkflowExecution.integrationId`). A node may pin an account
  (`integrationId` in the node config); a reply otherwise leaves through
  the account the conversation arrived on. Sends with no pin resolve to
  the workspace's **default** account for the channel, or the single
  connected account; if several accounts are connected and none is the
  default, the send **fails with an "ambiguous account" error** instead
  of silently using whichever row a query returned first.
- Two accounts of the same provider in one workspace keep fully separate
  credentials; connecting account B never modifies account A's row.
