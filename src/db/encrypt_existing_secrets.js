'use strict';
/**
 * One-off backfill: encrypt already-plaintext tenant credentials at rest.
 *
 * tenant_social_accounts.access_token/refresh_token (LinkedIn/Facebook/
 * Instagram), tenant_gsc_tokens.access_token/refresh_token, and
 * tenant_wordpress_connections.app_password were stored in plaintext before
 * this change — application code now encrypts on write (see
 * src/services/socialPublish/{linkedin,meta,wordpress}Service.js and
 * src/services/gscService.js) via src/utils/encrypt.js (AES-256-GCM), but
 * existing rows need a one-time pass to catch up.
 *
 * Idempotent: for every value, tries decrypt() first — if that succeeds
 * (i.e. it's already ciphertext) the row is left alone, so it's safe to
 * re-run. Requires EMAIL_ENCRYPTION_KEY to already be set to its real value
 * (Key Vault-backed) in this environment before running.
 *
 * Run once per environment, after the encrypting code is deployed there:
 *   DB_HOST=... DB_NAME=... DB_USER=... DB_PASSWORD=... DB_SSL=true \
 *   EMAIL_ENCRYPTION_KEY=... node src/db/encrypt_existing_secrets.js
 */

require('dotenv').config();
require('dotenv').config({
  path: require('path').resolve(process.cwd(), '.env.local'),
  override: true,
});

const { Pool } = require('pg');
const { encrypt, decrypt } = require('../utils/encrypt');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// [table, primary key column, [nullable columns to encrypt]]
const TARGETS = [
  ['tenant_social_accounts', 'id', ['access_token', 'refresh_token']],
  ['tenant_gsc_tokens', 'tenant_id', ['access_token', 'refresh_token']],
  ['tenant_wordpress_connections', 'tenant_id', ['app_password']],
];

async function backfillTable(client, table, pk, columns) {
  const { rows } = await client.query(`SELECT ${pk}, ${columns.join(', ')} FROM ${table}`);
  let updated = 0;
  let alreadyEncrypted = 0;
  let skippedNull = 0;

  for (const row of rows) {
    const sets = [];
    const params = [];
    for (const col of columns) {
      const value = row[col];
      if (!value) { skippedNull++; continue; }
      if (decrypt(value) !== null) { alreadyEncrypted++; continue; } // already ciphertext
      params.push(encrypt(value));
      sets.push(`${col} = $${params.length}`);
    }
    if (sets.length === 0) continue;
    params.push(row[pk]);
    await client.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${pk} = $${params.length}`, params);
    updated++;
  }

  console.log(`${table}: ${updated} row(s) encrypted, ${alreadyEncrypted} value(s) already encrypted, ${skippedNull} null value(s) skipped`);
}

async function main() {
  if (!process.env.EMAIL_ENCRYPTION_KEY) {
    console.warn('WARNING: EMAIL_ENCRYPTION_KEY is not set — falling back to JWT_SECRET (see src/utils/encrypt.js). Confirm this is intentional before proceeding.');
  }
  const client = await pool.connect();
  try {
    for (const [table, pk, columns] of TARGETS) {
      await backfillTable(client, table, pk, columns);
    }
    console.log('Done.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
