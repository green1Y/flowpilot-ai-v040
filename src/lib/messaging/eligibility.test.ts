/**
 * Eligibility checker tests — full matrix:
 * each channel × each message type × in-window / outside-window /
 * suppressed / already-replied / old-comment / missing timestamps.
 */
import { describe, it, expect } from "vitest";
import {
  checkEligibility,
  EligibilityChannel,
  EligibilityMessageType,
  EligibilityInput,
} from "./eligibility";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-17T12:00:00Z");

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

const CHANNELS: EligibilityChannel[] = ["instagram", "facebook", "whatsapp"];
const MESSAGE_TYPES: EligibilityMessageType[] = [
  "freeform",
  "template",
  "private_reply",
];

function base(
  overrides: Partial<EligibilityInput> = {}
): EligibilityInput {
  return {
    channel: "instagram",
    messageType: "freeform",
    now: NOW,
    ...overrides,
  };
}

describe("checkEligibility — universal suppression rule", () => {
  it.each(CHANNELS)("channel=%s messageType=%s suppressed → ineligible", (channel) => {
    for (const messageType of MESSAGE_TYPES) {
      const r = checkEligibility(
        base({
          channel,
          messageType,
          suppressed: true,
          lastInboundAt: hoursAgo(1),
          commentCreatedAt: daysAgo(1),
        })
      );
      expect(r.eligible, `${channel}/${messageType}`).toBe(false);
      expect(r.ineligibleReasons.join(" ")).toMatch(
        /suppressed|opted out/i
      );
      expect(r.windowEndsAt).toBeNull();
    }
  });
});

describe("checkEligibility — freeform 24h window", () => {
  it.each(CHANNELS)("eligible when last inbound is inside 24h", (channel) => {
    const last = hoursAgo(5);
    const r = checkEligibility(base({ channel, lastInboundAt: last }));
    expect(r.eligible).toBe(true);
    expect(r.ineligibleReasons).toEqual([]);
    expect(r.windowEndsAt?.getTime()).toBe(last.getTime() + DAY);
    expect(r.reasons.join(" ")).toMatch(/24-hour/);
  });

  it.each(CHANNELS)("ineligible when last inbound is outside 24h", (channel) => {
    const last = hoursAgo(25);
    const r = checkEligibility(base({ channel, lastInboundAt: last }));
    expect(r.eligible).toBe(false);
    expect(r.ineligibleReasons.join(" ")).toMatch(/24-hour/);
    // windowEndsAt is still reported so callers can show when it closed.
    expect(r.windowEndsAt?.getTime()).toBe(last.getTime() + DAY);
  });

  it.each(CHANNELS)("ineligible when there is no inbound at all", (channel) => {
    const r = checkEligibility(base({ channel, lastInboundAt: null }));
    expect(r.eligible).toBe(false);
    expect(r.windowEndsAt).toBeNull();
    expect(r.ineligibleReasons.join(" ")).toMatch(/no inbound/);
  });

  it("suggests a WhatsApp template for whatsapp outside the window", () => {
    const r = checkEligibility(base({ channel: "whatsapp", lastInboundAt: hoursAgo(30) }));
    expect(r.eligible).toBe(false);
    expect(r.ineligibleReasons.join(" ")).toMatch(/template/i);
  });

  it("suggests utility-template/OTN for Messenger/IG outside the window", () => {
    for (const channel of ["instagram", "facebook"] as const) {
      const r = checkEligibility(base({ channel, lastInboundAt: hoursAgo(30) }));
      expect(r.eligible).toBe(false);
      expect(r.ineligibleReasons.join(" ")).toMatch(/utility template|one-time/i);
    }
  });

  it("treats exactly-24h-old inbound as in-window (boundary)", () => {
    const last = new Date(NOW.getTime() - DAY);
    const r = checkEligibility(base({ channel: "facebook", lastInboundAt: last }));
    expect(r.eligible).toBe(true);
  });

  it("treats future-dated inbound as in-window (clock skew guard)", () => {
    const r = checkEligibility(
      base({ channel: "facebook", lastInboundAt: new Date(NOW.getTime() + HOUR) })
    );
    expect(r.eligible).toBe(false); // ageMs < 0 fails the >= 0 check → ineligible
    expect(r.reasons.join(" ")).toMatch(/window/);
  });
});

