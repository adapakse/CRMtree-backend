"use strict";

const { signGoogleState, verifyGoogleState, TTL_MS } = require("../utils/googleLoginState");

const DEVICE = "device-test-0001";

describe("google login state", () => {
  it("round-trips a web state", () => {
    const { state, nonce } = signGoogleState({ client: "web", host: "Acme.CRMtree.pl" });
    expect(verifyGoogleState(state)).toEqual({ client: "web", deviceId: null, host: "acme.crmtree.pl", nonce });
  });

  it("round-trips a mobile state with the device id", () => {
    const { state, nonce } = signGoogleState({ client: "mobile", deviceId: DEVICE });
    expect(verifyGoogleState(state)).toEqual({ client: "mobile", deviceId: DEVICE, host: "", nonce });
  });

  it("uses a fresh nonce each time", () => {
    expect(signGoogleState({ client: "web" }).nonce).not.toBe(signGoogleState({ client: "web" }).nonce);
  });

  it("refuses to sign mobile without a valid device id or an unknown client", () => {
    expect(() => signGoogleState({ client: "mobile", deviceId: "short" })).toThrow();
    expect(() => signGoogleState({ client: "desktop" })).toThrow();
  });

  it("rejects a tampered payload or signature", () => {
    const { state } = signGoogleState({ client: "web" });
    const [prefix, payload, sig] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ c: "web", h: "evil.crmtree.pl", n: "x", e: Date.now() + 1e6 })).toString("base64url");
    expect(verifyGoogleState(prefix + "." + forged + "." + sig)).toBeNull();
    expect(verifyGoogleState(prefix + "." + payload + "." + sig + "x")).toBeNull();
  });

  it("rejects an expired state", () => {
    const { state } = signGoogleState({ client: "web" }, Date.now() - TTL_MS - 1000);
    expect(verifyGoogleState(state)).toBeNull();
  });

  it("rejects values that are not a google state (incl. a SAML RelayState)", () => {
    expect(verifyGoogleState(undefined)).toBeNull();
    expect(verifyGoogleState("")).toBeNull();
    expect(verifyGoogleState("m1.abc.def")).toBeNull();
  });
});
