import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { userNotifPrefsSchema, resolveUserNotifPrefs } from "@/lib/workspace-settings";

const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().max(200).optional(),
    timezone: z.string().trim().min(1).max(80).optional(),
    notificationPrefs: userNotifPrefsSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

/** Update the signed-in user's profile: name, email, timezone, notification prefs. */
export const PATCH = handler(async (req: NextRequest) => {
  const session = await requireUser();
  const body = await parseBody(req, profileSchema);

  const data: { name?: string; email?: string; timezone?: string; notificationPrefs?: string } = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.timezone !== undefined) {
    // Validate against the IANA database when available (Node 18+).
    try {
      if (typeof (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf === "function") {
        const zones = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
        if (!zones.includes(body.timezone)) throw err("Unknown time zone", 422);
      }
    } catch (e) {
      if (e instanceof Response) throw e;
      // Intl data unavailable — accept the value as-is.
    }
    data.timezone = body.timezone;
  }
  if (body.email !== undefined) {
    const email = body.email.toLowerCase();
    const taken = await db.user.findFirst({
      where: { email, id: { not: session.userId } },
      select: { id: true },
    });
    if (taken) throw err("That email is already in use", 409);
    data.email = email;
  }
  if (body.notificationPrefs !== undefined) {
    const user = await db.user.findUnique({ where: { id: session.userId }, select: { notificationPrefs: true } });
    data.notificationPrefs = JSON.stringify({
      ...resolveUserNotifPrefs(user?.notificationPrefs),
      ...body.notificationPrefs,
    });
  }

  const updated = await db.user.update({
    where: { id: session.userId },
    data,
    select: { id: true, name: true, email: true, locale: true, timezone: true, notificationPrefs: true },
  });

  return ok({
    user: {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      locale: updated.locale,
      timezone: updated.timezone,
      notificationPrefs: resolveUserNotifPrefs(updated.notificationPrefs),
    },
  });
});

export const GET = handler(async () => {
  const session = await requireUser();

  const memberships = await db.membership.findMany({
    where: { userId: session.userId },
    include: { workspace: { select: { id: true, name: true, slug: true } } },
    orderBy: { id: "asc" },
  });

  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { id: true, name: true, email: true, locale: true, timezone: true, notificationPrefs: true, emailVerified: true, emailVerifiedAt: true },
  });

  return ok({
    user: user
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
          locale: user.locale,
          timezone: user.timezone,
          notificationPrefs: resolveUserNotifPrefs(user.notificationPrefs),
          emailVerified: user.emailVerified,
          emailVerifiedAt: user.emailVerifiedAt,
        }
      : { id: session.user.id, name: session.user.name, email: session.user.email, emailVerified: false, emailVerifiedAt: null },
    workspaces: memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      role: m.role,
    })),
  });
});
