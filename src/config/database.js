"use strict";

const pg     = require("pg");
const { Pool } = pg;
const config = require("./index");
const logger = require("../utils/logger");

// Keep DATE columns as plain "YYYY-MM-DD" strings — avoids UTC midnight → local day-shift (x-1 bug)
pg.types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  ssl: config.db.ssl ? { rejectUnauthorized: true } : false,
  max: config.db.poolMax,
  idleTimeoutMillis: config.db.idleTimeoutMillis,
  connectionTimeoutMillis: config.db.connectionTimeoutMillis,
});

pool.on("error", (err) => {
  logger.error("Unexpected PostgreSQL pool error", { error: err.message });
});

pool.on("connect", () => {
  logger.debug("New DB connection established");
});

/**
 * Execute a single query.
 * @param {string} text   - SQL string
 * @param {Array}  params - Query parameters
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug("DB query executed", { duration, rows: result.rowCount });
    return result;
  } catch (err) {
    logger.error("DB query error", { query: text, error: err.message });
    throw err;
  }
}

/**
 * Get a client for multi-statement transactions.
 * Always use try/finally to release.
 */
async function getClient() {
  return pool.connect();
}

/**
 * Convenience: run multiple queries in a transaction.
 * @param {Function} fn  - async (client) => result
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Health check — used by App Service /health endpoint.
 */
async function healthCheck() {
  const result = await query("SELECT NOW() AS now, version() AS pg_version");
  return result.rows[0];
}

module.exports = { query, getClient, transaction, healthCheck, pool };
