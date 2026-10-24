import { randomInt, createHash, timingSafeEqual, randomBytes } from "crypto";

/**
 * Email-verification + password-reset crypto helpers (Workstream A).
 *
 * Security rules:
 * - Plaintext codes/tokens are NEVER persisted — only SHA-256 hashes.
 * - Comparisons use timing-safe equality on equal-length buffers.
 * - Codes/tokens are generated with crypto randomness (never Math.random).
 */

// --- Email verification codes (6 digits, 15-minute expiry, 5-attempt lock) ---

export const VERIFICATION_CODE_TTL_MS = 15 * 60 * 1000;
export const VERIFICATION_MAX_ATTEMPTS = 5;

/** 6-digit numeric code as a string (100000–999999, no leading-zero edge). */
export function generateVerificationCode(): string {
  return String(randomInt(100000, 1_000_000));
}

export function hashVerificationCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

// --- Password reset tokens (32 random bytes, 1-hour expiry, single-use) ---

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export function generateResetToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Timing-safe comparison of hex digests (false on length mismatch). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// --- Email bodies (transactional; no secrets, no tracking pixels) ---

function emailShell(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
<h2 style="margin:0 0 16px">${title}</h2>
${bodyHtml}
<p style="color:#666;font-size:12px;margin-top:24px">FlowPilot AI — if you didn't request this, you can safely ignore it.</p>
</body></html>`;
}

export function verificationEmailHtml(code: string): string {
  return emailShell(
    "Verify your email",
    `<p>Your FlowPilot verification code is:</p>
<p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:16px 0">${code}</p>
<p>It expires in 15 minutes. Never share this code with anyone.</p>`
  );
}

export function passwordResetEmailHtml(resetLink: string): string {
  return emailShell(
    "Reset your password",
    `<p>Click the link below to choose a new password. It expires in 1 hour and can only be used once:</p>
<p style="margin:16px 0"><a href="${resetLink}">Reset my password</a></p>
<p style="color:#666;font-size:13px">If the button doesn't work, paste this link into your browser:<br><span style="word-break:break-all">${resetLink}</span></p>`
  );
}
