'use strict';

const router   = require('express').Router();
const passport = require('passport');
const crypto   = require('crypto');
const db       = require('../config/database');
const audit    = require('../services/auditService');
const logger   = require('../utils/logger');   // ← DODANY (brakowało)
const bcrypt   = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireAdmin, signAccessToken, signRefreshToken, saveRefreshToken } = require('../middleware/auth');
const { injectAuditContext } = require('../middleware/errorHandler');
const config   = require('../config');
const { matchTenantSlug, resolveRequestHost } = require('../config/tenantHost');

// Resolves the active tenant id for a recognized tenant-subdomain request host,
// or undefined when the host isn't a tenant-subdomain shape (universal app.*
// login, which must still allow any tenant's email — ambiguity there is a
// separate, unresolved problem). Mirrors the guard in middleware/auth.js so
// the same hostname always means the same tenant at login time and after.
async function resolveHostTenantId(req) {
  const hostSlug = matchTenantSlug(resolveRequestHost(req));
  if (!hostSlug) return undefined;
  const { rows } = await db.query(
    'SELECT id FROM tenants WHERE slug = $1 AND is_active = true AND deleted_at IS NULL LIMIT 1',
    [hostSlug]
  );
  return rows[0]?.id ?? null;
}

// Blocks new token issuance (password login, SAML, dev-login) for a
// soft-deleted tenant — the same live-DB check requireAuth already does on
// every request for already-issued tokens, applied here at the point a
// fresh token would otherwise be handed out.
async function isTenantDeleted(tenantId) {
  if (!tenantId) return false;
  const { rows } = await db.query('SELECT deleted_at FROM tenants WHERE id = $1', [tenantId]);
  return !!rows[0]?.deleted_at;
}

async function isTenantSuspended(tenantId) {
  if (!tenantId) return false;
  const { rows } = await db.query('SELECT is_active FROM tenants WHERE id = $1', [tenantId]);
  return rows[0]?.is_active === false;
}

