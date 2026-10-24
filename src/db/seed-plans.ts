/**
 * Plan seed: `npx tsx src/db/seed-plans.ts`.
 *
 * Idempotent — upserts the three plan tiers by name, so re-running is safe.
 * Also backfills `workspace.planId` for workspaces that still reference a
 * plan only via the legacy `plan` name column.
 */
import { db } from "../lib/db";

const PLANS = [
  {
    name: "Starter",
    monthlyMessageLimit: 500,
    workflowLimit: 5,
    seatLimit: 3,
    connectedAccountLimit: 3,
    features: [
      "500 messages / month",
      "5 workflows",
      "3 seats",
      "Core automations",
      "Community support",
    ],
  },
  {
    name: "Growth",
    monthlyMessageLimit: 5000,
    workflowLimit: 25,
    seatLimit: 10,
    connectedAccountLimit: 10,
    features: [
      "5,000 messages / month",
      "25 workflows",
      "10 seats",
      "Advanced workflows + approvals",
      "Priority support",
    ],
  },
  {
    name: "Agency",
    monthlyMessageLimit: 25000,
    workflowLimit: 200,
    seatLimit: 25,
    connectedAccountLimit: 50,
    features: [
      "25,000 messages / month",
      "200 workflows",
      "25 seats",
      "White-label + API access",
      "Dedicated success manager",
    ],
  },
] as const;

async function main() {
  const byName = new Map<string, string>();
  for (const p of PLANS) {
    const row = await db.plan.upsert({
      where: { name: p.name },
      update: {
        monthlyMessageLimit: p.monthlyMessageLimit,
        workflowLimit: p.workflowLimit,
        seatLimit: p.seatLimit,
        connectedAccountLimit: p.connectedAccountLimit,
        features: JSON.stringify(p.features),
        isActive: true,
      },
      create: {
        name: p.name,
        monthlyMessageLimit: p.monthlyMessageLimit,
        workflowLimit: p.workflowLimit,
        seatLimit: p.seatLimit,
        connectedAccountLimit: p.connectedAccountLimit,
        features: JSON.stringify(p.features),
        isActive: true,
      },
    });
    byName.set(p.name.toLowerCase(), row.id);
    console.log(`plan upserted: ${row.name} (id ${row.id})`);
  }

  // Backfill planId from the legacy `plan` name column (e.g. "STARTER").
  const workspaces = await db.workspace.findMany({
    where: { planId: null },
    select: { id: true, plan: true },
  });
  let backfilled = 0;
  for (const ws of workspaces) {
    const planId = byName.get((ws.plan || "").trim().toLowerCase());
    if (!planId) continue;
    await db.workspace.update({ where: { id: ws.id }, data: { planId } });
    backfilled++;
  }
  console.log(`backfilled planId for ${backfilled} workspace(s)`);
}

main()
  .catch((e) => {
    console.error("seed-plans failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
