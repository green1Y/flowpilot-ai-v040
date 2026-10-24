/** Wave 2D: no SMS provider is configured — status is honestly unconfigured. */
import { describe, it, expect } from "vitest";
import {
  SMS_PROVIDERS,
  SMS_PROVIDER_NOT_CONFIGURED,
  SMS_PROVIDER_PREREQUISITE,
  getSmsProvider,
  getSmsStatus,
  listSmsProviders,
} from "./providers";

describe("sms providers (no provider configured in v0.4.0)", () => {
  it("registry is empty and no provider is enabled", () => {
    expect(SMS_PROVIDERS).toEqual([]);
    expect(listSmsProviders()).toEqual([]);
    expect(getSmsProvider()).toBeNull();
  });

  it("getSmsStatus reports configured:false with the prerequisite and no supported channels", () => {
    expect(getSmsStatus()).toEqual({
      configured: false,
      code: SMS_PROVIDER_NOT_CONFIGURED,
      prerequisite: SMS_PROVIDER_PREREQUISITE,
      supported: [],
    });
  });
});
