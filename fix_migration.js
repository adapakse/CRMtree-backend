require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  host: "localhost",
  port: 5432,
  database: "worktrips_doc",
  user: "wtdoc_app",
  password: "Syrena1@",
  ssl: false,
});

pool
  .query("DELETE FROM _migrations WHERE filename = $1", [
    "0111_crm_annual_turnover_online_pct.sql",
  ])
  .then(() => {
    console.log("OK - wpis usunięty");
    pool.end();
  })
  .catch((e) => {
    console.error(e.message);
    pool.end();
  });
