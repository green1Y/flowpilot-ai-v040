import { describe, it, expect, afterEach } from "vitest";
import { siteUrl } from "./site-url";

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe("siteUrl", () => {
  it("prefers NEXT_PUBLIC_SITE_URL", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://example.com/";
    process.env.NEXT_PUBLIC_APP_URL = "https://legacy.example.com";
    expect(siteUrl()).toBe("https://example.com");
  });

  it("falls back to legacy NEXT_PUBLIC_APP_URL", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://legacy.example.com///";
    expect(siteUrl()).toBe("https://legacy.example.com");
  });

  it("defaults to localhost when neither is set", () => {
    expect(siteUrl()).toBe("http://localhost:3000");
  });
});
