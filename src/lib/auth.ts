import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { cookies } from "next/headers";
import { db } from "./db";

/**
 * Resolve the JWT signing secret. In production this FAILS CLOSED: if JWT_SECRET
 * is unset we throw instead of signing sessions with the publicly-known dev
 * fallback (which would let anyone forge a session for any user). In dev/test
 * the fallback is retained so local runs and the test suite keep working.
 * Resolved lazily (not at module load) so `next build` never crashes on import.
 */
function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s && process.env.NODE_ENV === "production") {
    throw new Error(
      "[security] JWT_SECRET is not set — refusing to sign/verify sessions with the dev fallback in production"
    );
  }
  return s || "change-me-dev-only";
}
export const SESSION_COOKIE = process.env.SESSION_COOKIE || "fp_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  userId: string;
  email: string;
  /** v0.4.0: must equal User.tokenVersion when present. Tokens issued
   *  before v0.4.0 carry no claim and are accepted (migration leniency)
   *  until the next password change/reset, which bumps the version. */
  tokenVersion?: number;
}

/**
 * Pure version check, unit-tested in auth-version.test.ts: a versioned
 * token is valid only when its version matches the user's current version.
 */
export function isSessionVersionValid(
  payload: SessionPayload,
  userTokenVersion: number
): boolean {
  return payload.tokenVersion === undefined || payload.tokenVersion === userTokenVersion;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signToken(payload: SessionPayload): string {
  return jwt.sign(payload, jwtSecret(), { expiresIn: "7d" });
}

export function verifyToken(token: string): SessionPayload | null {
  try {
    return jwt.verify(token, jwtSecret()) as SessionPayload;
  } catch {
    return null;
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE,
  };
}

/** Read the current session from cookies. Returns null when not signed in. */
export async function getSession(): Promise<(SessionPayload & { user: { id: string; name: string; email: string } }) | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const user = await db.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, name: true, email: true, tokenVersion: true },
  });
  if (!user) return null;
  // v0.4.0: a token issued before the last password change/reset is dead,
  // even though its 7-day expiry has not passed.
  if (!isSessionVersionValid(payload, user.tokenVersion)) return null;
  return { ...payload, user };
}

/** Set the session cookie (call inside a Route Handler). */
export async function setSessionCookie(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, cookieOptions());
}

/** Clear the session cookie. */
export async function clearSessionCookie() {
  (await cookies()).set(SESSION_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
}

/** Require a signed-in user inside a Route Handler; throws a 401 Response. */
export async function requireUser() {
  const session = await getSession();
  if (!session) {
    throw Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return session;
}
