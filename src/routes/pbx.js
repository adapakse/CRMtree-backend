'use strict';
// src/routes/pbx.js
//
// Softphone / PBX integration — ip-pbx.eu (Virtual PBX SaaS). Each CRMtree tenant
// has its own company/account on the provider's side; the CRM only stores a
// per-user Personal Access Token (PAT), self-service, in "Moje ustawienia".
// The backend never talks SIP itself — it proxies credential lookups to
// ip-pbx.eu, and the browser (sip.js/WebRTC) registers and places/receives
// calls directly. See CRMtree-backend/CLAUDE.md for the wider architecture note.

const express       = require('express');
const axios         = require('axios');
const { body }      = require('express-validator');
const db            = require('../config/database');
const { requireAuth }              = require('../middleware/auth');
const { crmAuth, requireFeature }  = require('../middleware/crm-rbac');
const { validate, injectAuditContext } = require('../middleware/errorHandler');
const router  = express.Router();

router.use(requireAuth, crmAuth, requireFeature('pbx'));

// Normalizuje NIP — usuwa prefix kraju (PL, DE…) i znaki niebędące cyframi
function normalizeNip(raw) {
  if (!raw) return null;
  return String(raw).replace(/^[A-Za-z]{2}/, '').replace(/\D/g, '') || null;
}

const PBX_BASE = 'https://ub24as22.ip-pbx.eu/virtualPBX/api/';

function pbxHeaders(pat) {
  return { Authorization: `Bearer ${pat}` };
}

router.get('/sip-credentials', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT pat_token FROM user_pbx_credentials WHERE user_id = $1',
      [req.user.id]
    );

    const pat = rows[0]?.pat_token;
    if (!pat) {
      return res.status(404).json({ error: 'Brak tokenu PBX. Skonfiguruj swój token w Moich ustawieniach.' });
    }

    const [credsRes, meRes] = await Promise.all([
      axios.get(`${PBX_BASE}me/sip-credentials`, { headers: pbxHeaders(pat), timeout: 8_000 }),
      axios.get(`${PBX_BASE}me`,                 { headers: pbxHeaders(pat), timeout: 8_000 }),
    ]);

    res.json({
      ...credsRes.data,
      direct_phone: meRes.data.direct_phone_number ?? null,
    });
  } catch (err) {
    const pbxStatus = err.response?.status;
    console.error('[PBX sip-credentials] error from ip-pbx.eu:', pbxStatus, JSON.stringify(err.response?.data));
    if (pbxStatus === 400 || pbxStatus === 401 || pbxStatus === 403) {
      return res.status(422).json({
        error: 'Twoje konto ip-pbx.eu nie ma przypisanego rozszerzenia SIP lub token jest nieprawidłowy. Upewnij się, że Twoje konto ip-pbx.eu ma aktywne rozszerzenie SIP.',
        pbx_detail: err.response?.data,
      });
    }
    res.status(pbxStatus || 502).json({ error: 'Błąd pobierania danych SIP z PBX', detail: err.message });
  }
});

// ── Self-service PAT — user zarządza własnym tokenem PBX ─────────────

// GET /api/pbx/my-pat — status konfiguracji (bez zwracania samego tokenu)
router.get('/my-pat', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT direct_phone, updated_at FROM user_pbx_credentials WHERE user_id = $1',
      [req.user.id]
    );
    if (!rows.length) return res.json({ configured: false });
    res.json({ configured: true, direct_phone: rows[0].direct_phone, updated_at: rows[0].updated_at });
  } catch (err) {
    res.status(500).json({ error: 'Błąd pobierania statusu PBX', detail: err.message });
  }
});

// PUT /api/pbx/my-pat — user zapisuje własny PAT; backend weryfikuje przez ip-pbx.eu /me + /me/sip-credentials
router.put('/my-pat',
  [body('pat_token').isString().notEmpty().trim()],
  validate,
  async (req, res) => {
    const pat = req.body.pat_token.trim();
    let direct_phone = null;
    try {
      const { data } = await axios.get(`${PBX_BASE}me`, { headers: pbxHeaders(pat), timeout: 8_000 });
      direct_phone = data.direct_phone_number ?? null;
    } catch (err) {
      const status = err.response?.status;
      console.warn('[pbx/my-pat] validation failed:', status, err.message);
      if (status === 400 || status === 401 || status === 403) {
        return res.status(422).json({ error: 'Nieprawidłowy token — ip-pbx.eu odrzucił autoryzację.' });
      }
      console.warn('[pbx/my-pat] /me check failed (network?):', err.message);
    }
    try {
      await db.query(`
        INSERT INTO user_pbx_credentials (user_id, pat_token, direct_phone)
        VALUES ($1,$2,$3)
        ON CONFLICT (user_id) DO UPDATE SET
          pat_token=$2, direct_phone=$3, updated_at=now()
      `, [req.user.id, pat, direct_phone]);
      res.json({ ok: true, direct_phone });
    } catch (err) {
      res.status(500).json({ error: 'Błąd zapisu tokenu', detail: err.message });
    }
  }
);

