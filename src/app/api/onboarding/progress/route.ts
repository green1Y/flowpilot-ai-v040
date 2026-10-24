import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";

/**
 * Onboarding progress API (Phase 4).
 * Stores per-user-per-workspace wizard progress so onboarding is resumable.
 *
 * GET  /api/onboarding/progress → current progress (creates a default row on first read)
 * PUT  /api/onboarding/progress → upsert progress (Zod-validated)
 *
 * Auth: requireWorkspace (session + workspace membership). Nothing here is ever
 * auto-activated — this endpoint only records wizard state.
 */

const StepId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/i);

const ProgressSchema = z.object({
  currentStep: z.number().int().min(0).max(50),
  stepsDone: z.array(StepId).max(50).default([]),
  skipped: z.array(StepId).max(50).default([]),
  data: z.record(z.string(), z.unknown()).default({}),
  completed: z.boolean().optional(),
});

function serialize(p: {
  currentStep: number;
  stepsDone: string;
  skipped: string;
  data: string;
  completedAt: Date | null;
  updatedAt: Date;
}) {
  return {
    currentStep: p.currentStep,
    stepsDone: JSON.parse(p.stepsDone) as string[],
    skipped: JSON.parse(p.skipped) as string[],
    data: JSON.parse(p.data) as Record<string, unknown>,
    completedAt: p.completedAt?.toISOString() ?? null,
    updatedAt: p.updatedAt.toISOString(),
  };
}

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  let progress = await db.onboardingProgress.findUnique({
    where: { userId_workspaceId: { userId: ctx.userId, workspaceId: ctx.workspaceId } },
  });
  if (!progress) {
    progress = await db.onboardingProgress.create({
      data: { userId: ctx.userId, workspaceId: ctx.workspaceId },
    });
  }
  return ok({ progress: serialize(progress) });
});

export const PUT = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  const body = await parseBody(req, ProgressSchema);
  const progress = await db.onboardingProgress.upsert({
    where: { userId_workspaceId: { userId: ctx.userId, workspaceId: ctx.workspaceId } },
    create: {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      currentStep: body.currentStep,
      stepsDone: JSON.stringify(body.stepsDone),
      skipped: JSON.stringify(body.skipped),
      data: JSON.stringify(body.data),
      completedAt: body.completed ? new Date() : null,
    },
    update: {
      currentStep: body.currentStep,
      stepsDone: JSON.stringify(body.stepsDone),
      skipped: JSON.stringify(body.skipped),
      data: JSON.stringify(body.data),
      ...(body.completed ? { completedAt: new Date() } : {}),
    },
  });
  return ok({ progress: serialize(progress) });
});
