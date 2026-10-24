import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { LOCALES } from "@/i18n/config";

const bodySchema = z.object({
  locale: z.enum(LOCALES as unknown as [string, ...string[]]),
});

/** Persist the user's language preference (cookie is the primary store; this follows across devices). */
export const PUT = handler(async (req: NextRequest) => {
  const session = await requireUser();
  const body = await parseBody(req, bodySchema);
  await db.user.update({
    where: { id: session.user.id },
    data: { locale: body.locale },
  });
  return ok({ locale: body.locale });
});
