'use strict';
require('dotenv').config({ path: '.env.local', override: false });
require('dotenv').config({ override: false });
const { Pool }  = require('pg');
const bcrypt    = require('bcryptjs');

const TENANT_ID = process.env.TENANT_ID || '3b99d775-b6e3-41a8-828d-c9877a7b6ea4';
const DOMAIN    = 'crmtree.pl';
const PASSWORD  = 'User123!';

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'crmtree',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function run() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const emails = [
    ...Array.from({ length: 5 }, (_, i) => `user${i + 1}@${DOMAIN}`),
    ...Array.from({ length: 5 }, (_, i) => `manager${i + 1}@${DOMAIN}`),
  ];
  const { rowCount } = await pool.query(
    `UPDATE users SET password_hash = $1 WHERE email = ANY($2) AND tenant_id = $3`,
    [hash, emails, TENANT_ID]
  );
  console.log(`✅ Password restored for ${rowCount} users (${PASSWORD})`);
  await pool.end();
}

run().catch(e => { console.error('❌', e.message); pool.end(); });
