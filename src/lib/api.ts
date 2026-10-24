import { NextRequest } from "next/server";
import { z } from "zod";

export function ok<T>(data: T, init?: ResponseInit) {
  return Response.json({ ok: true, data }, init);
}

export function err(message: string, status = 400, extra?: Record<string, unknown>) {
  return Response.json({ ok: false, error: message, ...extra }, { status });
}

/**
 * Parse + Zod-validate a request body. Throws an `err()` 422 Response on failure.
 * Usage: const body = await parseBody(req, MySchema);
 */
export async function parseBody<T>(req: NextRequest, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw err("Invalid JSON body", 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw err("Validation failed", 422, {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return parsed.data;
}

/** Route-handler wrapper: converts thrown Responses into returned responses. */
export function handler(fn: (req: NextRequest, ctx?: any) => Promise<Response>) {
  return async (req: NextRequest, ctx?: any) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof Response) return e;
      console.error("[api] unhandled error", e);
      return err("Internal server error", 500);
    }
  };
}

/**
 * Parse + Zod-validate the request query string. Throws an `err()` 422
 * Response on failure. Usage: const q = parseQuery(req, myQuerySchema);
 */
export function parseQuery<T>(req: NextRequest, schema: z.ZodType<T>): T {
  const raw: Record<string, string> = {};
  for (const [k, v] of new URL(req.url).searchParams.entries()) raw[k] = v;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw err("Validation failed", 422, {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  return parsed.data;
}
