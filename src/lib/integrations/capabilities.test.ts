/**
 * Capability-matrix tests (pure logic, no HTTP, no DB).
 *
 * Verifies the honest resolution rules:
 *  - "no" platform truth always resolves to "unavailable" (never promised)
 *  - real providers only show available/limited when CONNECTED
 *  - simulated providers always resolve to "simulated"
 *  - anything else resolves to "not_connected" — never implying a live feature
 */
import { describe, it, expect } from "vitest";
import {
  CAPABILITY_KEYS,
  PROVIDER_CAPABILITIES,
  resolveCapabilities,
  countCapabilityStates,
} from "./capabilities";

describe("capability matrix coverage", () => {
  it("covers all 12 catalog providers", () => {
    const expected = [
      "instagram", "facebook", "whatsapp", "tiktok",
      "telegram", "youtube", "linkedin", "x",
      "email", "webchat", "sheets", "zapier",
    ];
    for (const p of expected) {
      expect(PROVIDER_CAPABILITIES[p], `missing provider ${p}`).toBeDefined();
    }
  });

  it("declares all 8 capabilities for every provider", () => {
    for (const [provider, truth] of Object.entries(PROVIDER_CAPABILITIES)) {
      for (const key of CAPABILITY_KEYS) {
        expect(truth[key], `${provider}.${key}`).toBeDefined();
        expect(["yes", "limited", "no"]).toContain(truth[key].level);
        expect(truth[key].note.length).toBeGreaterThan(0);
      }
    }
  });

  it("encodes known platform limits honestly", () => {
    // WhatsApp: no history API exists → FlowPilot cannot offer analytics from it.
    expect(PROVIDER_CAPABILITIES.whatsapp.retrieve_analytics.level).toBe("no");
    // TikTok Login Kit: identity only, no messaging API.
    for (const key of CAPABILITY_KEYS) {
      expect(PROVIDER_CAPABILITIES.tiktok[key].level).toBe("no");
    }
    // Instagram: 24h window caveat on sends.
    expect(PROVIDER_CAPABILITIES.instagram.send_messages.level).toBe("limited");
    // WhatsApp: template requirement on sends.
    expect(PROVIDER_CAPABILITIES.whatsapp.send_messages.level).toBe("limited");
    // Neither Meta provider implements ad management in this codebase.
    expect(PROVIDER_CAPABILITIES.instagram.manage_ads.level).toBe("no");
    expect(PROVIDER_CAPABILITIES.facebook.manage_ads.level).toBe("no");
  });
});

describe("resolveCapabilities — real providers", () => {
  it("resolves available/limited/unavailable when connected", () => {
    const d = resolveCapabilities("instagram", {
      connectionState: "connected",
      simulated: false,
    });
    const byKey = Object.fromEntries(d.map((x) => [x.key, x.state]));
    expect(byKey.read_events).toBe("available");
    expect(byKey.receive_comments).toBe("available");
    expect(byKey.send_messages).toBe("limited");
    expect(byKey.manage_ads).toBe("unavailable");
    expect(byKey.publish_media).toBe("unavailable");
  });

  it("never shows available without a connection", () => {
    for (const state of [
      "not_connected",
      "connecting",
      "reauth_required",
      "permission_missing",
      "unavailable",
      "failed",
    ] as const) {
      const d = resolveCapabilities("whatsapp", {
        connectionState: state,
        simulated: false,
      });
      const counts = countCapabilityStates(d);
      expect(counts.available).toBe(0);
      expect(counts.limited).toBe(0);
      // Wave 2A (D7): whatsapp has 3 non-"no" capabilities → all
      // not_connected (publish_media moved to "no": media sends are
      // not implemented, text-only). Unavailable is now 5 of 8.
      expect(counts.not_connected).toBe(3);
      expect(counts.unavailable).toBe(5);
    }
  });

  it("marks partial connections as limited, never fully available", () => {
    const d = resolveCapabilities("facebook", {
      connectionState: "partial",
      simulated: false,
    });
    const counts = countCapabilityStates(d);
    expect(counts.available).toBe(0);
    expect(counts.limited).toBeGreaterThan(0);
  });

  it("whatsapp publish_media is unavailable even when connected (D7)", () => {
    // Wave 2A (D7): the WhatsApp adapter builds text-only payloads and
    // ignores its `media` argument, so the matrix must not promise media
    // sends. The note must say so plainly.
    const d = resolveCapabilities("whatsapp", {
      connectionState: "connected",
      simulated: false,
    });
    const media = d.find((x) => x.key === "publish_media");
    expect(media?.state).toBe("unavailable");
    expect(media?.note).toMatch(/not implemented/i);
    expect(media?.note).toMatch(/text-only/i);
    // Same honesty for the other Meta providers.
    for (const p of ["instagram", "facebook"]) {
      const dd = resolveCapabilities(p, {
        connectionState: "connected",
        simulated: false,
      });
      const m = dd.find((x) => x.key === "publish_media");
      expect(m?.state).toBe("unavailable");
      expect(m?.note).toMatch(/text-only/i);
    }
  });
});

describe("resolveCapabilities — simulated providers", () => {
  it("resolves to simulated when the mock connection is up, never available", () => {
    for (const p of ["telegram", "youtube", "x", "email", "webchat"]) {
      const d = resolveCapabilities(p, {
        connectionState: "connected",
        simulated: true,
      });
      const counts = countCapabilityStates(d);
      expect(counts.available).toBe(0);
      expect(counts.limited).toBe(0);
      expect(counts.simulated).toBeGreaterThan(0);
    }
  });

  it("simulated + not connected → not_connected (nothing backs it yet)", () => {
    const d = resolveCapabilities("telegram", {
      connectionState: "not_connected",
      simulated: true,
    });
    const states = new Set(d.map((x) => x.state));
    expect(states.has("available")).toBe(false);
    expect(states.has("limited")).toBe(false);
    expect(states.has("simulated")).toBe(false);
    expect(states.has("not_connected")).toBe(true);
  });
});

describe("resolveCapabilities — unknown provider", () => {
  it("fails closed to all-unavailable", () => {
    const d = resolveCapabilities("nope", {
      connectionState: "connected",
      simulated: false,
    });
    expect(d).toHaveLength(8);
    for (const c of d) expect(c.state).toBe("unavailable");
  });
});