// DELETE /api/pbx/my-pat — user usuwa własny PAT
router.delete('/my-pat', async (req, res) => {
  try {
    await db.query('DELETE FROM user_pbx_credentials WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Błąd usuwania tokenu', detail: err.message });
  }
});

// Wyszukuje rozmowę w historii PBX na podstawie numeru i czasu rozpoczęcia.
// Query: number, started_at (ISO), direction (inbound|outbound)
// Returns: { call_id, direction }
router.get('/find-call', async (req, res) => {
  const { rows: patRows } = await db.query(
    'SELECT pat_token FROM user_pbx_credentials WHERE user_id = $1', [req.user.id]
  );
  const pat = patRows[0]?.pat_token;
  if (!pat) return res.status(503).json({ error: 'PBX not configured' });

  const { number, started_at, direction } = req.query;
  if (!number || !started_at) {
    return res.status(400).json({ error: 'number and started_at are required' });
  }

  const digits = String(number).replace(/\D/g, '');
  const last9  = digits.slice(-9);

  const startedAtMs = new Date(started_at).getTime();
  if (isNaN(startedAtMs)) return res.status(400).json({ error: 'Invalid started_at' });

  const pbxEndpoint = 'calls';

  const params = {
    started_from: new Date(startedAtMs - 5 * 60 * 1000).toISOString(),
    started_to:   new Date(startedAtMs + 4 * 60 * 60 * 1000).toISOString(),
    limit: 50,
  };
  // Dla wychodzących szukamy wg numeru docelowego, dla przychodzących wg numeru dzwoniącego
  if (direction === 'outbound') {
    params.called_number = last9;
  } else {
    params.caller_number = last9;
  }

  try {
    const { data } = await axios.get(`${PBX_BASE}${pbxEndpoint}`, {
      params,
      headers: pbxHeaders(pat),
      timeout: 10_000,
    });

    // API może zwrócić { calls: [...] } lub { items: [...] } lub bezpośrednio tablicę
    let calls = Array.isArray(data) ? data : (data.calls ?? data.items ?? []);

    // Fallback: jeśli number filter nie zwróciło wyników, szukaj broad i dopasuj ręcznie
    if (!calls.length) {
      const broadParams = { started_from: params.started_from, started_to: params.started_to, limit: 50 };
      try {
        const { data: data2 } = await axios.get(`${PBX_BASE}calls`, {
          params: broadParams,
          headers: pbxHeaders(pat),
          timeout: 10_000,
        });
        const allCalls = Array.isArray(data2) ? data2 : (data2.calls ?? data2.items ?? []);
        calls = allCalls.filter(c => {
          const called = String(c.called_number || '').replace(/\D/g, '');
          const caller = String(c.caller_number || '').replace(/\D/g, '');
          return called.endsWith(last9) || caller.endsWith(last9);
        });
      } catch (broadErr) {
        console.warn('[PBX find-call] broad search failed:', broadErr.message);
      }
    }

    if (!calls.length) {
      return res.status(404).json({ error: 'Call not found in PBX history' });
    }

    // Znajdź rozmowę najbliższą podanemu czasowi
    const closest = calls.sort((a, b) =>
      Math.abs(new Date(a.started_at) - new Date(started_at)) -
      Math.abs(new Date(b.started_at) - new Date(started_at))
    )[0];

    res.json({ call_id: closest.id, direction: direction || 'inbound' });
  } catch (err) {
    console.error('[PBX find-call] error:', err.response?.status, err.response?.data ?? err.message);
    const status = err.response?.status || 502;
    res.status(status).json({ error: 'PBX call lookup failed', detail: err.message });
  }
});

