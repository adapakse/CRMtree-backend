'use strict';
const { Pool } = require('pg');
const pool = new Pool({ host: process.env.DB_HOST, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, ssl: { rejectUnauthorized: false } });
const TENANT = '3b99d775-b6e3-41a8-828d-c9877a7b6ea4';
async function run() {
  const { rows } = await pool.query(
    "SELECT email, tenant_id, crm_role FROM users WHERE email LIKE 'user%' OR email LIKE 'manager%' ORDER BY email"
  );
  console.log('--- ALL user/manager accounts ---');
  rows.forEach(u => console.log(`${u.email} | tenant:${u.tenant_id} | role:${u.crm_role}`));

  const { rows: leads } = await pool.query(`
    SELECT u.email, COUNT(l.id) total, COUNT(l.value_pln) w_value,
           COUNT(CASE WHEN l.close_date < NOW() THEN 1 END) past_close
    FROM users u
    LEFT JOIN crm_leads l ON l.assigned_to = u.id AND l.tenant_id = $1
    WHERE u.tenant_id = $1
    GROUP BY u.email ORDER BY u.email
  `, [TENANT]);
  console.log('\n--- Leads per user in BRMtree_test1 ---');
  leads.forEach(r => console.log(`${r.email} | leads:${r.total} | w/value:${r.w_value} | past_close:${r.past_close}`));
  await pool.end();
}
run().catch(e => { console.error(e.message); pool.end(); });
