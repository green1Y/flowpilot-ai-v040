import { handler, ok } from "@/lib/api";
import { clearSessionCookie } from "@/lib/auth";
import { clearWorkspaceCookie } from "@/lib/tenancy";

export const POST = handler(async () => {
  await clearSessionCookie();
  // Also drop the workspace selection: otherwise the next user to sign in on
  // this browser inherits the previous user's workspace id and every
  // workspace-dependent request 403s.
  await clearWorkspaceCookie();
  return ok({ ok: true });
});