// ─── SAML routes — aktywne TYLKO na produkcji (NODE_ENV=production) ──────────
// Lokalnie i na htcd (NODE_ENV=development) używany jest stub poniżej.
if (process.env.NODE_ENV !== 'development') {

  // SAML strategy is only registered in middleware/auth.js when SAML_IDP_CERT
  // is set — calling passport.authenticate('saml') without it throws
  // "Unknown authentication strategy" and crashes the request. Guard both
  // routes so an unconfigured tenant gets a clean error instead of a 500.
  const samlNotConfigured = (req, res) => {
    res.status(503).json({ error: 'Logowanie SSO (SAML) nie jest jeszcze skonfigurowane dla tego tenanta.' });
  };

  // GET /api/auth/saml — redirect do IdP (Google Workspace)
  router.get('/saml', (req, res, next) => {
    if (!config.saml?.idpCert) return samlNotConfigured(req, res);
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
    (req, res, next) => (config.saml?.idpCert ? next() : samlNotConfigured(req, res)),
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

        if (await isTenantDeleted(user.tenant_id)) {
          logger.warn('[SAML] Tenant usunięty — odmowa logowania', { email: user.email, tenantId: user.tenant_id });
          return res.redirect(`${config.frontendUrl}/login?error=tenant_deleted`);
        }

        const accessToken                   = signAccessToken(user);
        const { token: refreshToken, hash } = signRefreshToken(user);
        await saveRefreshToken(user.id, user.tenant_id, hash);

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
              u.display_name, u.is_admin, u.is_active, u.crm_role,
              u.tenant_id, u.is_super_admin
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [hash]
    );
    const row = rows[0];

    // A rotated mobile token presented again means it was copied — the
    // legitimate app always holds only the newest one. Revoke the whole
    // family (this account on this device) so a stolen token dies with it.
    if (row?.revoked && row.client === 'mobile') {
      await db.query(
        `UPDATE refresh_tokens SET revoked = TRUE
          WHERE user_id = $1 AND device_id = $2 AND client = 'mobile' AND revoked = FALSE`,
        [row.user_id, row.device_id]
      );
      logger.warn('[auth] Mobile refresh token reuse — device family revoked', { userId: row.user_id, deviceId: row.device_id });
      return res.status(401).json({ error: 'Invalid or expired refresh token', code: 'REFRESH_TOKEN_REUSED' });
    }
    if (!row || row.revoked || new Date(row.expires_at) <= new Date()) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }
    if (!row.is_active) return res.status(401).json({ error: 'Account inactive' });
    if (await isTenantDeleted(row.tenant_id)) return res.status(401).json({ error: 'Tenant nie jest już dostępny.' });
    // Mobile only, matching /auth/mobile/login: a suspended tenant (is_active
    // = false, toggled by a superadmin) must not keep 60-day device sessions
    // alive. Web login doesn't check suspension today, so web refresh doesn't either.
    if (row.client === 'mobile' && await isTenantSuspended(row.tenant_id)) {
      return res.status(401).json({ error: 'Tenant nie jest już dostępny.', code: 'TENANT_INACTIVE' });
    }

    // Rotacja: unieważnij stary, wydaj nowy. revoked = FALSE in the WHERE
    // makes it atomic — two concurrent refreshes with one token can't both win.
    const { rowCount } = await db.query(
      'UPDATE refresh_tokens SET revoked = TRUE, last_used_at = NOW() WHERE token_hash = $1 AND revoked = FALSE',
      [hash]
    );
    if (!rowCount) return res.status(401).json({ error: 'Invalid or expired refresh token' });
    const user       = { id: row.uid, email: row.email, display_name: row.display_name,
                         is_admin: row.is_admin, tenant_id: row.tenant_id, is_super_admin: row.is_super_admin };
    const newAccess  = signAccessToken(user, { client: row.client });
    const { token: newRefresh, hash: newHash } = signRefreshToken(user);
    await saveRefreshToken(user.id, user.tenant_id, newHash, {
      client: row.client, deviceId: row.device_id, deviceName: row.device_name,
    });

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

// ─── POST /api/auth/login — email + password ────────────────────────────────
router.post('/login', injectAuditContext, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email i password są wymagane' });
    }

    // When logging in on a recognized tenant subdomain, scope the lookup to
    // that tenant — otherwise the same email registered on multiple tenants
    // resolves nondeterministically (whichever row LIMIT 1 happens to return)
    // and the session gets rejected right after by the TENANT_HOST_MISMATCH
    // guard in middleware/auth.js. The universal app.* host has no slug to
    // scope by and keeps the old (still ambiguous) behavior.
    const hostTenantId = await resolveHostTenantId(req);
    if (hostTenantId === null) {
      return res.status(401).json({ error: 'Nieprawidłowy email lub hasło' });
    }
    const params = [email.trim()];
    let tenantFilter = '';
    if (hostTenantId !== undefined) {
      tenantFilter = 'AND tenant_id = $2';
      params.push(hostTenantId);
    }

    const { rows } = await db.query(
      `SELECT id, email, first_name, last_name, display_name,
              is_admin, is_active, crm_role, tenant_id, is_super_admin,
              password_hash, must_change_password
       FROM users WHERE lower(email) = lower($1) ${tenantFilter} LIMIT 1`,
      params
    );

    if (!rows.length) {
      return res.status(401).json({ error: 'Nieprawidłowy email lub hasło' });
    }
    const user = rows[0];

    if (!user.is_active)      return res.status(401).json({ error: 'Konto jest nieaktywne' });
    if (await isTenantDeleted(user.tenant_id)) return res.status(401).json({ error: 'Tenant nie jest już dostępny.' });
    if (!user.password_hash)  return res.status(401).json({ error: 'To konto używa logowania SSO — zaloguj się przez Google Workspace' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Nieprawidłowy email lub hasło' });

    const accessToken              = signAccessToken(user);
    const { token: refreshToken, hash } = signRefreshToken(user);
    await saveRefreshToken(user.id, user.tenant_id, hash);
    await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    await audit.log({
      user,
      action:    'user_login',
      metadata:  { method: 'password' },
      ipAddress: req.auditContext?.ipAddress,
    });

    logger.info('Password login', { email: user.email, userId: user.id });
    res.json({
      access_token:        accessToken,
      refresh_token:       refreshToken,
      must_change_password: user.must_change_password,
    });
  } catch (err) { next(err); }
});

