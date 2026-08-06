'use strict';
// src/routes/crm-email.js
//
// Unified CRM email API — the ONLY endpoints the frontend should call for
// connect/status/send/thread/sync. It resolves the tenant's active email
// provider (tenants.active_email_provider, see config/email-providers.js)
// server-side and delegates to that provider's existing, already-tested
// route handlers — the CRM user never picks or switches a provider.
//
// Provider-specific routes (crm-gmail.js/crm-outlook.js/crm-zoho.js) remain
// mounted separately for their OAuth callbacks (Google/Microsoft/Zoho redirect
// the browser straight to them) and stay independently guarded by
// requireActiveEmailProvider, so calling them directly is also safe.
//
// crm_training_mode (demo tenants) bypasses provider resolution entirely —
// it must keep working with zero tenant email configuration, exactly as
// before. Gmail's handlers already implement the training-mode short-circuit
// (fake IDs, no real API calls), so training-mode requests are routed there
// regardless of the tenant's configured provider.

const express  = require('express');
const router   = express.Router();
const { requireAuth } = require('../middleware/auth');
const { crmAuth }     = require('../middleware/crm-rbac');
const { isTrainingMode } = require('../utils/trainingMode');
const { EMAIL_PROVIDERS } = require('../config/email-providers');
const db = require('../config/database');

const gmailRouter   = require('./crm-gmail');
const outlookRouter = require('./crm-outlook');
const zohoRouter    = require('./crm-zoho');

const PROVIDER_HANDLERS = {
  gmail:   gmailRouter.handlers,
  outlook: outlookRouter.handlers,
  zoho:    zohoRouter.handlers,
};

let upload = null;
try {
  const multer = require('multer');
  upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
} catch (_) {
  console.warn('[Email] multer niedostępny — wysyłka bez załączników.');
}

const NOT_CONFIGURED = {
  error: 'Poczta nie jest skonfigurowana dla tej organizacji. Skontaktuj się z administratorem.',
  code: 'PROVIDER_NOT_ACTIVE',
};

async function getActiveProvider(tenantId) {
  if (!tenantId) return null;
  const { rows } = await db.query(
    'SELECT active_email_provider FROM tenants WHERE id = $1',
    [tenantId],
  );
  return rows[0]?.active_email_provider || null;
}

function sendProviderError(res, err, fallbackMessage) {
  const status = err.code === 'PROVIDER_NOT_CONFIGURED' ? (err.status || 400) : 500;
  res.status(status).json({
    error: status === 500 ? fallbackMessage + err.message : err.message,
    ...(err.code ? { code: err.code } : {}),
  });
}

// ── status ────────────────────────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
  try {
    if (await isTrainingMode(req.tenantId)) {
      return res.json({ provider: null, training: true, configured: true, connected: true });
    }
    const provider = await getActiveProvider(req.tenantId);
    if (!provider) {
      return res.json({ provider: null, training: false, configured: false, connected: false });
    }
    const real = await EMAIL_PROVIDERS[provider].service.getTenantMailboxStatus(req.tenantId);
    res.json({ provider, training: false, configured: true, ...real });
  } catch (err) {
    console.error('[Email] status error:', err.message);
    res.status(500).json({ error: 'Błąd serwera' });
  }
});

// Connecting/changing/disconnecting the shared company mailbox is a
// superadmin-only action performed from Tenant → Email (see admin-tenants.js
// and crm-gmail.js/crm-outlook.js/crm-zoho.js oauth/url|disconnect routes).
// Regular CRM users only send from the tenant's mailbox — no connect/disconnect here.

// ── send — lead ───────────────────────────────────────────────────────────
async function dispatchSendLead(req, res) {
  try {
    if (await isTrainingMode(req.tenantId)) {
      return PROVIDER_HANDLERS.gmail.sendLead(req, res);
    }
    const provider = await getActiveProvider(req.tenantId);
    if (!provider) return res.status(400).json(NOT_CONFIGURED);
    return PROVIDER_HANDLERS[provider].sendLead(req, res);
  } catch (err) {
    console.error('[Email] send/lead error:', err.message);
    sendProviderError(res, err, 'Błąd wysyłki emaila: ');
  }
}
if (upload) {
  router.post('/send/lead/:leadId', requireAuth, crmAuth, upload.array('attachments', 10), dispatchSendLead);
} else {
  router.post('/send/lead/:leadId', requireAuth, crmAuth, dispatchSendLead);
}

// ── send — partner ────────────────────────────────────────────────────────
async function dispatchSendPartner(req, res) {
  try {
    if (await isTrainingMode(req.tenantId)) {
      return PROVIDER_HANDLERS.gmail.sendPartner(req, res);
    }
    const provider = await getActiveProvider(req.tenantId);
    if (!provider) return res.status(400).json(NOT_CONFIGURED);
    return PROVIDER_HANDLERS[provider].sendPartner(req, res);
  } catch (err) {
    console.error('[Email] send/partner error:', err.message);
    sendProviderError(res, err, 'Błąd wysyłki emaila: ');
  }
}
if (upload) {
  router.post('/send/partner/:partnerId', requireAuth, crmAuth, upload.array('attachments', 10), dispatchSendPartner);
} else {
  router.post('/send/partner/:partnerId', requireAuth, crmAuth, dispatchSendPartner);
}

// ── thread — lead / partner ───────────────────────────────────────────────
router.get('/thread/lead/:leadId/:threadId', requireAuth, crmAuth, async (req, res) => {
  try {
    const provider = await getActiveProvider(req.tenantId);
    if (!provider) return res.status(400).json(NOT_CONFIGURED);
    return PROVIDER_HANDLERS[provider].threadLead(req, res);
  } catch (err) {
    res.status(500).json({ error: 'Błąd pobierania wątku: ' + err.message });
  }
});

router.get('/thread/partner/:partnerId/:threadId', requireAuth, crmAuth, async (req, res) => {
  try {
    const provider = await getActiveProvider(req.tenantId);
    if (!provider) return res.status(400).json(NOT_CONFIGURED);
    return PROVIDER_HANDLERS[provider].threadPartner(req, res);
  } catch (err) {
    res.status(500).json({ error: 'Błąd pobierania wątku: ' + err.message });
  }
});

// ── debug/process — manual "check for new messages" ─────────────────────
router.post('/debug/process', requireAuth, crmAuth, async (req, res) => {
  try {
    if (await isTrainingMode(req.tenantId)) {
      return res.json({ ok: true, training: true, newMessages_found: 0 });
    }
    const provider = await getActiveProvider(req.tenantId);
    if (!provider) return res.status(400).json(NOT_CONFIGURED);
    return PROVIDER_HANDLERS[provider].debugProcess(req, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
