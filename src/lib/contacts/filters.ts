import type { Prisma } from "@prisma/client";
import { err } from "@/lib/api";

/**
 * Contact filter helpers (Stage 1). Builds the Prisma `where` clause for
 * GET /api/contacts from query params or a saved ContactSegment's filters.
 *
 * Filters: channel, tag, leadStatus, search, from/to (interaction date range
 * on lastInboundAt, falling back to createdAt when no inbound exists).
 */

export interface ContactFilterParams {
  channel?: string | null;
  tag?: string | null;
  leadStatus?: string | null;
  search?: string | null;
  from?: string | null;
  to?: string | null;
}

const LEAD_STATUSES = new Set([
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "INTERESTED",
  "CONVERTED",
  "LOST",
]);

function parseDateParam(value: string | null | undefined, name: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw err(`Invalid "${name}" date — expected an ISO date string`, 422);
  }
  return d;
}

/** Apply the filter params onto a ContactWhereInput (mutates `where`). */
export function applyContactFilters(
  where: Prisma.ContactWhereInput,
  params: ContactFilterParams
): Prisma.ContactWhereInput {
  const { channel, tag, leadStatus, search, from, to } = params;

  if (channel) where.channel = channel;
  if (leadStatus) {
    if (!LEAD_STATUSES.has(leadStatus)) {
      throw err(`Invalid leadStatus "${leadStatus}"`, 422);
    }
    where.leadStatus = leadStatus;
  }
  // tags are stored as a JSON array string; match the quoted value to avoid
  // substring collisions (e.g. "vip" matching "vip2").
  if (tag) where.tags = { contains: `"${tag}"` };

  const fromDate = parseDateParam(from, "from");
  const toDate = parseDateParam(to, "to");

  const ors: Prisma.ContactWhereInput[] = [];
  if (search) {
    ors.push({
      OR: [
        { name: { contains: search } },
        { email: { contains: search } },
        { phone: { contains: search } },
      ],
    });
  }
  if (fromDate || toDate) {
    // Interaction date range: contacts whose last inbound (or, when none
    // exists, first-seen) falls inside [from, to].
    const range: Prisma.DateTimeFilter = {};
    if (fromDate) range.gte = fromDate;
    if (toDate) range.lte = toDate;
    ors.push({
      OR: [
        { lastInboundAt: range },
        { AND: [{ lastInboundAt: null }, { firstSeenAt: range }] },
      ],
    });
  }
  if (ors.length === 1) {
    where.AND = [...((where.AND as Prisma.ContactWhereInput[]) ?? []), ors[0]];
  } else if (ors.length > 1) {
    where.AND = [...((where.AND as Prisma.ContactWhereInput[]) ?? []), ...ors];
  }

  return where;
}

/** Extract filter params from a URLSearchParams (query string). */
export function filtersFromQuery(sp: URLSearchParams): ContactFilterParams {
  const status = sp.get("status");
  const leadStatus = sp.get("leadStatus") || status;
  return {
    channel: sp.get("channel"),
    tag: sp.get("tag"),
    leadStatus,
    search: sp.get("search")?.trim() || null,
    from: sp.get("from"),
    to: sp.get("to"),
  };
}

/** Extract filter params from a saved segment's stored JSON filters. */
export function filtersFromSegmentJson(raw: string): ContactFilterParams {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Malformed filters — treat as empty.
  }
  const pick = (k: string): string | null =>
    typeof parsed[k] === "string" ? (parsed[k] as string) : null;
  return {
    channel: pick("channel"),
    tag: pick("tag"),
    leadStatus: pick("leadStatus"),
    search: pick("search"),
    from: pick("from"),
    to: pick("to"),
  };
}
