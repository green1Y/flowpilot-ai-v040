/**
 * Media listing tests — fetch is stubbed (no Meta traffic, no tokens).
 * Asserts the official edge, the requested fields, and that a missing
 * credential set fails before any request is made.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { listInstagramMedia, MEDIA_FIELDS } from "./media";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

describe("listInstagramMedia", () => {
  it("calls GET /{ig-user-id}/media with the picker fields via graph.instagram.com", async () => {
    const calls = stubFetch({
      data: [
        { id: "m1", caption: "Hello", media_type: "VIDEO", permalink: "https://ig.example/m1", timestamp: "2026-10-20T00:00:00Z", thumbnail_url: "https://ig.example/t1.jpg" },
        { id: "m2", media_type: "IMAGE" },
      ],
      paging: { cursors: { after: "cur-1" } },
    });
    const res = await listInstagramMedia({ igUserId: "ig-123", accessToken: "tok" });
    expect(res.items).toHaveLength(2);
    expect(res.items[0].media_type).toBe("VIDEO");
    expect(res.paging?.cursors?.after).toBe("cur-1");
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.hostname).toBe("graph.instagram.com");
    expect(url.pathname).toContain("/ig-123/media");
    expect(url.searchParams.get("fields")).toBe(MEDIA_FIELDS);
    // The token travels in the query (Meta's requirement) — the module
    // itself logs nothing; assert the request carried it, not a log line.
    expect(url.searchParams.get("access_token")).toBe("tok");
    expect(calls[0].init?.method ?? "GET").toBe("GET");
  });

  it("returns an empty list (never fabricated media) when data is absent", async () => {
    stubFetch({});
    const res = await listInstagramMedia({ igUserId: "ig-123", accessToken: "tok" });
    expect(res.items).toEqual([]);
  });

  it("clamps limit and forwards the paging cursor", async () => {
    const calls = stubFetch({ data: [] });
    await listInstagramMedia({ igUserId: "ig-123", accessToken: "tok" }, { limit: 500, after: "cur-9" });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("after")).toBe("cur-9");
  });

  it("refuses to call the API without a user id or token", async () => {
    const calls = stubFetch({ data: [] });
    await expect(listInstagramMedia({ igUserId: "", accessToken: "tok" })).rejects.toThrow(/reconnect/);
    await expect(listInstagramMedia({ igUserId: "ig-123", accessToken: "" })).rejects.toThrow(/reconnect/);
    expect(calls).toHaveLength(0);
  });
});
