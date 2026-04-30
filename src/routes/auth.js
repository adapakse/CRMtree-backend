'use strict';

const router   = require('express').Router();
const passport = require('passport');
const crypto   = require('crypto');
const db       = require('../config/database');
const audit    = require('../services/auditService');
const logger   = require('../utils/logger');   // ← DODANY (brakowało)
const { requireAuth, signAccessToken, signRefreshToken, saveRefreshToken } = require('../middleware/auth');
const { injectAuditContext } = require('../middleware/errorHandler');
const config   = require('../config');

// ─── SAML routes — aktywne TYLKO na produkcji (NODE_ENV=production) ──────────
// Lokalnie i na htcd (NODE_ENV=development) używany jest stub poniżej.
if (process.env.NODE_ENV !== 'development') {

  // GET /api/auth/saml — redirect do IdP (Google Workspace)
  router.get('/saml', (req, res, next) => {
    logger.info('[SAML] Inicjowanie logowania → redirect do IdP', {
      entryPoint:  config.saml?.entryPoint,
      issuer:      config.saml?.issuer,
      certDefined: !!config.saml?.idpCert,
    });
    passport.authenticate('saml', { session: false })(req, res, next);
  });

  // POST /api/auth/saml/callback — Google odsyła SAML assertion tutaj
  router.post(
    '/saml/callback',
    injectAuditContext,
    (req, res, next) => {
      // ── DIAGNOSTYKA CERTYFIKATU — usuń po naprawieniu ─────────────────
      try {
        if (req.body?.SAMLResponse) {
          const xml = Buffer.from(req.body.SAMLResponse, 'base64').toString('utf8');
          // Wyciągnij certyfikat z odpowiedzi IdP
          const certMatch = xml.match(/<(?:[^:>]+:)?X509Certificate[^>]*>([^<]+)<\/(?:[^:>]+:)?X509Certificate>/);
          if (certMatch) {
            const certFromResponse = certMatch[1].replace(/\s+/g, '');
            const certFromEnv      = (config.saml?.idpCert || '').replace(/\s+/g, '')
                                       .replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----/g, '');
            logger.info('[SAML] Porównanie certyfikatów', {
              cert_in_response_length: certFromResponse.length,
              cert_in_response_start:  certFromResponse.slice(0, 40),
              cert_in_env_length:      certFromEnv.length,
              cert_in_env_start:       certFromEnv.slice(0, 40),
              certs_match:             certFromResponse === certFromEnv,
            });
          } else {
            logger.warn('[SAML] Brak X509Certificate w odpowiedzi IdP');
          }
        }
      } catch (diagErr) {
        logger.warn('[SAML] Błąd diagnostyki cert', { err: diagErr.message });
      }
      // ── KONIEC DIAGNOSTYKI ─────────────────────────────────────────────
      logger.info('[SAML] Odebrano callback', {
        hasSamlResponse: !!req.body?.SAMLResponse,
      });
      next();
    },
    passport.authenticate('saml', {
      session:         false,
      failureRedirect: `${config.frontendUrl}/login?error=saml_failed`,
    }),
    async (req, res) => {
      try {
        const user = req.user;
        logger.info('[SAML] Uwierzytelnienie pomyślne', { email: user.email });

        const accessToken                   = signAccessToken(user);
        const { token: refreshToken, hash } = signRefreshToken(user);
        await saveRefreshToken(user.id, hash);

        await audit.log({
          user:      { id: user.id, email: user.email, display_name: user.display_name },
          action:    'user_login',
          metadata:  { method: 'saml_google' },
          ipAddress: req.auditContext?.ipAddress,
          userAgent: req.auditContext?.userAgent,
        });

        // Przekieruj do frontendu — ten sam mechanizm co dev stub
        res.redirect(
          `${config.frontendUrl}/auth/callback?` +
          `access_token=${encodeURIComponent(accessToken)}&` +
          `refresh_token=${encodeURIComponent(refreshToken)}`
        );
      } catch (err) {
        logger.error('[SAML] Błąd handlera callback', { err: err.message });
        res.redirect(`${config.frontendUrl}/login?error=auth_failed`);
      }
    }
  );

}

