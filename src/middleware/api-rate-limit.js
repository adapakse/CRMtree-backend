"use strict";

const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const config = require("../config");
const logger = require("../utils/logger");

// Signed-in requests are counted per user, not per IP: a whole office sits
// behind one public IP, so a shared per-IP budget ran out during the working
// day and colleagues got empty screens (HTTP 429). Requests without a valid
// token still count per IP.
function apiRateLimitKey(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    try {
      const { sub } = jwt.verify(header.slice(7), config.jwt.secret, { algorithms: ["HS256"] });
      if (sub) return `user:${sub}`;
    } catch {
      // Expired or invalid token: fall back to the IP, the request is rejected later anyway.
    }
  }
  return `ip:${req.ip}`;
}

// Note: req.path is relative to the '/api/' mount, hence '/auth/...'. Auth
// routes have their own limits; external webhooks retry in bursts.
function isExemptFromApiRateLimit(req) {
  return (
    config.isDev ||
    req.path.startsWith("/auth/") ||
    req.path === "/signing/webhook" ||
    req.path === "/crm/whatsapp/webhook"
  );
}

const apiRateLimit = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: apiRateLimitKey,
  skip: isExemptFromApiRateLimit,
  // The limiter runs before the request log, so without this a 429 left no trace.
  handler: (req, res, _next, options) => {
    logger.warn("API rate limit exceeded", {
      path: req.path,
      keyType: apiRateLimitKey(req).startsWith("user:") ? "user" : "ip",
    });
    res.status(options.statusCode).json({ error: "Too many requests, please try again later." });
  },
});

module.exports = { apiRateLimit, apiRateLimitKey };