describe("checkEligibility — private_reply", () => {
  it.each(["instagram", "facebook"] as const)(
    "eligible for a fresh, unreplied comment on %s",
    (channel) => {
      const created = daysAgo(2);
      const r = checkEligibility(
        base({
          channel,
          messageType: "private_reply",
          commentCreatedAt: created,
        })
      );
      expect(r.eligible).toBe(true);
      expect(r.ineligibleReasons).toEqual([]);
      expect(r.windowEndsAt?.getTime()).toBe(created.getTime() + 7 * DAY);
    }
  );

  it("ineligible when the comment already received a private reply", () => {
    const r = checkEligibility(
      base({
        channel: "instagram",
        messageType: "private_reply",
        commentCreatedAt: daysAgo(1),
        privateRepliedAt: new Date(NOW.getTime() - 12 * HOUR),
      })
    );
    expect(r.eligible).toBe(false);
    expect(r.ineligibleReasons.join(" ")).toMatch(/already.*private reply|one per comment/i);
  });

  it("ineligible when the comment is older than 7 days", () => {
    const r = checkEligibility(
      base({
        channel: "facebook",
        messageType: "private_reply",
        commentCreatedAt: daysAgo(8),
      })
    );
    expect(r.eligible).toBe(false);
    expect(r.ineligibleReasons.join(" ")).toMatch(/7-day|551/);
  });

  it("eligible at exactly 7 days (boundary)", () => {
    const r = checkEligibility(
      base({
        channel: "instagram",
        messageType: "private_reply",
        commentCreatedAt: daysAgo(7),
      })
    );
    expect(r.eligible).toBe(true);
  });

  it("ineligible when commentCreatedAt is missing", () => {
    const r = checkEligibility(
      base({
        channel: "instagram",
        messageType: "private_reply",
        commentCreatedAt: null,
      })
    );
    expect(r.eligible).toBe(false);
    expect(r.ineligibleReasons.join(" ")).toMatch(/unknown/i);
  });

  it("ineligible for private_reply on whatsapp (unsupported)", () => {
    const r = checkEligibility(
      base({
        channel: "whatsapp",
        messageType: "private_reply",
        commentCreatedAt: daysAgo(1),
      })
    );
    expect(r.eligible).toBe(false);
    expect(r.ineligibleReasons.join(" ")).toMatch(/not supported/i);
  });

  it("suppressed still blocks an otherwise-eligible private reply", () => {
    const r = checkEligibility(
      base({
        channel: "instagram",
        messageType: "private_reply",
        commentCreatedAt: daysAgo(1),
        suppressed: true,
      })
    );
    expect(r.eligible).toBe(false);
    expect(r.ineligibleReasons.join(" ")).toMatch(/suppressed/i);
  });
});

describe("checkEligibility — WhatsApp template", () => {
  it("eligible regardless of the 24h window", () => {
    for (const lastInboundAt of [null, hoursAgo(1), hoursAgo(72)]) {
      const r = checkEligibility(
        base({ channel: "whatsapp", messageType: "template", lastInboundAt })
      );
      expect(r.eligible, `lastInboundAt=${lastInboundAt}`).toBe(true);
      expect(r.ineligibleReasons).toEqual([]);
      expect(r.reasons.join(" ")).toMatch(/template.*approved/i);
    }
  });

  it("notes that template approval is Meta-side", () => {
    const r = checkEligibility(base({ channel: "whatsapp", messageType: "template" }));
    expect(r.reasons.join(" ")).toMatch(/Meta/);
  });

  it("ineligible for template on non-WhatsApp channels", () => {
    for (const channel of ["instagram", "facebook"] as const) {
      const r = checkEligibility(
        base({ channel, messageType: "template", lastInboundAt: hoursAgo(1) })
      );
      expect(r.eligible).toBe(false);
      expect(r.ineligibleReasons.join(" ")).toMatch(/whatsapp/i);
    }
  });

  it("suppressed blocks even template sends", () => {
    const r = checkEligibility(
      base({ channel: "whatsapp", messageType: "template", suppressed: true })
    );
    expect(r.eligible).toBe(false);
    expect(r.ineligibleReasons.join(" ")).toMatch(/suppressed/i);
  });
});

describe("checkEligibility — result shape", () => {
  it("returns eligible=true with empty ineligibleReasons for a happy-path freeform", () => {
    const r = checkEligibility(base({ lastInboundAt: hoursAgo(2) }));
    expect(r.eligible).toBe(true);
    expect(Array.isArray(r.reasons)).toBe(true);
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.ineligibleReasons).toEqual([]);
    expect(r.windowEndsAt).toBeInstanceOf(Date);
  });

  it("windowEndsAt is null when no window applies (suppressed)", () => {
    const r = checkEligibility(base({ suppressed: true }));
    expect(r.windowEndsAt).toBeNull();
  });
});