// ─── POST /api/auth/refresh — rotacja tokenów ────────────────────────────────
router.post('/refresh', injectAuditContext, async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

    const hash = crypto.createHash('sha256').update(refresh_token).digest('hex');
    const { rows } = await db.query(
      `SELECT rt.*, u.id AS uid, u.email, u.first_name, u.last_name,
              u.display_name, u.is_admin, u.is_active, u.crm_role
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.revoked = FALSE AND rt.expires_at > NOW()`,
      [hash]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid or expired refresh token' });
    const row = rows[0];
    if (!row.is_active) return res.status(401).json({ error: 'Account inactive' });

    // Rotacja: unieważnij stary, wydaj nowy
    await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1', [hash]);
    const user       = { id: row.uid, email: row.email, display_name: row.display_name, is_admin: row.is_admin };
    const newAccess  = signAccessToken(user);
    const { token: newRefresh, hash: newHash } = signRefreshToken(user);
    await saveRefreshToken(user.id, newHash);

    res.json({ access_token: newAccess, refresh_token: newRefresh });
  } catch (err) { next(err); }
});

// ─── POST /api/auth/logout ───────────────────────────────────────────────────
router.post('/logout', requireAuth, injectAuditContext, async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (refresh_token) {
      const hash = crypto.createHash('sha256').update(refresh_token).digest('hex');
      await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1', [hash]);
    }
    await audit.log({
      user:      req.user,
      action:    'user_logout',
      ipAddress: req.auditContext?.ipAddress,
      userAgent: req.auditContext?.userAgent,
    });
    res.json({ message: 'Logged out' });
  } catch (err) { next(err); }
});

