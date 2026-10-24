/**
 * Wave 2A (D5) — provider catalog scope honesty (pure logic, no HTTP, no DB).
 *
 * The Instagram catalog entry used to list the deprecated Facebook-Login
 * scopes (instagram_manage_messages / instagram_manage_comments /
 * pages_show_list). New Instagram connections run Instagram Business Login,
 * which requests instagram_business_basic +
 * instagram_business_manage_messages + instagram_business_manage_comments
 * (INSTAGRAM_LOGIN_SCOPES). The catalog must match the flow that actually
 * runs, or the Integrations page promises scopes the app never requests.
 */
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "./providers";
import { INSTAGRAM_LOGIN_SCOPES } from "./instagram-login";

describe("provider catalog — Instagram scopes (D5)", () => {
  it("lists the real Business Login scopes, not the deprecated ones", () => {
    const ig = PROVIDERS.find((p) => p.provider === "instagram");
    expect(ig).toBeDefined();
    expect(ig!.requiredPermissions).toEqual([...INSTAGRAM_LOGIN_SCOPES]);
    expect(ig!.requiredPermissions).toContain("instagram_business_basic");
    expect(ig!.requiredPermissions).toContain(
      "instagram_business_manage_messages"
    );
    expect(ig!.requiredPermissions).toContain(
      "instagram_business_manage_comments"
    );
    expect(ig!.requiredPermissions).not.toContain("instagram_manage_messages");
    expect(ig!.requiredPermissions).not.toContain("instagram_manage_comments");
    expect(ig!.requiredPermissions).not.toContain("pages_show_list");
  });

  it("keeps the Facebook/WhatsApp scope lists untouched", () => {
    const fb = PROVIDERS.find((p) => p.provider === "facebook");
    expect(fb!.requiredPermissions).toEqual([
      "pages_messaging",
      "pages_show_list",
      "pages_read_engagement",
    ]);
    const wa = PROVIDERS.find((p) => p.provider === "whatsapp");
    expect(wa!.requiredPermissions).toEqual([
      "whatsapp_business_messaging",
      "whatsapp_business_management",
    ]);
  });
});
