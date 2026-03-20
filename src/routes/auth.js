'use strict';

const router  = require('express').Router();
const passport = require('passport');
const crypto   = require('crypto');
const db       = require('../config/database');
const audit    = require('../services/auditService');
const { requireAuth, signAccessToken, signRefreshToken, saveRefreshToken } = require('../middleware/auth');
const { injectAuditContext } = require('../middleware/errorHandler');
const config   = require('../config');

// ─── SAML routes — aktywne TYLKO poza lokalnym środowiskiem deweloperskim ──────
// Lokalnie (NODE_ENV=development) strategia SAML nie jest skonfigurowana
// (brak certyfikatów IdP), dlatego trasy nie są rejestrowane.
// Na serwerze (staging/production) działają bez żadnych zmian.
if (process.env.NODE_ENV !== 'development') {

  // GET /api/auth/saml — redirect to IdP
  router.get('/saml', (req, res, next) => {
    logger.info('[SAML] GET /saml — redirecting to IdP', {
      entryPoint: config.saml?.entryPoint,
      issuer:     config.saml?.issuer,
      certDefined: !!config.saml?.idpCert,
    });
    passport.authenticate('saml', { session: false })(req, res, next);
  });

  // POST /api/auth/saml/callback — handle SAML assertion
  router.post('/saml/callback',
    injectAuditContext,
    (req, res, next) => {
      logger.info('[SAML] POST /saml/callback', {
        bodyKeys:        Object.keys(req.body || {}),
        samlResponseOk:  !!req.body?.SAMLResponse,
      });
      next();
    },
    passport.authenticate('saml', { session: false, failureRedirect: `${config.frontendUrl}/login?error=saml_failed` }),
    async (req, res) => {
      try {
        const user = req.user;
        logger.info('[SAML] Callback success', { email: user.email });
        const accessToken = signAccessToken(user);
        const { token: refreshToken, hash } = signRefreshToken(user);
        await saveRefreshToken(user.id, hash);

        await audit.log({
          user:      { id: user.id, email: user.email, display_name: user.display_name },
          action:    'user_login',
          metadata:  { method: 'saml' },
          ipAddress: req.auditContext?.ipAddress,
          userAgent: req.auditContext?.userAgent,
        });

        res.redirect(
          `${config.frontendUrl}/auth/callback?` +
          `access_token=${encodeURIComponent(accessToken)}&` +
          `refresh_token=${encodeURIComponent(refreshToken)}`
        );
      } catch (err) {
        logger.error('[SAML] Callback handler error', { err: err.message });
        res.redirect(`${config.frontendUrl}/login?error=auth_failed`);
      }
    }
  );

}

// ─── POST /api/auth/refresh — exchange refresh token ──────
router.post('/refresh', injectAuditContext, async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

    const hash = crypto.createHash('sha256').update(refresh_token).digest('hex');
    const { rows } = await db.query(
      `SELECT rt.*, u.id AS uid, u.email, u.first_name, u.last_name, u.display_name, u.is_admin, u.is_active
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.revoked = FALSE AND rt.expires_at > NOW()`,
      [hash]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid or expired refresh token' });
    const row = rows[0];
    if (!row.is_active) return res.status(401).json({ error: 'Account inactive' });

    // Rotate: revoke old, issue new
    await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1', [hash]);
    const user = { id: row.uid, email: row.email, display_name: row.display_name, is_admin: row.is_admin };
    const newAccess  = signAccessToken(user);
    const { token: newRefresh, hash: newHash } = signRefreshToken(user);
    await saveRefreshToken(user.id, newHash);

    res.json({ access_token: newAccess, refresh_token: newRefresh });
  } catch (err) { next(err); }
});

// ─── POST /api/auth/logout ────────────────────────────────
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

// ─── GET /api/auth/me — current user info ────────────────
router.get('/me', requireAuth, async (req, res, next) => {
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
      [req.user.id]
    );
    res.json(rows[0] || req.user);
  } catch (err) { next(err); }
});

