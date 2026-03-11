"use strict";

const db = require("../config/database");
const logger = require("../utils/logger");

/**
 * Write an audit log entry.
 * This is the ONLY way audit logs should be written — always append-only.
 *
 * @param {object} opts
 * @param {object} opts.user           - { id, email, display_name }  (can be null for system)
 * @param {object} [opts.document]     - { id, doc_number, name }
 * @param {string} opts.action         - audit_action enum value
 * @param {object} [opts.beforeState]  - snapshot before change
 * @param {object} [opts.afterState]   - snapshot after change
 * @param {object} [opts.metadata]     - extra context
 * @param {string} [opts.ipAddress]
 * @param {string} [opts.userAgent]
 * @param {object} [opts.client]       - pg client for use inside transactions
 */
async function log({
  user,
  document,
  action,
  beforeState,
  afterState,
  metadata,
  ipAddress,
  userAgent,
  client,
}) {
  const q = client ? client.query.bind(client) : db.query;
  try {
    await q(
      `INSERT INTO audit_logs
         (user_id, user_email, user_name,
          document_id, document_number, document_name,
          action, before_state, after_state, metadata,
          ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        user?.id || null,
        user?.email || null,
        user?.display_name || user?.name || null,
        document?.id || null,
        document?.doc_number || null,
        document?.name || null,
        action,
        beforeState ? JSON.stringify(beforeState) : null,
        afterState ? JSON.stringify(afterState) : null,
        metadata ? JSON.stringify(metadata) : null,
        ipAddress || null,
        userAgent || null,
      ],
    );
  } catch (err) {
    // Audit failures must never crash the main request
    logger.error("Failed to write audit log", { action, error: err.message });
  }
}

/**
 * Query audit logs with filtering and pagination.
 * Admin-only endpoint.
 */
async function queryLogs({
  dateFrom,
  dateTo,
  userId,
  userEmail,
  documentId,
  documentName,
  action,
  search, // free text — searches user_name, document_name, action
  page = 1,
  limit = 50,
}) {
  const conditions = [];
  const params = [];
  let p = 1;

  if (dateFrom) {
    conditions.push(`created_at >= $${p++}`);
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push(`created_at <= $${p++}`);
    params.push(dateTo);
  }
  if (userId) {
    conditions.push(`user_id = $${p++}`);
    params.push(userId);
  }
  if (userEmail) {
    conditions.push(`user_email ILIKE $${p++}`);
    params.push(`%${userEmail}%`);
  }
  if (documentId) {
    conditions.push(`document_id = $${p++}`);
    params.push(documentId);
  }
  if (documentName) {
    conditions.push(`document_name ILIKE $${p++}`);
    params.push(`%${documentName}%`);
  }
  if (action) {
    conditions.push(`action = $${p++}`);
    params.push(action);
  }
  if (search) {
    conditions.push(`(
      user_name     ILIKE $${p}   OR
      document_name ILIKE $${p}   OR
      action::text  ILIKE $${p}
    )`);
    params.push(`%${search}%`);
    p++;
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const offset = (page - 1) * limit;

  const [dataResult, countResult] = await Promise.all([
    db.query(
      `SELECT id, user_id, user_email, user_name,
              document_id, document_number, document_name,
              action, before_state, after_state, metadata,
              ip_address, created_at
       FROM audit_logs
       ${where}
       ORDER BY created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      [...params, limit, offset],
    ),
    db.query(`SELECT COUNT(*) FROM audit_logs ${where}`, params),
  ]);

  return {
    data: dataResult.rows,
    total: parseInt(countResult.rows[0].count),
    page,
    limit,
    pages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
  };
}

module.exports = { log, queryLogs };
