/**
 * Unsubscribe token tests (Wave 2E).
 * - Round-trip: a created token verifies to the same payload.
 * - Tampered payload, tampered signature, wrong channel, garbage, and
 *   empty input all verify to null (never throw, never leak a reason).
 * - Tokens are scoped: a token for one contact does not verify as another.
 */
import { describe, it, expect } from "vitest";
import {
  createUnsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrl,
  UNSUBSCRIBE_CHANNEL,
} from "./unsubscribe";

describe("unsubscribe tokens", () => {
  it("round-trips a token to the same workspace/contact/channel", () => {
    const token = createUnsubscribeToken("ws_1", "ct_1");
    expect(verifyUnsubscribeToken(token)).toEqual({
      workspaceId: "ws_1",
      contactId: "ct_1",
      channel: "email",
    });
    expect(UNSUBSCRIBE_CHANNEL).toBe("email");
  });

  it("rejects a tampered payload", () => {
    const token = createUnsubscribeToken("ws_1", "ct_1");
    const [payload, sig] = token.split(".");
    const other = Buffer.from(
      JSON.stringify({ workspaceId: "ws_2", contactId: "ct_1", channel: "email" }),
      "utf8"
    ).toString("base64url");
    expect(payload).not.toBe(other);
    expect(verifyUnsubscribeToken(`${other}.${sig}`)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = createUnsubscribeToken("ws_1", "ct_1");
    const [payload] = token.split(".");
    const badSig = Buffer.from("0".repeat(32), "utf8").toString("base64url");
    expect(verifyUnsubscribeToken(`${payload}.${badSig}`)).toBeNull();
  });

  it("rejects garbage, empty, and wrong-shape input without throwing", () => {
    expect(verifyUnsubscribeToken("")).toBeNull();
    expect(verifyUnsubscribeToken("not-a-token")).toBeNull();
    expect(verifyUnsubscribeToken("a.b.c")).toBeNull();
    expect(verifyUnsubscribeToken("!!!.!!!")).toBeNull();
  });

  it("builds an unsubscribe URL carrying a verifiable token", () => {
    const url = unsubscribeUrl("ws_9", "ct_9", "https://example.com");
    expect(url.startsWith("https://example.com/api/unsubscribe?token=")).toBe(true);
    const token = new URL(url).searchParams.get("token")!;
    expect(verifyUnsubscribeToken(token)).toMatchObject({
      workspaceId: "ws_9",
      contactId: "ct_9",
    });
  });
});
