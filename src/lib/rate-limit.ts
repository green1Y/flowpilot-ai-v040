/**
 * In-memory brute-force protection for the login route.
 *
 * Tracks failed login attempts per key (client IP + email) inside a
 * sliding window. After the budget is exhausted the route answers 429
 * until the oldest failures age out. A successful login clears the key.
 *
 * In-memory is a deliberate fit for this deployment (single server, per
 * SECURITY_AUDIT.md); a multi-server deployment should move this to
 * Redis. Never stores passwords or hashes — only timestamps.
 */

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 10;

export const LOGIN_RATE_LIMIT = {
  windowMs: WINDOW_MS,
  maxFailedAttempts: MAX_FAILED_ATTEMPTS,
} as const;

const failedAttempts = new Map<string, number[]>();

function prune(key: string, now: number): number[] {
  const kept = (failedAttempts.get(key) ?? []).filter(
    (t) => now - t < WINDOW_MS
  );
  if (kept.length === 0) failedAttempts.delete(key);
  else failedAttempts.set(key, kept);
  return kept;
}

/** True when `key` has exhausted its failed-attempt budget. */
export function isLoginBlocked(key: string): boolean {
  return prune(key, Date.now()).length >= MAX_FAILED_ATTEMPTS;
}

/**
 * Record a failed login attempt for `key`. Returns the number of failures
 * currently inside the window (including this one).
 */
export function recordFailedLogin(key: string): number {
  const arr = prune(key, Date.now());
  arr.push(Date.now());
  failedAttempts.set(key, arr);
  return arr.length;
}

/** Clear the failure record for `key` (call on successful login). */
export function clearFailedLogins(key: string): void {
  failedAttempts.delete(key);
}

/** Test-only: reset all rate-limit state. */
export function resetLoginAttempts(): void {
  failedAttempts.clear();
}

// --- Signup budget (mass-account-creation protection) ---
//
// Separate from the login budget: limits NEW account creations per client IP
// inside a sliding window. Also blunts the email-enumeration oracle on the
// 409 "already exists" response (full fix would be email verification,
// which is out of scope for this release).

const SIGNUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_SIGNUPS_PER_IP = 5;

const signupAttempts = new Map<string, number[]>();

function pruneSignups(ip: string, now: number): number[] {
  const kept = (signupAttempts.get(ip) ?? []).filter((t) => now - t < SIGNUP_WINDOW_MS);
  if (kept.length === 0) signupAttempts.delete(ip);
  else signupAttempts.set(ip, kept);
  return kept;
}

/** True when `ip` has exhausted its signup budget. */
export function isSignupBlocked(ip: string): boolean {
  return pruneSignups(ip, Date.now()).length >= MAX_SIGNUPS_PER_IP;
}

/** Record a successful signup for `ip`. */
export function recordSignup(ip: string): void {
  const arr = pruneSignups(ip, Date.now());
  arr.push(Date.now());
  signupAttempts.set(ip, arr);
}

/** Test-only: reset signup rate-limit state. */
export function resetSignupAttempts(): void {
  signupAttempts.clear();
}

// --- Email verification resend: 60s cooldown + hourly budget ---
//
// Guards POST /api/auth/verify-email/resend. The cooldown stops rapid
// re-sends; the budget stops slow-drip abuse. Both are per-user.

const RESEND_COOLDOWN_MS = 60 * 1000;

const resendCooldowns = new Map<string, number>(); // userId -> last send timestamp

/** Milliseconds remaining before `userId` may resend (0 = allowed). */
export function getResendCooldownRemainingMs(userId: string): number {
  const last = resendCooldowns.get(userId);
  if (!last) return 0;
  return Math.max(0, RESEND_COOLDOWN_MS - (Date.now() - last));
}

/** Record a successful verification-code send for `userId`. */
export function recordResend(userId: string): void {
  resendCooldowns.set(userId, Date.now());
}

/** Test-only: reset resend cooldown state. */
export function resetResendCooldowns(): void {
  resendCooldowns.clear();
}

const VERIFY_RESEND_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_VERIFY_RESENDS_PER_HOUR = 10;

const verifyResends = new Map<string, number[]>(); // userId -> timestamps

function pruneVerifyResends(userId: string, now: number): number[] {
  const kept = (verifyResends.get(userId) ?? []).filter(
    (t) => now - t < VERIFY_RESEND_WINDOW_MS
  );
  if (kept.length === 0) verifyResends.delete(userId);
  else verifyResends.set(userId, kept);
  return kept;
}

/** True when `userId` has exhausted its hourly resend budget. */
export function isVerifyResendBlocked(userId: string): boolean {
  return pruneVerifyResends(userId, Date.now()).length >= MAX_VERIFY_RESENDS_PER_HOUR;
}

/** Record a verification-code resend for `userId`. */
export function recordVerifyResend(userId: string): void {
  const arr = pruneVerifyResends(userId, Date.now());
  arr.push(Date.now());
  verifyResends.set(userId, arr);
}

/** Test-only: reset resend budget state. */
export function resetVerifyResends(): void {
  verifyResends.clear();
}

// --- Password reset budget (per client IP, shared by request + confirm) ---
//
// Blunts enumeration and token-spraying. Counts every request, valid or not,
// so the budget itself cannot become an account-existence oracle.

const RESET_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_RESETS_PER_IP = 10;

const resetAttempts = new Map<string, number[]>(); // ip -> timestamps

function pruneResets(ip: string, now: number): number[] {
  const kept = (resetAttempts.get(ip) ?? []).filter(
    (t) => now - t < RESET_WINDOW_MS
  );
  if (kept.length === 0) resetAttempts.delete(ip);
  else resetAttempts.set(ip, kept);
  return kept;
}

/** True when `ip` has exhausted its password-reset budget. */
export function isPasswordResetBlocked(ip: string): boolean {
  return pruneResets(ip, Date.now()).length >= MAX_RESETS_PER_IP;
}

/** Record a password-reset request/confirm attempt for `ip`. */
export function recordPasswordReset(ip: string): void {
  const arr = pruneResets(ip, Date.now());
  arr.push(Date.now());
  resetAttempts.set(ip, arr);
}

/** Test-only: reset password-reset budget state. */
export function resetPasswordResetAttempts(): void {
  resetAttempts.clear();
}
