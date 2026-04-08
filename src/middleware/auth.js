"use strict";

const jwt      = require("jsonwebtoken");
const crypto   = require("crypto");
const passport = require("passport");
const { Strategy: SamlStrategy } = require("passport-saml");
const config   = require("../config");
const db       = require("../config/database");
const logger   = require("../utils/logger");

// ─── SAML Strategy ─────────────────────────────────────────────────────────
// Inicjalizowana TYLKO gdy SAML_IDP_CERT jest ustawiony (środowisko produkcyjne).
// Na lokalnym dev (NODE_ENV=development) cert nie jest ustawiony → strategia
// nie jest rejestrowana → passport.authenticate('saml') zwróciłby błąd,
// ale route /api/auth/saml na dev jest obsługiwany przez stub w routes/auth.js.

const samlCert = config.saml?.idpCert;

if (samlCert && samlCert.length > 10) {
  logger.info("[SAML] Inicjalizacja strategii SAML", {
    entryPoint:  config.saml.entryPoint,
    issuer:      config.saml.issuer,
    callbackUrl: config.saml.callbackUrl,
  });

  // passport-saml v3+ wymaga certyfikatu w formacie PEM z nagłówkami.
  // Google Workspace dostarcza go jako gołe base64 — zawijamy w nagłówki PEM.
  const rawCert = samlCert.replace(/\s+/g, "");
  const pemCert = rawCert.startsWith("-----BEGIN CERTIFICATE-----")
    ? rawCert
    : [
        "-----BEGIN CERTIFICATE-----",
        ...rawCert.match(/.{1,64}/g),
        "-----END CERTIFICATE-----",
      ].join("\n");

  logger.info("[SAML] Certyfikat przygotowany", {
    pem_length:  pemCert.length,
    cert_starts: rawCert.slice(0, 20),
  });

  passport.use(
    new SamlStrategy(
      {
        entryPoint:                   config.saml.entryPoint,
        issuer:                       config.saml.issuer,
        callbackUrl:                  config.saml.callbackUrl,
        cert:                         pemCert,
        wantAssertionsSigned:         true,
        disableRequestedAuthnContext: true,
      },
      async (profile, done) => {
        try {
          // ── Wyciągnij email z atrybutów SAML ─────────────────────────────
          const email =
            profile.email ||
            profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"] ||
            profile.nameID;

          if (!email) {
            logger.warn("[SAML] Brak atrybutu email w profilu SAML", { nameID: profile.nameID });
            return done(new Error("SAML: brak atrybutu email"));
          }

          // ── Ogranicz dostęp do domeny @worktrips.com ──────────────────────
          if (!email.toLowerCase().endsWith("@worktrips.com")) {
            logger.warn("[SAML] Próba logowania spoza domeny", { email });
            return done(new Error("SAML: konto spoza domeny @worktrips.com"));
          }

          // ── Znajdź istniejącego użytkownika — NIE twórz nowych ───────────
          // Tylko administratorzy mogą dodawać nowych użytkowników przez panel.
          const { rows } = await db.query(
            `SELECT id, email, first_name, last_name, display_name,
                    is_admin, is_active, crm_role
             FROM users
             WHERE lower(email) = lower($1)
             LIMIT 1`,
            [email]
          );

          if (!rows.length) {
            logger.warn("[SAML] Użytkownik nie istnieje w systemie", { email });
            return done(new Error("SAML: konto nie zostało jeszcze dodane do systemu"));
          }

          const user = rows[0];

          if (!user.is_active) {
            logger.warn("[SAML] Konto nieaktywne", { email });
            return done(new Error("Account inactive"));
          }

          // ── Zaktualizuj last_login_at i saml_subject ─────────────────────
          await db.query(
            `UPDATE users
             SET last_login_at = NOW(),
                 saml_subject  = $1,
                 updated_at    = NOW()
             WHERE id = $2`,
            [profile.nameID, user.id]
          );

          logger.info("[SAML] Pomyślne uwierzytelnienie", { email, userId: user.id });
          return done(null, user);
        } catch (err) {
          logger.error("[SAML] Błąd strategii", { err: err.message });
          return done(err);
        }
      }
    )
  );
} else {
  logger.info("[SAML] Strategia SAML nieaktywna (brak SAML_IDP_CERT) — tryb deweloperski");
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await db.query(
      `SELECT id, email, first_name, last_name, display_name,
              is_admin, is_active, crm_role
       FROM users WHERE id = $1`,
      [id]
    );
    done(null, rows[0] || null);
  } catch (err) {
    done(err);
  }
});

// ─── JWT helpers ────────────────────────────────────────────────────────────
function signAccessToken(user) {
  return jwt.sign(
    {
      sub:      user.id,
      email:    user.email,
      name:     user.display_name,
      is_admin: user.is_admin,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn, algorithm: "HS256" }
  );
}

function signRefreshToken(user) {
  const token = crypto.randomBytes(64).toString("hex");
  const hash  = crypto.createHash("sha256").update(token).digest("hex");
  return { token, hash };
}

async function saveRefreshToken(userId, hash) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  await db.query(
    "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)",
    [userId, hash, expiresAt]
  );
}

// ─── requireAuth middleware ──────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, config.jwt.secret, { algorithms: ["HS256"] });
    const { rows } = await db.query(
      `SELECT id, email, first_name, last_name, display_name,
              is_admin, is_active, crm_role
       FROM users WHERE id = $1`,
      [decoded.sub]
    );
    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ error: "User not found or inactive" });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired", code: "TOKEN_EXPIRED" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ─── requireAdmin middleware ─────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) {
    return res.status(403).json({ error: "Admin access required" });
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