// Pobiera transkrypcję rozmowy z PBX.
// Próbuje endpoint właściwy dla kierunku, przy 404 próbuje drugi.
router.get('/transcription/:callId', async (req, res) => {
  const { rows: patRows } = await db.query(
    'SELECT pat_token FROM user_pbx_credentials WHERE user_id = $1', [req.user.id]
  );
  const pat = patRows[0]?.pat_token;
  if (!pat) return res.status(503).json({ error: 'PBX not configured' });

  const { callId }  = req.params;
  const { direction } = req.query;

  const primaryPath  = direction === 'outbound'
    ? `outbound-calls/${callId}/transcription`
    : `calls/${callId}/transcription`;
  const fallbackPath = direction === 'outbound'
    ? `calls/${callId}/transcription`
    : `outbound-calls/${callId}/transcription`;

  try {
    const { data } = await axios.get(`${PBX_BASE}${primaryPath}`, { headers: pbxHeaders(pat), timeout: 8_000 });
    return res.json(data);
  } catch (err) {
    if (err.response?.status !== 404) {
      return res.status(err.response?.status || 502).json({
        error: 'Transcription fetch failed', detail: err.message,
      });
    }
  }

  try {
    const { data } = await axios.get(`${PBX_BASE}${fallbackPath}`, { headers: pbxHeaders(pat), timeout: 8_000 });
    return res.json(data);
  } catch (err) {
    const status = err.response?.status || 502;
    res.status(status).json({ error: 'Transcription not available', detail: err.message });
  }
});

// Wyszukuje numer telefonu w leadach i partnerach CRM — tenant-scoped.
// Query: phone
// Returns: { found, type?, id?, company_name?, nip?, city? }
router.get('/phone-lookup', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const digits = String(phone).replace(/\D/g, '');
  const last9  = digits.slice(-9);
  if (last9.length < 7) return res.json({ found: false });

  const suffix = `%${last9}`;

  try {
    const { rows: leads } = await db.query(
      `SELECT l.id, l.company AS company_name, l.nip
       FROM crm_leads l
       WHERE l.tenant_id = $2
         AND (REGEXP_REPLACE(COALESCE(l.phone, ''), '[^0-9]', '', 'g') LIKE $1
          OR EXISTS (
            SELECT 1 FROM crm_lead_contacts c
            WHERE c.lead_id = l.id
              AND REGEXP_REPLACE(COALESCE(c.phone, ''), '[^0-9]', '', 'g') LIKE $1
          ))
       LIMIT 1`,
      [suffix, req.tenantId]
    );
    if (leads.length) {
      return res.json({ found: true, type: 'lead', ...leads[0], city: null });
    }

    const { rows: partners } = await db.query(
      `SELECT id, company AS company_name, nip
       FROM crm_partners
       WHERE tenant_id = $2
         AND (REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE $1
          OR REGEXP_REPLACE(COALESCE(billing_phone, ''), '[^0-9]', '', 'g') LIKE $1)
       LIMIT 1`,
      [suffix, req.tenantId]
    );
    if (partners.length) {
      return res.json({ found: true, type: 'partner', ...partners[0], city: null });
    }

    return res.json({ found: false });
  } catch (err) {
    console.error('[PBX phone-lookup] error:', err.message);
    return res.status(500).json({ error: 'phone lookup failed' });
  }
});

// ── POST /call-log — zapis połączenia do rejestru ─────────────────
// Wywoływany przez frontend (pbx.service.ts) przy każdym zakończeniu sesji
router.post('/call-log',
  injectAuditContext,
  [
    body('direction').isIn(['inbound', 'outbound']),
    body('status').isIn(['answered', 'missed', 'not_answered', 'rejected', 'error']),
    body('caller_number').optional().isString(),
    body('callee_number').optional().isString(),
    body('nip').optional().isString(),
    body('duration_sec').optional().isInt({ min: 0 }),
    body('started_at').optional().isISO8601(),
    body('ended_at').optional().isISO8601(),
    body('lead_id').optional({ nullable: true }).isInt(),
    body('partner_id').optional({ nullable: true }).isInt(),
  ],
  validate,
  async (req, res) => {
    try {
      const {
        direction, status,
        caller_number, callee_number,
        nip, duration_sec,
        started_at, ended_at,
        lead_id, partner_id,
      } = req.body;

      const normalizedNip = normalizeNip(nip);

      await db.query(`
        INSERT INTO pbx_call_log
          (tenant_id, direction, status, caller_number, callee_number, nip,
           duration_sec, started_at, ended_at,
           user_id, lead_id, partner_id, group_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `, [
        req.tenantId,
        direction,
        status,
        caller_number   || null,
        callee_number   || null,
        normalizedNip,
        duration_sec    ?? 0,
        started_at      || new Date().toISOString(),
        ended_at        || null,
        req.user.id,
        lead_id         || null,
        partner_id      || null,
        req.user.group_id || null,
      ]);

      res.status(201).json({ ok: true });
    } catch (err) {
      console.error('[PBX call-log] error:', err.message);
      res.status(500).json({ error: 'Błąd zapisu połączenia', detail: err.message });
    }
  }
);

module.exports = router;
