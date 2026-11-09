"use strict";

const jwt = require("jsonwebtoken");
const config = require("../config");
const { apiRateLimitKey } = require("../middleware/api-rate-limit");

const requestWith = (authorization, ip = "203.0.113.7") => ({ headers: authorization ? { authorization } : {}, ip });

describe("API rate limit key", () => {
  it("counts a signed-in request per user, so one office IP is not one shared budget", () => {
    const token = jwt.sign({ sub: "user-a" }, config.jwt.secret, { algorithm: "HS256" });
    const other = jwt.sign({ sub: "user-b" }, config.jwt.secret, { algorithm: "HS256" });
    expect(apiRateLimitKey(requestWith(`Bearer ${token}`))).toBe("user:user-a");
    expect(apiRateLimitKey(requestWith(`Bearer ${other}`))).toBe("user:user-b");
  });

  it("counts per IP without a token", () => {
    expect(apiRateLimitKey(requestWith(undefined))).toBe("ip:203.0.113.7");
  });

  it("does not trust a token signed with another secret", () => {
    const forged = jwt.sign({ sub: "user-a" }, "not-the-secret", { algorithm: "HS256" });
    expect(apiRateLimitKey(requestWith(`Bearer ${forged}`))).toBe("ip:203.0.113.7");
  });

  it("falls back to the IP for an expired token", () => {
    const expired = jwt.sign({ sub: "user-a", exp: Math.floor(Date.now() / 1000) - 60 }, config.jwt.secret, { algorithm: "HS256" });
    expect(apiRateLimitKey(requestWith(`Bearer ${expired}`))).toBe("ip:203.0.113.7");
  });
});
