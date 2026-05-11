"use strict";

const db     = require("../config/database");
const logger = require("../utils/logger");

/**
 * Tenant middleware — Sprint 1 (read-only, bez enforcement).
 *
 * Ustala req.tenantId z dwóch źródeł (w kolejności priorytetu):
 *   1. req.user.tenant_id    — ustawiane przez requireAuth po weryfikacji JWT
 *   2. Subdomena hostname    — np. acme.crmtree.pl → slug = "acme" (przyszły Sprint)
 *
 * req.tenantId = UUID lub null (super_admin lub nieznany tenant).
 *
 * Sprint 2: middleware będzie odrzucał request gdy tenant_id = null
 * (za wyjątkiem endpointów super_admin i /auth/*).
 */
async function tenantMiddleware(req, res, next) {
  try {
    // ── Źródło 1: tenant_id z JWT / bazy (ustawiony przez requireAuth) ────────
    if (req.user?.tenant_id) {
      req.tenantId = req.user.tenant_id;
      return next();
    }

    // ── Źródło 2: subdomena hostname (przygotowanie pod Sprint 5) ─────────────
    const host = req.hostname || req.headers.host || "";
    const subdomainMatch = host.match(/^([a-z0-9][a-z0-9-]*)\.crmtree\.(pl|com)$/i);

    if (subdomainMatch) {
      const slug = subdomainMatch[1].toLowerCase();
      const { rows } = await db.query(
        "SELECT id FROM tenants WHERE slug = $1 AND is_active = true LIMIT 1",
        [slug]
      );
      if (rows.length) {
        req.tenantId = rows[0].id;
        logger.debug("[tenant] resolved from subdomain", { slug, tenantId: req.tenantId });
        return next();
      }
      logger.warn("[tenant] unknown subdomain", { slug, host });
    }

    // ── Brak tenanta — super_admin lub ruch bez kontekstu tenant ──────────────
    req.tenantId = null;
    next();
  } catch (err) {
    logger.error("[tenant] middleware error", { err: err.message });
    next(err);
  }
}

module.exports = tenantMiddleware;