// ─── GET /api/auth/me — dane zalogowanego użytkownika ───────────────────────
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.display_name,
              u.is_admin, u.crm_role, u.last_login_at,
              json_agg(json_build_object(
                'group_id',          ugr.group_id,
                'group_name',        gp.name,
                'group_display',     gp.display_name,
                'access_level',      ugr.access_level,
                'owner_restriction', gp.has_owner_restriction
              )) FILTER (WHERE ugr.group_id IS NOT NULL) AS roles
       FROM users u
       LEFT JOIN user_group_roles ugr ON ugr.user_id = u.id
       LEFT JOIN group_profiles gp    ON gp.id = ugr.group_id AND gp.is_active = TRUE
       WHERE u.id = $1
       GROUP BY u.id, u.crm_role`,
      [req.user.id]
    );
    res.json(rows[0] || req.user);
  } catch (err) { next(err); }
});

// ─── DEV STUB — aktywny WYŁĄCZNIE gdy NODE_ENV=development ──────────────────
// Na produkcji (NODE_ENV=production) ten blok nie istnieje → endpoint 404.
if (process.env.NODE_ENV === 'development') {

  // GET /api/auth/saml — dev HTML stub zamiast redirectu do Google
  router.get('/saml', async (req, res) => {
    const { rows } = await db.query(
      `SELECT email, display_name FROM users WHERE is_active = true ORDER BY display_name`
    );
    const options = rows.map(u =>
      `<option value="${u.email}">${u.display_name} (${u.email})</option>`
    ).join('\n');

    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline'"
    );

    res.send(`<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <title>DEV Login — CRMtree</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0faf4; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: white; border-radius: 14px; padding: 36px 40px; box-shadow: 0 8px 32px rgba(59,170,93,.15); width: 100%; max-width: 380px; }
    .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
    .logo-icon { width: 36px; height: 36px; background: #3BAA5D; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
    .logo-icon svg { width: 22px; height: 22px; }
    .logo-text { font-size: 20px; font-weight: 800; color: #111827; }
    .logo-text span { color: #3BAA5D; }
    .badge { display: inline-block; background: #fef3c7; color: #92400e; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 20px; letter-spacing: .4px; margin-bottom: 16px; }
    h1 { font-size: 15px; font-weight: 700; color: #111827; margin-bottom: 4px; }
    p  { font-size: 13px; color: #6b7280; margin-bottom: 24px; }
    label { display: block; font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 6px; }
    select, input { width: 100%; padding: 9px 12px; border: 1.5px solid #d1d5db; border-radius: 8px; font-size: 13px; outline: none; font-family: inherit; margin-bottom: 16px; }
    select:focus, input:focus { border-color: #3BAA5D; box-shadow: 0 0 0 3px rgba(59,170,93,.12); }
    button { width: 100%; padding: 10px; background: #3BAA5D; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background .15s; }
    button:hover { background: #2F8F4D; }
    button:disabled { background: #d1d5db; cursor: not-allowed; }
    .err { color: #dc2626; font-size: 12px; margin-top: 10px; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-icon">
        <svg viewBox="0 0 100 82" fill="none" stroke="white" stroke-linecap="round" stroke-linejoin="round">
          <path d="M50 82 Q50 70 50 58" stroke-width="6"/><path d="M50 58 Q45 50 34 43" stroke-width="4.5"/><path d="M50 58 Q55 50 66 43" stroke-width="4.5"/><path d="M34 43 Q20 37 9 35" stroke-width="3.5"/><path d="M66 43 Q80 37 91 35" stroke-width="3.5"/><path d="M50 52 Q50 42 50 34" stroke-width="3"/><path d="M50 34 Q46 26 43 20" stroke-width="2.5"/><path d="M50 34 Q54 26 57 20" stroke-width="2.5"/>
        </svg>
      </div>
      <div class="logo-text">CRM<span>tree</span></div>
    </div>
    <div class="badge">⚠ DEV MODE — lokalny bypass SSO</div>
    <p>Wybierz użytkownika lub wpisz e-mail aby zalogować się z pominięciem Google SSO.</p>
    <label for="userSelect">Użytkownik</label>
    <select id="userSelect">
      <option value="">— wybierz lub wpisz poniżej —</option>
      ${options}
    </select>
    <label for="emailInput">Lub wpisz e-mail</label>
    <input id="emailInput" type="email" placeholder="user@firma.com">
    <button id="loginBtn">Zaloguj →</button>
    <div class="err" id="errMsg"></div>
  </div>
  <script>
    document.getElementById('userSelect').addEventListener('change', function () {
      if (this.value) document.getElementById('emailInput').value = this.value;
    });
    document.getElementById('loginBtn').addEventListener('click', async function () {
      const btn   = document.getElementById('loginBtn');
      const err   = document.getElementById('errMsg');
      const email = document.getElementById('emailInput').value.trim() || document.getElementById('userSelect').value;
      if (!email) { err.style.display = 'block'; err.textContent = 'Wybierz lub wpisz e-mail.'; return; }
      btn.disabled = true; btn.textContent = 'Logowanie…'; err.style.display = 'none';
      try {
        const r = await fetch('/api/auth/dev-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Błąd logowania');
        window.location.href = '/auth/callback?access_token=' + encodeURIComponent(d.access_token) + '&refresh_token=' + encodeURIComponent(d.refresh_token);
      } catch (e) { err.style.display = 'block'; err.textContent = e.message; btn.disabled = false; btn.textContent = 'Zaloguj →'; }
    });
  </script>
</body>
</html>`);
  });

  // POST /api/auth/dev-login
  router.post('/dev-login', injectAuditContext, async (req, res, next) => {
    try {
      const email = (req.body.email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'email required' });

      const { rows } = await db.query(
        `SELECT id, email, display_name, is_admin, is_active, crm_role
         FROM users WHERE lower(email) = $1 AND is_active = true LIMIT 1`,
        [email]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found or inactive' });

      const user                            = rows[0];
      const accessToken                     = signAccessToken(user);
      const { token: refreshToken, hash }   = signRefreshToken(user);
      await saveRefreshToken(user.id, hash);

      await audit.log({
        user:      { id: user.id, email: user.email, display_name: user.display_name },
        action:    'user_login',
        metadata:  { method: 'dev_bypass' },
        ipAddress: req.auditContext?.ipAddress,
        userAgent: req.auditContext?.userAgent,
      });

      res.json({ access_token: accessToken, refresh_token: refreshToken, user });
    } catch (err) { next(err); }
  });
}

// Endpoint diagnostyczny SAML
router.get('/saml-diag', (req, res) => {
  const cert     = config.saml?.idpCert;
  const rawCert  = cert ? cert.replace(/\s+/g, '') : '';
  const passport = require('passport');
  res.json({
    node_env:        process.env.NODE_ENV,
    strategy_loaded: !!(passport._strategies && passport._strategies.saml),
    entry_point:     config.saml?.entryPoint  || 'MISSING',
    issuer:          config.saml?.issuer      || 'MISSING',
    callback_url:    config.saml?.callbackUrl || 'MISSING',
    cert_length:     rawCert.length,
    cert_starts:     rawCert.slice(0, 20),
    cert_ends:       rawCert.slice(-20),
  });
});

module.exports = router;
