'use strict';

const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const passport = require('passport');
const { Strategy: SamlStrategy } = require('passport-saml');
const config   = require('../config');
const db       = require('../config/database');
const audit    = require('../services/auditService');
const logger   = require('../utils/logger');

// ─── SAML Strategy ────────────────────────────────────────
// SAML wyłączone na czas testów na localhost
/*
//const samlCert = config.saml?.idpCert;
//if (samlCert && samlCert.length > 10) passport.use(
//  new SamlStrategy(
//    {
//      entryPoint:    config.saml.entryPoint,
//      issuer:        config.saml.issuer,
//      callbackUrl:   config.saml.callbackUrl,
//      idpCert:       config.saml.idpCert,
//      wantAssertionsSigned: true,
//      disableRequestedAuthnContext: true,
//    },
//    async (profile, done) => {
//      try {
//        const email     = profile.email || //profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'] || profile.nameID;
//        const firstName = profile.firstName || //profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname']  || '';
//        const lastName  = profile.lastName  || //profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname']    || '';
//
//        if (!email) return done(new Error('SAML: email attribute missing'));

        // Upsert user
//        const { rows } = await db.query(
//          `INSERT INTO users (email, first_name, last_name, saml_subject, last_login_at)
//           VALUES ($1, $2, $3, $4, NOW())
//           ON CONFLICT (email) DO UPDATE
//             SET first_name    = EXCLUDED.first_name,
//                 last_name     = EXCLUDED.last_name,
//                 saml_subject  = EXCLUDED.saml_subject,
//                 last_login_at = NOW(),
//                 updated_at    = NOW()
//           RETURNING id, email, first_name, last_name, display_name, is_admin, is_active`,
//          [email, firstName, lastName, profile.nameID]
//        );
//        const user = rows[0];
//        if (!user.is_active) return done(new Error('Account inactive'));

//        return done(null, user);
//      } catch (err) {
//        return done(err);
//      }
//   }
// )
//);
*/
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await db.query(
      'SELECT id, email, first_name, last_name, display_name, is_admin, is_active FROM users WHERE id = $1',
      [id]
    );
    done(null, rows[0] || null);
  } catch (err) { done(err); }
});

// ─── JWT helpers ──────────────────────────────────────────
function signAccessToken(user) {
  return jwt.sign(
    {
      sub:      user.id,
      email:    user.email,
      name:     user.display_name,
      is_admin: user.is_admin,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn, algorithm: 'HS256' }
  );
}

function signRefreshToken(user) {
  const token = crypto.randomBytes(64).toString('hex');
  const hash  = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hash };
}

async function saveRefreshToken(userId, hash) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  await db.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
    [userId, hash, expiresAt]
  );
}

// ─── requireAuth middleware ────────────────────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
    // Load fresh user from DB to capture role changes
    const { rows } = await db.query(
      'SELECT id, email, first_name, last_name, display_name, is_admin, is_active FROM users WHERE id = $1',
      [decoded.sub]
    );
    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── requireAdmin middleware ───────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = {
  passport,
  requireAuth,
  requireAdmin,
  signAccessToken,
  signRefreshToken,
  saveRefreshToken,
};
