/**
 * Prospect serialization (v0.4.0).
 * Lives here (not in a route file) because Next.js route modules may only
 * export route handlers — a value export from a route.ts breaks the
 * production build ("not a valid Route export field").
 */
import { parseJson } from "@/lib/serialize";

export function serializeProspect(p: any) {
  return {
    ...p,
    socials: parseJson<Record<string, string>>(p.socials, {}),
    qualificationReasons: parseJson<string[]>(p.qualificationReasons, []),
    // A prospect without a sourceUrl is user-entered and unverified; the UI
    // must label it "unverified — user-entered".
    verified: Boolean(p.sourceUrl),
  };
}
