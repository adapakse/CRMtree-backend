"use strict";
// src/routes/crm-yandex.js
//
// Yandex Mail — OAuth2 only. Mirrors the OAUTH2 section of crm-zoho.js.
//
// Mail operations (send, thread, attachments) are stage 2 and live nowhere yet:
// yandexService throws NotImplementedError for them, so there is deliberately no
// route exposing them. See the header of services/yandexService.js.
//
// Difference from the Zoho callback: Yandex has no accounts-server parameter,
// because a single set of endpoints serves every regional mailbox. There is one
// less thing to validate and one less thing to store.

const express        = require("express");
const router         = express.Router();
const { pool }       = require("../config/database");
const { requireAuth } = require("../middleware/auth");
const { crmAuth }    = require("../middleware/crm-rbac");
const yandexService  = require("../services/yandexService");
const config         = require("../config");
// requireActiveEmailProvider is not imported: it guards send/sync actions, and
// those arrive in stage 2 together with the mail routes.
const { resolveProviderGate } = require("../middleware/email-provider");

const CALLBACK_PATH = "/crm/yandex/callback";

function frontendRedirect(res, params) {
  const qs = new URLSearchParams(params).toString();
  return res.redirect(`${config.frontendUrl}${CALLBACK_PATH}?${qs}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// OAUTH2
// ═══════════════════════════════════════════════════════════════════════════════

// Each CRM user connects their own Yandex mailbox. The tenant only configures
// WHICH provider is active; the mailbox always belongs to req.user.
async function oauthUrlHandler(req, res, next) {
  try {
    const gate = await resolveProviderGate(req.tenantId, "yandex");
    if (!gate.ok) {
      return res.status(gate.active ? 403 : 400).json({
        error: gate.active
          ? `Ta organizacja korzysta z innego dostawcy poczty (${gate.active}).`
          : "Yandex nie jest aktywnym providerem dla tego tenanta.",
        code: "PROVIDER_NOT_ACTIVE",
      });
    }
    const url = await yandexService.getAuthUrl(req.user.id);
    res.json({ url });
  } catch (err) { next(err); }
}
router.get("/oauth/url", requireAuth, crmAuth, oauthUrlHandler);

// No requireAuth — Yandex redirects the browser without an Authorization
// header. userId is carried in the HMAC-signed `state` from /oauth/url.
router.get("/oauth/callback", async (req, res) => {
  try {
    const { code, error, state } = req.query;

    if (error) return frontendRedirect(res, { status: "error", reason: error });
    if (!code)  return frontendRedirect(res, { status: "error", reason: "no_code" });
    if (!state) return frontendRedirect(res, { status: "error", reason: "missing_state" });

    const userId = yandexService.parseOAuthState(state);
    if (!userId) {
      console.error("[Yandex] OAuth callback: invalid_state, raw state=", state);
      return frontendRedirect(res, { status: "error", reason: "invalid_state" });
    }

    const { rows: uRows } = await pool.query("SELECT tenant_id FROM users WHERE id = $1", [userId]);
    const tenantId = uRows[0]?.tenant_id ?? null;
    const gate = await resolveProviderGate(tenantId, "yandex");
    if (!gate.ok) {
      return frontendRedirect(res, { status: "error", reason: "provider_not_active" });
    }

    console.log("[Yandex] OAuth callback: state OK, userId=", userId);
    await yandexService.exchangeCodeAndSave(code, userId);
    console.log("[Yandex] OAuth callback: tokens saved for userId=", userId);

    return frontendRedirect(res, { status: "connected" });
  } catch (err) {
    console.error("[Yandex] OAuth callback error:", err.message, err.stack);
    if (err.code === "MAILBOX_ALREADY_CONNECTED") {
      return frontendRedirect(res, { status: "error", reason: "email_already_connected" });
    }
    return frontendRedirect(res, { status: "error", reason: "callback_failed" });
  }
});

async function statusHandler(req, res) {
  try {
    const status = await yandexService.getStatus(req.user.id);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
}
router.get("/status", requireAuth, crmAuth, statusHandler);

async function disconnectHandler(req, res) {
  try {
    await yandexService.disconnect(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
}
router.delete("/oauth/disconnect", requireAuth, crmAuth, disconnectHandler);

module.exports = router;
