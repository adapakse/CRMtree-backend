"use strict";

const crypto = require("crypto");
const request = require("supertest");
const app = require("../app");
const config = require("../config");
const gmailService = require("../services/gmailService");
const { publicOnlyLookup, assertPublicHost, isBlockedAddress } = require("../utils/publicOnlyLookup");

const signState = (secret, userId, ts) =>
  `${userId}.${ts}.${crypto.createHmac("sha256", secret).update(`${userId}:${ts}`).digest("hex")}`;

describe("Gmail OAuth state", () => {
  const userId = "7b0c6f3e-2a51-4d5e-9c1a-3f0e8b6d2a10";

  it("accepts a state signed with the JWT secret", () => {
    expect(gmailService.parseOAuthState(signState(config.jwt.secret, userId, Date.now()))).toBe(userId);
  });

  it("rejects a state signed with the old public fallback secret", () => {
    const forged = signState("fallback-secret", userId, Date.now());
    expect(gmailService.parseOAuthState(forged)).toBeNull();
    expect(gmailService.parseOAuthState(forged.slice(0, forged.lastIndexOf(".") + 17))).toBeNull();
  });

  it("rejects a state older than 30 minutes", () => {
    expect(gmailService.parseOAuthState(signState(config.jwt.secret, userId, Date.now() - 31 * 60 * 1000))).toBeNull();
  });
});

describe("Web login rate limit", () => {
  it("answers 429 after 10 attempts for the same email", async () => {
    const email = `limit-${Date.now()}@example.invalid`;
    const statuses = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const res = await request(app).post("/api/auth/login").send({ email, password: "wrong-password" });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((status) => status !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("Crawler address guard", () => {
  it.each([
    ["127.0.0.1", 4], ["10.1.2.3", 4], ["172.20.0.1", 4], ["192.168.1.1", 4],
    ["169.254.169.254", 4], ["::1", 6], ["fe80::1", 6], ["::ffff:10.0.0.1", 6],
  ])("blocks %s", (address, family) => {
    expect(isBlockedAddress(address, family)).toBe(true);
  });

  it.each([["8.8.8.8", 4], ["2606:4700::1111", 6]])("allows public %s", (address, family) => {
    expect(isBlockedAddress(address, family)).toBe(false);
  });

  it("refuses literal internal IPs before connecting", () => {
    expect(() => assertPublicHost("169.254.169.254")).toThrow(/non-public/);
    expect(() => assertPublicHost("[::1]")).toThrow(/non-public/);
    expect(() => assertPublicHost("example.com")).not.toThrow();
  });

  it("fails DNS lookups that resolve to loopback", (done) => {
    publicOnlyLookup("localhost", {}, (err) => {
      expect(err && err.code).toBe("EBLOCKEDADDRESS");
      done();
    });
  });
});
