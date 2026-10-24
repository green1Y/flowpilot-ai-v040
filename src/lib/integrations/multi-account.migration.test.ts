/**
 * Batch B — migration test (acceptance criterion 7).
 *
 * Builds a scratch database with the PRE-Batch-B schema (taken verbatim
 * from git commit a7819b3, the last pre-Batch-B commit), seeds it with
 * rows in the old shape — including a legacy CONNECTED row whose account
 * identity lives only in its credentials (externalAccountId NULL) and a
 * DEMO placeholder row (externalAccountId NULL) — proves the old
 * (workspaceId, provider) unique constraint really governed that fixture,
 * then applies the NEW schema with the project's own mechanism
 * (`prisma db push`) and asserts:
 *   - every row survives, byte-identical (ids, statuses, external ids,
 *     and the encryptedCredentials strings exactly as seeded);
 *   - the new compound unique index exists;
 *   - Integration.isDefault exists and defaults to 0;
 *   - PRAGMA integrity_check is ok.
 *
 * Recovery from a failed migration is documented (non-destructive steps
 * only) in docs/MULTI_ACCOUNT_MIGRATION.md.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PRE_BATCH_B_COMMIT = "a7819b3";

function run(cmd: string, env?: Record<string, string>): string {
  return execSync(cmd, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sqlite(dbPath: string, sql: string): string {
  return run(`sqlite3 "${dbPath}" "${sql.replace(/"/g, '\\"')}"`);
}

describe("multi-account schema migration (old → new, scratch DB)", () => {
  it(
    "preserves every Integration row and credential byte-identical",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "fp-mig-"));
      const dbPath = join(dir, "mig.db");
      const dbUrl = `file:${dbPath}`;

      // 1) Old schema, verbatim from the pre-Batch-B commit.
      const oldSchema = run(
        `git show ${PRE_BATCH_B_COMMIT}:prisma/schema.prisma`
      );
      expect(oldSchema).toContain("@@unique([workspaceId, provider])");
      const oldSchemaPath = join(dir, "old-schema.prisma");
      writeFileSync(oldSchemaPath, oldSchema);
      run(`npx prisma db push --schema "${oldSchemaPath}" --skip-generate`, {
        DATABASE_URL: dbUrl,
      });

      // 2) Seed old-shape rows.
      const ts = "2026-10-20T00:00:00.000Z";
      sqlite(
        dbPath,
        `INSERT INTO Organization (id, name, createdAt) VALUES ('org-mig', 'Mig Org', '${ts}');` +
          `INSERT INTO Workspace (id, orgId, name, slug, brandColor, plan, planId, isDemo, createdAt) VALUES ('ws-mig', 'org-mig', 'Mig WS', 'mig-ws', '#8B5CF6', 'STARTER', NULL, 0, '${ts}');` +
          // Legacy CONNECTED row: identity only in credentials, external id NULL.
          `INSERT INTO Integration (id, workspaceId, provider, status, encryptedCredentials, statusDetail, externalAccountId, accountName, accountAvatarUrl, capabilities, limitations, requiredPermissions, lastSyncAt, verifiedAt, lastError, lastErrorAt, createdAt) VALUES ('int-ig-legacy', 'ws-mig', 'instagram', 'CONNECTED', 'cipher-legacy-A', NULL, NULL, 'Legacy IG', NULL, '[]', '[]', '[]', NULL, '${ts}', NULL, NULL, '${ts}');` +
          // DEMO placeholder row, external id NULL, no credentials.
          `INSERT INTO Integration (id, workspaceId, provider, status, encryptedCredentials, statusDetail, externalAccountId, accountName, accountAvatarUrl, capabilities, limitations, requiredPermissions, lastSyncAt, verifiedAt, lastError, lastErrorAt, createdAt) VALUES ('int-wa-demo', 'ws-mig', 'whatsapp', 'DEMO', NULL, NULL, NULL, NULL, NULL, '[]', '[]', '[]', NULL, NULL, NULL, NULL, '${ts}');` +
          // CONNECTED row with a provider identity.
          `INSERT INTO Integration (id, workspaceId, provider, status, encryptedCredentials, statusDetail, externalAccountId, accountName, accountAvatarUrl, capabilities, limitations, requiredPermissions, lastSyncAt, verifiedAt, lastError, lastErrorAt, createdAt) VALUES ('int-fb-page', 'ws-mig', 'facebook', 'CONNECTED', 'cipher-page-C', NULL, 'page-123', 'FB Page', NULL, '[]', '[]', '[]', NULL, '${ts}', NULL, NULL, '${ts}');`
      );

      // 3) The OLD constraint really governed this fixture: a second
      //    whatsapp row for the workspace is rejected pre-migration.
      expect(() =>
        sqlite(
          dbPath,
          `INSERT INTO Integration (id, workspaceId, provider, status, encryptedCredentials, statusDetail, externalAccountId, accountName, accountAvatarUrl, capabilities, limitations, requiredPermissions, lastSyncAt, verifiedAt, lastError, lastErrorAt, createdAt) VALUES ('int-wa-second', 'ws-mig', 'whatsapp', 'CONNECTED', 'cipher-second', NULL, 'pnid-2', NULL, NULL, '[]', '[]', '[]', NULL, NULL, NULL, NULL, '${ts}');`
        )
      ).toThrow();

      const before = sqlite(
        dbPath,
        `SELECT id || '|' || provider || '|' || status || '|' || COALESCE(externalAccountId, '<null>') || '|' || COALESCE(encryptedCredentials, '<null>') FROM Integration ORDER BY id;`
      );
      expect(before.trim().split("\n")).toHaveLength(3);

      // 4) Apply the NEW schema with the project's own push mechanism.
      run(`npx prisma db push --schema "${join(process.cwd(), "prisma", "schema.prisma")}" --skip-generate`, {
        DATABASE_URL: dbUrl,
      });

      // 5) Everything survived, byte-identical.
      const after = sqlite(
        dbPath,
        `SELECT id || '|' || provider || '|' || status || '|' || COALESCE(externalAccountId, '<null>') || '|' || COALESCE(encryptedCredentials, '<null>') FROM Integration ORDER BY id;`
      );
      expect(after).toBe(before);

      // New shape: compound unique index + isDefault defaulting to 0.
      const idx = sqlite(
        dbPath,
        `SELECT name FROM sqlite_master WHERE type='index' AND name='Integration_workspaceId_provider_externalAccountId_key';`
      );
      expect(idx).toContain("Integration_workspaceId_provider_externalAccountId_key");
      const defaults = sqlite(dbPath, `SELECT COUNT(*) FROM Integration WHERE isDefault = 0;`);
      expect(defaults.trim()).toBe("3");
      expect(sqlite(dbPath, `PRAGMA integrity_check;`)).toContain("ok");

      // And the new capability works: a second WhatsApp account row (with
      // a distinct provider identity) now inserts cleanly.
      sqlite(
        dbPath,
        `INSERT INTO Integration (id, workspaceId, provider, status, encryptedCredentials, externalAccountId, capabilities, limitations, requiredPermissions, createdAt) VALUES ('int-wa-second', 'ws-mig', 'whatsapp', 'CONNECTED', 'cipher-second', 'pnid-2', '[]', '[]', '[]', '${ts}');`
      );
      const count = sqlite(dbPath, `SELECT COUNT(*) FROM Integration WHERE workspaceId = 'ws-mig';`);
      expect(count.trim()).toBe("4");
    },
    180_000
  );
});