// ─── POST /api/auth/dev-login — lokalny bypass SAML ──────────────────────────
// Aktywny WYŁĄCZNIE gdy NODE_ENV=development (ustawione w .env lokalnym).
// Na środowisku serwerowym (staging/production) ten endpoint zwraca 404 —
// nie wymaga żadnych zmian po stronie DevOps przy merge do master.
if (process.env.NODE_ENV === 'development') {

  // ── GET /api/auth/saml — dev stub ────────────────────────────────────────────
  // Zastępuje redirect do IdP. Serwuje prosty formularz HTML który wywołuje
  // /api/auth/dev-login i zapisuje tokeny do localStorage tak jak robi to
  // normalny SAML callback → frontend nie wymaga żadnych zmian.
  router.get('/saml', async (req, res) => {
    const { rows } = await db.query(
      `SELECT email, display_name FROM users WHERE is_active = true ORDER BY display_name`
    );
    const options = rows.map(u =>
      `<option value="${u.email}">${u.display_name} (${u.email})</option>`
    ).join('\n');

    // Nadpisujemy CSP tylko dla tej strony dev — globalna konfiguracja Helmet
    // pozostaje nienaruszona dla wszystkich innych endpointów.
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline'"
    );

    res.send(`<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <title>DEV Login — WorkTripsDoc</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f3f4f6; display: flex; align-items: center;
      justify-content: center; min-height: 100vh;
    }
    .card {
      background: white; border-radius: 14px; padding: 36px 40px;
      box-shadow: 0 8px 32px rgba(0,0,0,.12); width: 100%; max-width: 380px;
    }
    .badge {
      display: inline-block; background: #fef3c7; color: #92400e;
      font-size: 11px; font-weight: 700; padding: 3px 10px;
      border-radius: 20px; letter-spacing: .4px; margin-bottom: 18px;
    }
    h1 { font-size: 20px; font-weight: 700; color: #111827; margin-bottom: 4px; }
    p  { font-size: 13px; color: #6b7280; margin-bottom: 24px; }
    label { display: block; font-size: 12px; font-weight: 600;
            color: #374151; margin-bottom: 6px; }
    select, input {
      width: 100%; padding: 9px 12px; border: 1.5px solid #d1d5db;
      border-radius: 8px; font-size: 13px; outline: none;
      font-family: inherit; margin-bottom: 16px;
    }
    select:focus, input:focus { border-color: #f97316; }
    button {
      width: 100%; padding: 10px; background: #f97316; color: white;
      border: none; border-radius: 8px; font-size: 14px; font-weight: 600;
      cursor: pointer; transition: background .15s;
    }
    button:hover { background: #ea6c0a; }
    button:disabled { background: #d1d5db; cursor: not-allowed; }
    .err { color: #dc2626; font-size: 12px; margin-top: 10px; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">⚠ DEV MODE — lokalny bypass SAML</div>
    <h1>WorkTripsDoc</h1>
    <p>Wybierz użytkownika lub wpisz e-mail aby zalogować się z pominięciem SAML.</p>
    <label for="userSelect">Użytkownik</label>
    <select id="userSelect">
      <option value="">— wybierz lub wpisz poniżej —</option>
      ${options}
    </select>
    <label for="emailInput">Lub wpisz e-mail</label>
    <input id="emailInput" type="email" placeholder="user@worktrips.com">
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
      const email = document.getElementById('emailInput').value.trim()
                 || document.getElementById('userSelect').value;
      if (!email) {
        err.style.display = 'block';
        err.textContent = 'Wybierz lub wpisz e-mail.';
        return;
      }
      btn.disabled = true; btn.textContent = 'Logowanie…'; err.style.display = 'none';
      try {
        const r = await fetch('/api/auth/dev-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Błąd logowania');
        // Przekierowanie identyczne jak prawdziwy SAML callback —
        // frontend sam zapisze tokeny do sessionStorage pod właściwymi kluczami.
        window.location.href =
          '/auth/callback?access_token=' + encodeURIComponent(d.access_token) +
          '&refresh_token='              + encodeURIComponent(d.refresh_token);
      } catch (e) {
        err.style.display = 'block';
        err.textContent = e.message;
        btn.disabled = false; btn.textContent = 'Zaloguj →';
      }
    });
  </script>
</body>
</html>`);
  });

  // ── POST /api/auth/dev-login ─────────────────────────────────────────────────
  router.post('/dev-login', injectAuditContext, async (req, res, next) => {
    try {
      const email = (req.body.email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'email required' });

      const { rows } = await db.query(
        `SELECT id, email, display_name, is_admin, is_active, crm_role
         FROM users
         WHERE lower(email) = $1 AND is_active = true
         LIMIT 1`,
        [email]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found or inactive' });

      const user = rows[0];
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

module.exports = router;
