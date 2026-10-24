# FlowPilot AI

Multichannel AI automation & customer engagement SaaS platform.
*"Connect your channels. Automate your conversations. Turn engagement into customers."*

> **Phase 1–2 foundation.** Working app shell, auth, dashboard (demo-labeled data),
> visual workflow builder + execution engine, inbox, contacts, AI assistant config,
> integrations center with honest connection states, and automated tests.

## Stack

- **Next.js 14 (App Router)** + React 18 + TypeScript + Tailwind CSS
- **Prisma ORM** — SQLite for local dev (`file:./dev.db`), PostgreSQL for production
- **Auth** — bcrypt (12 rounds) + JWT in httpOnly cookie
- **Workflow builder** — `@xyflow/react`
- **Queue** — in-memory durable queue (dev); BullMQ+Redis interface for prod (`src/lib/queue.ts`)
- **AI** — provider abstraction (`src/lib/ai/providers.ts`); `mock` by default, OpenAI-compatible optional

## Quick start

```bash
cp .env.example .env
# edit .env: set JWT_SECRET and (for encrypted credentials) ENCRYPTION_KEY
npm install
npx prisma db push        # create SQLite tables
npm run dev               # http://localhost:3000
```

Then open the app, **sign up** — a personal organization + workspace is created
automatically and demo data is seeded (clearly labeled "Demo data").

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start dev server |
| `npm run build` | `prisma generate && next build` |
| `npm start` | Start production server |
| `npm test` | Run vitest suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npx prisma db push` | Apply schema to `DATABASE_URL` |
| `npx prisma studio` | Browse the database |

### Updating an existing install (safe upgrade)

New releases ship as a ZIP containing a **seeded demo database** (`prisma/dev.db`)
and `.env.example` — never your data. Follow these steps so nothing is lost:

```bash
# 1. Back up your database and environment FIRST:
cp prisma/dev.db "backups/dev-$(date +%F_%H%M%S).db"
cp .env "backups/env-$(date +%F_%H%M%S).bak"

# 2. Extract the new ZIP over your project folder, then RESTORE your files:
#    (your .env and prisma/dev.db must win over the archive's copies)

# 3. Install + apply schema changes (additive only — never drops your data):
npm install
npx prisma db push

# 4. Restart the dev server.
```

Safety facts:

- `npm install` / `npm ci` never touch the database.
- `npx prisma db push` applies **additive** schema changes (new tables/columns).
  It never deletes your rows. Back up first anyway (see `BACKUP_RESTORE.md`).
- `npm run db:seed` **skips entirely** if the demo user already exists.
- `npx tsx src/db/seed-plans.ts` **upserts** plans by name — re-running is safe.
- Never run `prisma migrate reset` or delete `prisma/dev.db` unless you intend
  to throw away all local data.
- Full backup/restore runbook: `BACKUP_RESTORE.md`. Recovery steps: `RECOVERY.md`.

## Environment

See `.env.example`. Key variables:

- `DATABASE_URL` — `file:./dev.db` locally; Postgres URL in production
- `JWT_SECRET` — **required**, `openssl rand -base64 32`
- `ENCRYPTION_KEY` — 32-byte hex for AES-256-GCM credential encryption (`openssl rand -hex 32`)
- `DEMO_MODE=true` — seed labeled demo data for new workspaces
- `AI_PROVIDER=mock` — or `openai` with `OPENAI_API_KEY`
- `WEBHOOK_SECRET` — optional HMAC secret for webhook verification

No secrets are hardcoded. `.env` is gitignored; only `.env.example` ships.

## Project layout

```
prisma/schema.prisma      # models: users, workspaces, memberships, integrations,
                          # contacts, conversations, messages, workflows (+nodes/edges),
                          # executions (+steps), campaigns, AI config, knowledge, audit…
src/app/                  # App Router: landing, auth, /app/* workspace sections
src/components/           # design system (Button, Card, Input, Badge, Sidebar, Topbar…)
src/lib/                  # auth, db, tenancy, crypto, queue, audit, api helpers
src/lib/integrations/     # ChannelAdapter interface + provider catalog + mock adapter
src/lib/ai/               # AI provider abstraction (mock / OpenAI-compatible)
src/lib/workflows/        # validateWorkflow, execution engine, node registry
src/workflows/templates/ # 15 ready-made automation templates (JSON)
src/app/api/              # route handlers — all tenant-scoped + Zod-validated
```

## Honesty rules (enforced in code)

1. An integration is **never** labeled `CONNECTED` unless `verify()` succeeded.
   Statuses: `DEMO` · `CONNECTED` · `NEEDS_ATTENTION` · `EXPIRED` · `DISCONNECTED`.
2. The mock adapter's `sendMessage` returns `{ mocked: true, externalId: null }` —
   nothing ever claims a real external send.
3. Dashboard metrics computed from seeded data are labeled **"Demo data"**.
4. Webhooks verify signatures when `WEBHOOK_SECRET` is set and reject replayed
   event IDs.

## Production notes

- Switch Prisma datasource to `postgresql` and run `prisma migrate deploy`.
- Set `ENCRYPTION_KEY`, `JWT_SECRET`, `WEBHOOK_SECRET` via your secret manager.
- Replace the in-memory queue with BullMQ+Redis behind `src/lib/queue.ts`.
- Add real provider adapters implementing `ChannelAdapter` (OAuth + webhooks);
  the mock adapter is only for dev/tests.
- Put the app behind TLS; cookies are `Secure` in production.

## Next steps (Phase 3+)

Real channel OAuth, website chat widget snippet, campaign sending with
consent/audience eligibility enforcement, team invites, Stripe billing,
Redis-backed queue workers, semantic knowledge search.
