/**
 * Clarifying-question heuristic tests (pure function, EN + AR).
 */
import { describe, it, expect } from "vitest";
import { clarificationQuestions, nodeCatalogText } from "./prompts";

describe("clarificationQuestions", () => {
  it("asks questions for a vague prompt", () => {
    const qs = clarificationQuestions("automate stuff");
    expect(qs).not.toBeNull();
    const ids = qs!.map((q) => q.id);
    expect(ids).toContain("channel");
    expect(ids).toContain("trigger");
    expect(ids).toContain("content");
  });

  it("returns null when the prompt is complete", () => {
    const qs = clarificationQuestions(
      "When a new message arrives on Instagram containing the word price, send a reply message with our pricing and tag the contact as lead."
    );
    expect(qs).toBeNull();
  });

  it("detects Arabic channel words", () => {
    const qs = clarificationQuestions("عندما تصل رسالة جديدة على واتساب أرسل ردًا ترحيبيًا");
    // channel=whatsapp detected, trigger=new message detected, content present
    expect(qs).toBeNull();
  });

  it("asks only about the missing pieces", () => {
    const qs = clarificationQuestions("send a welcome message to new leads");
    expect(qs).not.toBeNull();
    const ids = qs!.map((q) => q.id);
    expect(ids).toContain("channel");
    expect(ids).not.toContain("content");
  });

  it("provides Arabic question text with key parity", () => {
    const qs = clarificationQuestions("do automation", "ar");
    expect(qs).not.toBeNull();
    for (const q of qs!) {
      expect(q.questionAr.length).toBeGreaterThan(0);
      expect(q.question.length).toBeGreaterThan(0);
    }
  });

  it("offers channel quick-pick options", () => {
    const qs = clarificationQuestions("do automation");
    const channel = qs!.find((q) => q.id === "channel");
    expect(channel?.options).toContain("instagram");
    expect(channel?.options).toContain("whatsapp");
  });
});

describe("nodeCatalogText", () => {
  it("lists only registered node types", async () => {
    const { NODE_TYPES } = await import("@/lib/workflows/nodeRegistry");
    const text = nodeCatalogText();
    for (const type of Object.keys(NODE_TYPES)) {
      expect(text).toContain(type);
    }
    expect(text).not.toContain("action.teleport");
  });
});
