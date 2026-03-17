"use strict";

const router = require("express").Router();
const passport = require("passport");
const crypto = require("crypto");
const db = require("../config/database");
const audit = require("../services/auditService");
const {
  requireAuth,
  signAccessToken,
  signRefreshToken,
  saveRefreshToken,
} = require("../middleware/auth");
const { injectAuditContext } = require("../middleware/errorHandler");
const config = require("../config");

// ─── GET /api/auth/saml — redirect to Entra IdP ──────────
router.get("/saml", (req, res, next) => {
  console.log("[SAML] GET /saml hit");
  console.log("[SAML] Config check:", {
    entryPoint: config.saml?.entryPoint,
    issuer: config.saml?.issuer,
    callbackUrl: config.saml?.callbackUrl,
    certDefined: !!config.saml?.idpCert,
    certLength: config.saml?.idpCert?.length,
  });

  passport.authenticate("saml", { session: false }, (err, user, info) => {
    if (err) {
      console.error("[SAML] authenticate error:", err);
      return next(err);
    }
    console.log("[SAML] authenticate result — user:", user, "info:", info);
  })(req, res, next);
});

// ─── POST /api/auth/saml/callback — handle SAML assertion ─
router.post(
  "/saml/callback",
  injectAuditContext,
  (req, res, next) => {
    console.log("[SAML] POST /saml/callback hit");
    console.log("[SAML] Body keys:", Object.keys(req.body || {}));
    console.log("[SAML] SAMLResponse present:", !!req.body?.SAMLResponse);
    next();
  },
  passport.authenticate("saml", {
    session: false,
    failureRedirect: `${config.frontendUrl}/login?error=saml_failed`,
  }),
  async (req, res) => {
    console.log("[SAML] Callback success — req.user:", req.user);
    try {
      const user = req.user;
      const accessToken = signAccessToken(user);
      const { token: refreshToken, hash } = signRefreshToken(user);
      await saveRefreshToken(user.id, hash);

      await audit.log({
        user: {
          id: user.id,
          email: user.email,
          display_name: user.display_name,
        },
        action: "user_login",
        metadata: { method: "saml" },
        ipAddress: req.auditContext?.ipAddress,
        userAgent: req.auditContext?.userAgent,
      });

      // Redirect to frontend with tokens in query string
      // (frontend should immediately store them and strip URL)
      res.redirect(
        `${config.frontendUrl}/auth/callback?` +
          `access_token=${encodeURIComponent(accessToken)}&` +
          `refresh_token=${encodeURIComponent(refreshToken)}`,
      );
    } catch (err) {
      console.error("[SAML] Callback handler error:", err);
      res.redirect(`${config.frontendUrl}/login?error=auth_failed`);
    }
  },
);

// ─── POST /api/auth/refresh — exchange refresh token ──────
router.post("/refresh", injectAuditContext, async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token)
      return res.status(400).json({ error: "refresh_token required" });

    const hash = crypto
      .createHash("sha256")
      .update(refresh_token)
      .digest("hex");
    const { rows } = await db.query(
      `SELECT rt.*, u.id AS uid, u.email, u.first_name, u.last_name, u.display_name, u.is_admin, u.is_active
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.revoked = FALSE AND rt.expires_at > NOW()`,
      [hash],
    );
    if (!rows.length)
      return res
        .status(401)
        .json({ error: "Invalid or expired refresh token" });
    const row = rows[0];
    if (!row.is_active)
      return res.status(401).json({ error: "Account inactive" });

    // Rotate: revoke old, issue new
    await db.query(
      "UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1",
      [hash],
    );
    const user = {
      id: row.uid,
      email: row.email,
      display_name: row.display_name,
      is_admin: row.is_admin,
    };
    const newAccess = signAccessToken(user);
    const { token: newRefresh, hash: newHash } = signRefreshToken(user);
    await saveRefreshToken(user.id, newHash);

    res.json({ access_token: newAccess, refresh_token: newRefresh });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/auth/logout ────────────────────────────────
router.post(
  "/logout",
  requireAuth,
  injectAuditContext,
  async (req, res, next) => {
    try {
      const { refresh_token } = req.body;
      if (refresh_token) {
        const hash = crypto
          .createHash("sha256")
          .update(refresh_token)
          .digest("hex");
        await db.query(
          "UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1",
          [hash],
        );
      }
      await audit.log({
        user: req.user,
        action: "user_logout",
        ipAddress: req.auditContext?.ipAddress,
        userAgent: req.auditContext?.userAgent,
      });
      res.json({ message: "Logged out" });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/auth/me — current user info ────────────────
router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.display_name,
              u.is_admin, u.last_login_at,
              json_agg(json_build_object(
                'group_id',    ugr.group_id,
                'group_name',  gp.name,
                'group_display', gp.display_name,
                'access_level', ugr.access_level,
                'owner_restriction', gp.has_owner_restriction
              )) FILTER (WHERE ugr.group_id IS NOT NULL) AS roles
       FROM users u
       LEFT JOIN user_group_roles ugr ON ugr.user_id = u.id
       LEFT JOIN group_profiles gp    ON gp.id = ugr.group_id AND gp.is_active = TRUE
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.user.id],
    );
    res.json(rows[0] || req.user);
  } catch (err) {
    next(err);
  }
});

module.exports = router;