// ─── POST /api/auth/mobile/login — email + password for the mobile app ──────
// ADR 001 §2 (crmtree-frontend docs/adr): one email may have active accounts
// in several tenants, each with its own password. The password is checked
// against all of them and the response lists every tenant it matched, each
// with its own device-bound tokens. Tenant names are only revealed after a
// correct password — never for just an email.
const MOBILE_ROLES = ['salesperson', 'sales_manager'];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const mobileLoginRateLimitMessage = { error: 'Zbyt wiele prób logowania. Spróbuj ponownie za kilka minut.', code: 'RATE_LIMITED' };
const mobileLoginLimitByIp = rateLimit({
  windowMs: LOGIN_WINDOW_MS, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  message: mobileLoginRateLimitMessage,
});
// Per email as well: an attacker rotating IPs still can't hammer one account.
const mobileLoginLimitByEmail = rateLimit({
  windowMs: LOGIN_WINDOW_MS, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  message: mobileLoginRateLimitMessage,
  keyGenerator: (req) => `mobile-login:${String(req.body?.email ?? '').trim().toLowerCase()}`,
});
// bcrypt hash of a random string: compared against when an email has no
// candidate accounts, so "unknown email" takes as long as "wrong password".
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

router.post('/mobile/login', mobileLoginLimitByIp, mobileLoginLimitByEmail, injectAuditContext, async (req, res, next) => {
  try {
    const { email, password, device_id: deviceId, device_name: deviceName } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      return res.status(400).json({ error: 'email i password są wymagane' });
    }
    if (typeof deviceId !== 'string' || deviceId.length < 8 || deviceId.length > 128) {
      return res.status(400).json({ error: 'device_id jest wymagane (8-128 znaków)' });
    }
    const safeDeviceName = typeof deviceName === 'string' ? deviceName.slice(0, 100) : null;

    // On a tenant subdomain only that tenant counts, like the web login; the
    // app itself always calls the universal host.
    const hostTenantId = await resolveHostTenantId(req);
    if (hostTenantId === null) return res.status(401).json({ error: 'Nieprawidłowy email lub hasło' });
    const params = [email];
    let tenantFilter = '';
    if (hostTenantId !== undefined) {
      tenantFilter = 'AND u.tenant_id = $2';
      params.push(hostTenantId);
    }

    const { rows: candidates } = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.display_name, u.is_admin, u.crm_role,
              u.tenant_id, u.is_super_admin, u.password_hash, u.must_change_password,
              t.slug AS tenant_slug, t.name AS tenant_name
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id
        WHERE lower(trim(u.email)) = lower(trim($1))
          AND u.is_active AND t.is_active AND t.deleted_at IS NULL
          AND u.password_hash IS NOT NULL ${tenantFilter}
        ORDER BY t.name`,
      params
    );

    if (!candidates.length) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      return res.status(401).json({ error: 'Nieprawidłowy email lub hasło' });
    }

    const matched = [];
    for (const account of candidates) {
      if (await bcrypt.compare(password, account.password_hash)) matched.push(account);
    }
    if (!matched.length) return res.status(401).json({ error: 'Nieprawidłowy email lub hasło' });

    const allowed = matched.filter((a) => MOBILE_ROLES.includes(a.crm_role));
    if (!allowed.length) {
      return res.status(403).json({
        error: 'Aplikacja mobilna CRMtree jest przeznaczona dla handlowców. Zaloguj się w przeglądarce.',
        code: 'MOBILE_ROLE_NOT_ALLOWED',
      });
    }

    const accounts = [];
    for (const user of allowed) {
      const accessToken = signAccessToken(user, { client: 'mobile' });
      const { token: refreshToken, hash } = signRefreshToken(user);
      await saveRefreshToken(user.id, user.tenant_id, hash, { client: 'mobile', deviceId, deviceName: safeDeviceName });
      await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
      await audit.log({
        user,
        action:    'user_login',
        metadata:  { method: 'password_mobile', device_name: safeDeviceName },
        ipAddress: req.auditContext?.ipAddress,
        userAgent: req.auditContext?.userAgent,
      });
      accounts.push({
        tenant_slug:          user.tenant_slug,
        tenant_name:          user.tenant_name,
        access_token:         accessToken,
        refresh_token:        refreshToken,
        must_change_password: user.must_change_password,
        user: { id: user.id, display_name: user.display_name, crm_role: user.crm_role },
      });
    }

    logger.info('Mobile login', { userIds: allowed.map((u) => u.id), tenants: accounts.length });
    res.json({ accounts });
  } catch (err) { next(err); }
});

// ─── POST /api/auth/change-password ─────────────────────────────────────────
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: 'Nowe hasło musi mieć minimum 8 znaków' });
    }

    const { rows } = await db.query(
      'SELECT password_hash, must_change_password FROM users WHERE id = $1',
      [req.user.id]
    );
    const u = rows[0];

    // Jeśli user ma już hasło i nie jest w trybie must_change — wymagaj starego
    if (u.password_hash && !u.must_change_password) {
      if (!current_password) {
        return res.status(400).json({ error: 'Podaj aktualne hasło' });
      }
      const ok = await bcrypt.compare(current_password, u.password_hash);
      if (!ok) return res.status(401).json({ error: 'Nieprawidłowe aktualne hasło' });
    }

    const newHash = await bcrypt.hash(new_password, 12);
    await db.query(
      'UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2',
      [newHash, req.user.id]
    );

    // A password change logs this account out of its phones (ADR 001 §4) —
    // except the device making the change, when the app sends its device_id
    // (e.g. the forced must_change_password step right after mobile login).
    await db.query(
      `UPDATE refresh_tokens SET revoked = TRUE
        WHERE user_id = $1 AND client = 'mobile' AND revoked = FALSE
          AND device_id IS DISTINCT FROM $2`,
      [req.user.id, typeof req.body.device_id === 'string' ? req.body.device_id : null]
    );

    logger.info('Password changed', { userId: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── GET /api/auth/devices — phones signed in to this account ───────────────
// One row per device with a live mobile refresh token (ADR 001 §4), so a user
// can sign out a lost company phone from the web.
router.get('/devices', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT device_id,
              (array_agg(device_name ORDER BY created_at DESC))[1] AS device_name,
              MIN(created_at) AS first_seen_at,
              GREATEST(MAX(created_at), MAX(last_used_at)) AS last_active_at
         FROM refresh_tokens
        WHERE user_id = $1 AND client = 'mobile' AND revoked = FALSE AND expires_at > NOW()
        GROUP BY device_id
        ORDER BY last_active_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── DELETE /api/auth/devices/:deviceId — sign one phone out ────────────────
router.delete('/devices/:deviceId', requireAuth, injectAuditContext, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE refresh_tokens SET revoked = TRUE
        WHERE user_id = $1 AND device_id = $2 AND client = 'mobile' AND revoked = FALSE
        RETURNING device_name`,
      [req.user.id, req.params.deviceId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Nie znaleziono zalogowanego urządzenia.' });
    await audit.log({
      user:      req.user,
      action:    'device_signed_out',
      metadata:  { device_name: rows[0].device_name },
      ipAddress: req.auditContext?.ipAddress,
      userAgent: req.auditContext?.userAgent,
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ─── GET /api/auth/me — dane zalogowanego użytkownika ───────────────────────
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.display_name,
              u.is_admin, u.is_super_admin, u.tenant_id, u.crm_role, u.last_login_at,
              u.must_change_password, u.is_external, u.can_create_projects,
              json_agg(DISTINCT jsonb_build_object(
                'group_id',          ugr.group_id,
                'group_name',        gp.name,
                'group_display',     gp.display_name,
                'access_level',      ugr.access_level,
                'owner_restriction', gp.has_owner_restriction
              )) FILTER (WHERE ugr.group_id IS NOT NULL) AS roles,
              COALESCE(
                (SELECT jsonb_object_agg(feature, is_enabled)
                 FROM tenant_features WHERE tenant_id = u.tenant_id),
                '{}'::jsonb
              ) AS tenant_features
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

// ─── DEV STUB — aktywny WYŁĄCZNIE gdy NODE_ENV=development ──────────────────
// Na produkcji (NODE_ENV=production) ten blok nie istnieje → endpoint 404.
if (process.env.NODE_ENV === 'development') {

  // GET /api/auth/saml — dev HTML stub zamiast redirectu do Google
  router.get('/saml', async (req, res) => {
    // Scope the picker to the current tenant subdomain when there is one —
    // otherwise the same email on two tenants shows up as two indistinguishable
    // options, and picking either still only logs into the tenant the host
    // resolves to (see the dev-login handler below).
    const hostTenantId = await resolveHostTenantId(req);
    const { rows } = await db.query(
      hostTenantId
        ? `SELECT email, display_name FROM users WHERE is_active = true AND tenant_id = $1 ORDER BY display_name`
        : `SELECT email, display_name FROM users WHERE is_active = true ORDER BY display_name`,
      hostTenantId ? [hostTenantId] : []
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
      const origin = req.headers.origin || req.headers.referer || '';
      if (origin.includes('app.crmtree.pl')) {
        return res.status(403).json({ error: 'Dev login not available on this domain' });
      }

      const email = (req.body.email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'email required' });

      // Same tenant-subdomain scoping as POST /login — otherwise dev-login
      // on a {slug}.crmtree.pl host can hand out a token for a different
      // tenant's account with the same email, which the TENANT_HOST_MISMATCH
      // guard then rejects on the very next authenticated request.
      const hostTenantId = await resolveHostTenantId(req);
      if (hostTenantId === null) {
        return res.status(404).json({ error: 'User not found or inactive' });
      }
      const params = [email];
      let tenantFilter = '';
      if (hostTenantId !== undefined) {
        tenantFilter = 'AND tenant_id = $2';
        params.push(hostTenantId);
      }

      const { rows } = await db.query(
        `SELECT id, email, display_name, is_admin, is_active, crm_role, tenant_id
         FROM users WHERE lower(email) = $1 ${tenantFilter} AND is_active = true LIMIT 1`,
        params
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found or inactive' });

      const user = rows[0];
      if (await isTenantDeleted(user.tenant_id)) {
        return res.status(404).json({ error: 'User not found or inactive' });
      }

      const accessToken                     = signAccessToken(user);
      const { token: refreshToken, hash }   = signRefreshToken(user);
      await saveRefreshToken(user.id, user.tenant_id, hash);

      await audit.log({
        user:      { id: user.id, email: user.email, display_name: user.display_name, tenant_id: user.tenant_id },
        action:    'user_login',
        metadata:  { method: 'dev_bypass' },
        ipAddress: req.auditContext?.ipAddress,
        userAgent: req.auditContext?.userAgent,
      });

      res.json({ access_token: accessToken, refresh_token: refreshToken, user });
    } catch (err) { next(err); }
  });
}

// Endpoint diagnostyczny SAML — wymaga uwierzytelnienia jako admin
router.get('/saml-diag', requireAuth, requireAdmin, (req, res) => {
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
