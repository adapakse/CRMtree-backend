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

module.exports = { isMissingDwhTable, queryDwhOrEmpty };
