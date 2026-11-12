"use strict";

const { signMobileRelayState, verifyMobileRelayState, looksLikeMobileRelayState, TTL_MS } = require("../utils/mobileSamlState");

const DEVICE = "device-test-0001";

describe("mobile SAML RelayState", () => {
  it("round-trips the device id", () => {
    const state = signMobileRelayState(DEVICE);
    expect(looksLikeMobileRelayState(state)).toBe(true);
    expect(verifyMobileRelayState(state)).toEqual({ deviceId: DEVICE });
  });

  it("rejects an invalid device id when signing", () => {
    expect(() => signMobileRelayState("short")).toThrow();
    expect(() => signMobileRelayState("x".repeat(129))).toThrow();
  });

  it("rejects a tampered payload or signature", () => {
    const [prefix, payload, sig] = signMobileRelayState(DEVICE).split(".");
    const forged = Buffer.from(JSON.stringify({ d: "other-device-99", e: Date.now() + TTL_MS })).toString("base64url");
    expect(verifyMobileRelayState(`${prefix}.${forged}.${sig}`)).toBeNull();
    expect(verifyMobileRelayState(`${prefix}.${payload}.${sig.slice(0, -2)}AA`)).toBeNull();
    expect(verifyMobileRelayState(`${prefix}.${payload}`)).toBeNull();
  });

  it("rejects an expired state", () => {
    const state = signMobileRelayState(DEVICE, Date.now() - TTL_MS - 1000);
    expect(verifyMobileRelayState(state)).toBeNull();
  });

  it("ignores non-mobile values", () => {
    expect(looksLikeMobileRelayState(undefined)).toBe(false);
    expect(looksLikeMobileRelayState("/dashboard")).toBe(false);
    expect(verifyMobileRelayState("/dashboard")).toBeNull();
  });
});
