'use strict';

const db     = require('../config/database');
const logger = require('./logger');

// Per-tenant DWH tables (dwh.<prefix>_sales, dwh.<prefix>_partner) exist only
// for tenants fed by a warehouse import. A tenant without them simply has no
// sales data, so a missing table must not surface as a 500. The message is
// localised by the server's lc_messages, so only the quoted table name is matched.
function isMissingDwhTable(err) {
  return err?.code === '42P01' && /"dwh\./.test(err.message || '');
}

// Runs a DWH query; a missing DWH table yields an empty result instead of an
// error. pool.query is used directly so the expected case is not logged as a
// DB error on every request — one warning per request is enough.
async function queryDwhOrEmpty(req, sql, params) {
  try {
    return await db.pool.query(sql, params);
  } catch (err) {
    if (!isMissingDwhTable(err)) throw err;
    if (!req.dwhMissingLogged) {
      req.dwhMissingLogged = true;
      logger.warn('DWH tables missing for tenant, returning empty result', {
        tenantId:  req.tenantId,
        dwhPrefix: req.dwhPrefix,
        route:     `${req.method} ${req.baseUrl}${req.route?.path ?? ''}`,
      });
    }
    return { rows: [], rowCount: 0 };
  }
}

const DWH_PREFIX_RE = /^[a-z][a-z0-9_]*$/;

// Creates the tenant's own (empty) pair of DWH tables when they do not exist yet.
//
// Many queries LEFT JOIN or read dwh.<prefix>_partner / dwh.<prefix>_sales directly;
// a tenant with a prefix but without the tables got a 500 on the onboarding list and
// a failing nightly score job (tenant "comparme", 2026-11). Guarding every query
// separately kept missing one, so the tables are guaranteed to exist instead: an
// empty table is simply "no sales data", which every query already handles.
//
// The structure is copied from an existing pair (crmtree_gold first, any other
// tenant's otherwise). Without any pair to copy from nothing is created.
// `queryable` is the pool wrapper or a transaction client.
async function ensureTenantDwhTables(queryable, prefix) {
  if (!prefix) return { created: false, reason: 'no_prefix' };
  if (!DWH_PREFIX_RE.test(prefix)) throw new Error(`Invalid DWH prefix: ${prefix}`);

  const { rows: [existing] } = await queryable.query(
    `SELECT to_regclass($1) IS NOT NULL AS has_partner, to_regclass($2) IS NOT NULL AS has_sales`,
    [`dwh.${prefix}_partner`, `dwh.${prefix}_sales`]
  );
  if (existing.has_partner && existing.has_sales) return { created: false, reason: 'already_exist' };

  const { rows: [template] } = await queryable.query(
    `SELECT left(p.table_name, length(p.table_name) - length('_partner')) AS prefix
       FROM information_schema.tables p
      WHERE p.table_schema = 'dwh' AND p.table_name LIKE '%\\_partner'
        AND EXISTS (
          SELECT 1 FROM information_schema.tables s
           WHERE s.table_schema = 'dwh'
             AND s.table_name = left(p.table_name, length(p.table_name) - length('_partner')) || '_sales')
      ORDER BY (p.table_name = 'crmtree_gold_partner') DESC, p.table_name
      LIMIT 1`
  );
  if (!template || !DWH_PREFIX_RE.test(template.prefix)) {
    logger.warn('No DWH tables to copy the structure from — tenant DWH tables not created', { dwhPrefix: prefix });
    return { created: false, reason: 'no_template' };
  }

  // Both names passed DWH_PREFIX_RE, so they are safe to place in the statement.
  await queryable.query(`CREATE TABLE IF NOT EXISTS dwh.${prefix}_partner (LIKE dwh.${template.prefix}_partner INCLUDING ALL)`);
  await queryable.query(`CREATE TABLE IF NOT EXISTS dwh.${prefix}_sales (LIKE dwh.${template.prefix}_sales INCLUDING ALL)`);
  logger.info('Created empty DWH tables for tenant', { dwhPrefix: prefix, copiedFrom: template.prefix });
  return { created: true, copiedFrom: template.prefix };
}

module.exports = { isMissingDwhTable, queryDwhOrEmpty, ensureTenantDwhTables };
