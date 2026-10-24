/**
 * Demo seed: `npm run db:seed` (tsx prisma/seed.ts).
 *
 * Creates a demo user + organization + workspace and fills it with
 * clearly-labeled demo data via ensureDemoData. Skips entirely if the demo
 * user already exists.
 */
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { db } from "../src/lib/db";
import { ensureDemoData } from "../src/lib/demo";
import { siteUrl } from "../src/lib/site-url";

const DEMO_EMAIL = "demo@flowpilot.ai";
const DEMO_PASSWORD = "Demo1234!";

async function main() {
  // ensureDemoData only runs when DEMO_MODE is on — force it for the seed.
  process.env.DEMO_MODE = "true";

  const existing = await db.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) {
    console.log(`Demo user ${DEMO_EMAIL} already exists — skipping seed.`);
    return;
  }

  const user = await db.user.create({
    data: {
      email: DEMO_EMAIL,
      name: "Demo User",
      passwordHash: await bcrypt.hash(DEMO_PASSWORD, 12),
    },
  });
  const org = await db.organization.create({ data: { name: "Demo Organization" } });
  const workspace = await db.workspace.create({
    data: {
      orgId: org.id,
      name: "Demo Workspace",
      slug: `demo-${randomBytes(3).toString("hex")}`,
    },
  });
  await db.membership.create({
    data: { userId: user.id, workspaceId: workspace.id, role: "OWNER" },
  });

  await ensureDemoData(workspace.id);

  const appUrl = siteUrl();
  console.log("Seed complete. Log in with:");
  console.log(`  Email:    ${DEMO_EMAIL}`);
  console.log(`  Password: ${DEMO_PASSWORD}`);
  console.log(`  App:      ${appUrl}`);
  console.log(`  Workspace: ${workspace.name} (${workspace.slug})`);
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
