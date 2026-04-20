"use strict";
// src/routes/crm-partners.js
// Analogicznie do crm-leads.js — dodano integrację z Google Calendar przy tworzeniu spotkania.

const express  = require("express");
const router   = express.Router();
const { pool } = require("../config/database");
const { requireAuth } = require("../middleware/auth");
const { crmAuth, loadCrmScope } = require("../middleware/crm-rbac");
const calendarService = require("../services/calendarService");
const audit    = require("../services/auditService");
const config   = require("../config");
const email    = require("../utils/email");
const logger   = require("../utils/logger");

// Wspólne middleware dla wszystkich tras (requireAuth + crmAuth są też per-route dla jasności)
router.use(requireAuth, crmAuth, loadCrmScope);

// ── Pomocnicze ────────────────────────────────────────────────────────────────
function assertManager(req, res) {
  const u = req.user;
  if (!u?.is_admin && u?.crm_role !== "sales_manager") {
    res.status(403).json({ error: "Brak uprawnień" });
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LISTA PARTNERÓW
// ═══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// ONBOARDING PANEL — globalne endpointy dla panelu Onboarding
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/crm/partners/onboarding — lista partnerów w statusie 'onboarding'
// z zadaniami i postępem. Manager widzi wszystkich, handlowiec tylko swoich.
router.get("/onboarding", requireAuth, crmAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const isManager = req.isCrmManager;

    const { search = '', assigned_to = '' } = req.query;
    const params = [];
    const conds  = ["p.status = 'onboarding'"];

    if (req.user.is_admin) {
      // admin — bez ograniczeń
    } else if (req.user.crm_role === 'sales_manager') {
      if (req.crmScopeUserIds && req.crmScopeUserIds.length > 0) {
        params.push(req.crmScopeUserIds);
        conds.push(`p.manager_id = ANY($${params.length}::uuid[])`);
      } else { conds.push('1=0'); }
    } else {
      // Handlowiec widzi tylko partnerów gdzie ma przypisane zadania
      params.push(userId);
      conds.push(`EXISTS (
        SELECT 1 FROM crm_onboarding_tasks t
        WHERE t.partner_id = p.id AND t.assigned_to = $${params.length}
      )`);
    }
    if (search) {
      params.push(`%${search}%`);
      conds.push(`(p.company ILIKE $${params.length} OR p.nip ILIKE $${params.length})`);
    }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const { rows: partners } = await pool.query(`
      SELECT p.id, p.company, p.nip, p.onboarding_step, p.status,
             p.created_at, p.manager_id,
             u.display_name AS manager_name,
             (SELECT COUNT(*) FROM crm_onboarding_tasks t WHERE t.partner_id = p.id)::int AS task_count,
             (SELECT COUNT(*) FROM crm_onboarding_tasks t WHERE t.partner_id = p.id AND t.done = true)::int AS done_count
      FROM crm_partners p
      LEFT JOIN users u ON u.id = p.manager_id
      ${where}
      ORDER BY p.created_at DESC
    `, params);

    res.json(partners);
  } catch (err) {
    console.error("GET /onboarding error:", err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// GET /api/crm/partners/onboarding/tasks — wszystkie zadania dla panelu onboarding
// Filtry: partner_id, assigned_to, step, done
router.get("/onboarding/tasks", requireAuth, crmAuth, async (req, res) => {
  try {
    const userId   = req.user.id;
    const isManager = req.isCrmManager;
    const { partner_id, assigned_to, step, done } = req.query;

    const params = [];
    const conds  = ["p.status = 'onboarding'"];

    if (!isManager) {
      params.push(userId);
      conds.push(`t.assigned_to = $${params.length}`);
    } else if (assigned_to) {
      params.push(assigned_to);
      conds.push(`t.assigned_to = $${params.length}`);
    }

    if (partner_id) {
      params.push(parseInt(partner_id));
      conds.push(`t.partner_id = $${params.length}`);
    }
    if (step !== undefined && step !== '') {
      params.push(parseInt(step));
      conds.push(`t.step = $${params.length}`);
    }
    if (done !== undefined && done !== '') {
      params.push(done === 'true');
      conds.push(`t.done = $${params.length}`);
    }

    const where = 'WHERE ' + conds.join(' AND ');

    const { rows } = await pool.query(`
      SELECT t.*,
             p.company AS partner_name, p.nip AS partner_nip, p.onboarding_step AS partner_step,
             u.display_name AS assigned_to_name,
             db.display_name AS done_by_name
      FROM crm_onboarding_tasks t
      JOIN crm_partners p ON p.id = t.partner_id
      LEFT JOIN users u  ON u.id  = t.assigned_to
      LEFT JOIN users db ON db.id = t.done_by
      ${where}
      ORDER BY t.due_date ASC NULLS LAST, t.created_at ASC
    `, params);

    res.json(rows);
  } catch (err) {
    console.error("GET /onboarding/tasks error:", err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

router.get("/", requireAuth, crmAuth, async (req, res) => {
  try {
    const {
      search = "", status = "", group_id = "",
      manager_id = "", industry = "",
      page = "1", limit = "50",
      sort = "company", dir = "asc",
    } = req.query;

    const allowedSort = ["company", "status", "contract_signed", "contract_value", "created_at"];
    const sortCol = allowedSort.includes(sort) ? sort : "company";
    const sortDir = dir === "desc" ? "DESC" : "ASC";

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const where  = [];

    // Rejestr partnerów wyklucza status 'onboarding' — trafiają do panelu Onboarding
    where.push(`p.status != 'onboarding'`);

    if (search) {
      params.push(`%${search}%`);
      where.push(`(p.company ILIKE $${params.length} OR p.email ILIKE $${params.length} OR p.partner_number ILIKE $${params.length} OR p.nip ILIKE $${params.length} OR p.contact_name ILIKE $${params.length} OR p.phone ILIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      where.push(`p.status = $${params.length}`);
    }
    if (group_id) {
      params.push(parseInt(group_id));
      where.push(`p.group_id = $${params.length}`);
    }
    if (industry) {
      params.push(industry);
      where.push(`p.industry = $${params.length}`);
    }
    // Scope widoczności
    if (req.user.is_admin) {
      if (manager_id) { params.push(manager_id); where.push(`p.manager_id = $${params.length}`); }
    } else if (req.user.crm_role === 'sales_manager') {
      if (manager_id) {
        // ekspansja — konkretny user (może być spoza grupy — tylko podgląd)
        params.push(manager_id); where.push(`p.manager_id = $${params.length}`);
      } else if (req.crmScopeUserIds && req.crmScopeUserIds.length > 0) {
        params.push(req.crmScopeUserIds); where.push(`p.manager_id = ANY($${params.length}::uuid[])`);
      } else { where.push('1=0'); }
    } else {
      params.push(req.user.id); where.push(`p.manager_id = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const countQ = await pool.query(
      `SELECT COUNT(*) FROM crm_partners p ${whereSql}`,
      params
    );
    const total = parseInt(countQ.rows[0].count);

    params.push(parseInt(limit), offset);
    const rows = await pool.query(
      `SELECT p.*,
              u.display_name AS manager_name,
              g.name AS group_name,
              (SELECT COUNT(*) FROM crm_partner_activities WHERE partner_id = p.id AND type = 'email')::int AS email_count
       FROM crm_partners p
       LEFT JOIN users u ON u.id = p.manager_id
       LEFT JOIN crm_partner_groups g ON g.id = p.group_id
       ${whereSql}
       ORDER BY p.${sortCol} ${sortDir}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ data: rows.rows, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error("GET /crm/partners error:", err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ZADANIA — partner activities (non-email), for calendar "Zadania" tab
// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/crm/partners/tasks
// query: assigned_to (UUID), type (string), include_closed (bool)
router.get("/tasks", requireAuth, crmAuth, async (req, res) => {
  try {
    const { assigned_to, type, include_closed, include_no_date } = req.query;
    const showClosed  = include_closed  === 'true';
    const includeNoDate = include_no_date === 'true';

    const conds  = ["a.type != 'email'"];
    const params = [];

    if (!showClosed)    conds.push("a.status != 'closed'");
    if (!includeNoDate) conds.push("a.activity_at IS NOT NULL");
    if (type) { params.push(type); conds.push(`a.type = $${params.length}`); }

    // Scope — kto widzi które aktywności
    // assigned_to może być pojedynczym UUID lub listą rozdzieloną przecinkami (filtr po grupie)
    const assignedIds = assigned_to ? assigned_to.split(',').map(s => s.trim()).filter(Boolean) : [];
    const pushAssignedFilter = (col) => {
      if (assignedIds.length === 1) {
        params.push(assignedIds[0]); conds.push(`${col} = $${params.length}`);
      } else {
        params.push(assignedIds); conds.push(`${col} = ANY($${params.length}::uuid[])`);
      }
    };
    if (req.user.is_admin) {
      if (assignedIds.length) pushAssignedFilter('COALESCE(a.assigned_to, p.manager_id)');
    } else if (req.user.crm_role === 'sales_manager') {
      if (assignedIds.length) {
        pushAssignedFilter('COALESCE(a.assigned_to, p.manager_id)');
      } else if (req.crmScopeUserIds && req.crmScopeUserIds.length > 0) {
        params.push(req.crmScopeUserIds); conds.push(`COALESCE(a.assigned_to, p.manager_id) = ANY($${params.length}::uuid[])`);
      } else { conds.push('1=0'); }
    } else {
      params.push(req.user.id); conds.push(`COALESCE(a.assigned_to, p.manager_id) = $${params.length}`);
    }

    const where = 'WHERE ' + conds.join(' AND ');

    const { rows } = await pool.query(`
      SELECT
        a.id, a.type, a.title, a.body, a.activity_at, a.duration_min,
        a.participants, a.meeting_location, a.created_by, a.status, a.close_comment,
        a.updated_at,
        u.display_name   AS created_by_name,
        'partner'        AS source_type,
        p.id             AS source_id,
        p.company        AS source_name,
        mu.display_name  AS assigned_to_name,
        mu.id            AS assigned_to_id,
        au.display_name  AS act_assigned_to_name,
        a.assigned_to    AS act_assigned_to_id
      FROM crm_partner_activities a
      JOIN crm_partners p   ON p.id  = a.partner_id
      LEFT JOIN users u     ON u.id  = a.created_by
      LEFT JOIN users mu    ON mu.id = p.manager_id
      LEFT JOIN users au    ON au.id = a.assigned_to
      ${where}
      ORDER BY
        CASE WHEN a.activity_at IS NULL THEN 1 ELSE 0 END,
        a.activity_at ASC
    `, params);

    res.json(rows);
  } catch (err) {
    console.error("GET /crm/partners/tasks error:", err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SZCZEGÓŁY PARTNERA
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/:id", requireAuth, crmAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const partnerQ = await pool.query(
      `SELECT p.*,
              u.display_name AS manager_name,
              g.name AS group_name
       FROM crm_partners p
       LEFT JOIN users u ON u.id = p.manager_id
       LEFT JOIN crm_partner_groups g ON g.id = p.group_id
       WHERE p.id = $1`,
      [id]
    );
    if (!partnerQ.rows.length) return res.status(404).json({ error: "Nie znaleziono" });

    const partner = partnerQ.rows[0];

    // Aktywności
    const actsQ = await pool.query(
      `SELECT a.*,
              u.display_name  AS created_by_name,
              au.display_name AS assigned_to_name
       FROM crm_partner_activities a
       LEFT JOIN users u  ON u.id  = a.created_by
       LEFT JOIN users au ON au.id = a.assigned_to
       WHERE a.partner_id = $1
       ORDER BY a.activity_at DESC NULLS LAST`,
      [id]
    );
    partner.activities = actsQ.rows;

    // Szanse (opportunities z aktywności)
    partner.all_opportunities = actsQ.rows
      .filter(a => a.type === "opportunity")
      .map(a => ({
        id: a.id, title: a.title,
        opp_value: a.opp_value, opp_currency: a.opp_currency,
        opp_status: a.opp_status, opp_due_date: a.opp_due_date,
        activity_at: a.activity_at,
      }));

    res.json(partner);
  } catch (err) {
    console.error("GET /crm/partners/:id error:", err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// UTWÓRZ PARTNERA
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/", requireAuth, crmAuth, async (req, res) => {
  if (!assertManager(req, res)) return;
  try {
    const {
      company, partner_number, status = "onboarding",
      nip, address, industry,
      contact_name, contact_title, email, phone,
      billing_contact_name, billing_contact_title, billing_email, billing_phone,
      credit_limit_value, credit_limit_currency,
      deposit_value, deposit_currency, deposit_date_in, deposit_date_out,
      commission_value, commission_basis,
      manager_id, group_id,
      contract_signed, contract_expires, contract_value, annual_turnover_currency,
      online_pct, active_users, tags, notes,
      agent_name, agent_email, agent_phone,
    } = req.body;

    if (!company) return res.status(400).json({ error: "Pole company jest wymagane" });

    // Parsuj tags bezpiecznie — frontend może wysłać string zamiast tablicy
    let safeTags = [];
    if (Array.isArray(tags)) {
      safeTags = tags;
    } else if (typeof tags === 'string' && tags.trim()) {
      try { safeTags = JSON.parse(tags); } catch (_) { safeTags = []; }
    }

    // Sprawdź unikalność NIP
    if (nip) {
      const nipCheck = await pool.query(
        `SELECT 'lead' AS src FROM crm_leads WHERE nip = $1
         UNION ALL SELECT 'partner' AS src FROM crm_partners WHERE nip = $1
         LIMIT 1`,
        [nip]
      );
      if (nipCheck.rows.length) {
        return res.status(409).json({ error: 'Ten Numer NIP jest już przypisany dla innego rekordu.' });
      }
    }

    const r = await pool.query(
      `INSERT INTO crm_partners (
        company, partner_number, status,
        nip, address, industry,
        contact_name, contact_title, email, phone,
        billing_contact_name, billing_contact_title, billing_email, billing_phone,
        credit_limit_value, credit_limit_currency,
        deposit_value, deposit_currency, deposit_date_in, deposit_date_out,
        commission_value, commission_basis,
        manager_id, group_id,
        contract_signed, contract_expires, contract_value, annual_turnover_currency,
        online_pct, active_users, tags, notes,
        agent_name, agent_email, agent_phone,
        created_by
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36
      ) RETURNING *`,
      [
        company, partner_number || null, status,
        nip || null, address || null, industry || null,
        contact_name || null, contact_title || null, email || null, phone || null,
        billing_contact_name || null, billing_contact_title || null,
        billing_email || null, billing_phone || null,
        credit_limit_value ?? null, credit_limit_currency || "PLN",
        deposit_value ?? null, deposit_currency || "PLN",
        deposit_date_in || null, deposit_date_out || null,
        commission_value ?? null, commission_basis || "nie_dotyczy",
        manager_id || null, group_id ? parseInt(group_id) : null,
        contract_signed || null, contract_expires || null,
        contract_value ?? null, annual_turnover_currency || "PLN",
        online_pct ?? null, active_users ?? null,
        safeTags,
        notes || null,
        agent_name || null, agent_email || null, agent_phone || null,
        req.user.id,
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error("POST /crm/partners error:", err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AKTUALIZUJ PARTNERA
// ═══════════════════════════════════════════════════════════════════════════════
router.patch("/:id", requireAuth, crmAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Scope check: manager może edytować tylko partnerów ze swojej grupy
    if (!req.user.is_admin && req.user.crm_role === 'sales_manager' && req.crmScopeUserIds) {
      const { rows: partnerRows } = await pool.query(
        'SELECT manager_id FROM crm_partners WHERE id = $1', [id],
      );
      if (!partnerRows.length) return res.status(404).json({ error: 'Partner nie znaleziony' });
      if (!req.crmScopeUserIds.includes(partnerRows[0].manager_id)) {
        return res.status(403).json({
          error: 'Nie możesz edytować tego partnera — jego manager nie należy do Twojej grupy.',
        });
      }
    }

    // Blokuj zmianę statusu z 'onboarding' gdy są nieukończone zadania
    if (req.body.status && req.body.status !== 'onboarding') {
      const current = await pool.query(
        `SELECT status FROM crm_partners WHERE id = $1`, [id]
      );
      if (current.rows[0]?.status === 'onboarding') {
        const { rows: openTasks } = await pool.query(
          `SELECT COUNT(*)::int AS cnt FROM crm_onboarding_tasks WHERE partner_id = $1 AND done = false`,
          [parseInt(id)]
        );
        if (openTasks[0].cnt > 0) {
          return res.status(409).json({
            error: `Nie można zakończyć wdrożenia — pozostało ${openTasks[0].cnt} nieukończonych zadań.`
          });
        }
      }
    }

    // Sprawdź unikalność NIP przy aktualizacji (wyklucz własny rekord)
    if (req.body.nip) {
      const nipCheck = await pool.query(
        `SELECT 'lead' AS src FROM crm_leads WHERE nip = $1
         UNION ALL SELECT 'partner' AS src FROM crm_partners WHERE nip = $1 AND id != $2
         LIMIT 1`,
        [req.body.nip, parseInt(id)]
      );
      if (nipCheck.rows.length) {
        return res.status(409).json({ error: 'Ten Numer NIP jest już przypisany dla innego rekordu.' });
      }
    }

    const allowed = [
      "company", "partner_number", "status",
      "nip", "address", "industry",
      "contact_name", "contact_title", "email", "phone",
      "billing_contact_name", "billing_contact_title", "billing_email", "billing_phone",
      "credit_limit_value", "credit_limit_currency",
      "deposit_value", "deposit_currency", "deposit_date_in", "deposit_date_out",
      "commission_value", "commission_basis",
      "manager_id", "group_id",
      "contract_signed", "contract_expires", "contract_value", "annual_turnover_currency",
      "online_pct", "active_users", "tags", "notes",
      "agent_name", "agent_email", "agent_phone",
      "onboarding_step",
      // Zadanie A: Dane dodatkowe
      "subdomain", "language", "partner_currency", "country",
      // Zadanie B: Billing Address
      "billing_address", "billing_zip", "billing_city", "billing_country", "billing_email_address",
      // Zadanie C: Partner Admin
      "admin_first_name", "admin_last_name", "admin_email",
    ];
    const sets   = [];
    const params = [];
    for (const key of allowed) {
      if (key in req.body) {
        params.push(req.body[key] === "" ? null : req.body[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: "Brak pól do aktualizacji" });

    // Jeśli zmiana statusu na active — dodaj log
    params.push(id);
    const r = await pool.query(
      `UPDATE crm_partners SET ${sets.join(", ")}, updated_at = NOW()
       WHERE id = $${params.length}
       RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: "Nie znaleziono" });
    res.json(r.rows[0]);
  } catch (err) {
    console.error("PATCH /crm/partners/:id error:", err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// USUŃ PARTNERA
// ═══════════════════════════════════════════════════════════════════════════════
router.delete("/:id", requireAuth, crmAuth, async (req, res) => {
  if (!assertManager(req, res)) return;
  try {
    await pool.query("DELETE FROM crm_partners WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /crm/partners/:id error:", err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AKTYWNOŚCI
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/:id/activities", requireAuth, crmAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.*, u.display_name AS created_by_name
       FROM crm_partner_activities a
       LEFT JOIN users u ON u.id = a.created_by
       WHERE a.partner_id = $1
       ORDER BY a.activity_at DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ── POST /crm/partners/:id/activities ─────────────────────────────────────────
// Przy typie 'meeting' automatycznie tworzy event w Google Calendar.
router.post("/:id/activities", requireAuth, crmAuth, async (req, res) => {
  try {
    const partnerId = parseInt(req.params.id);
    const {
      type = "note", title, body,
      activity_at, duration_min, meeting_location, participants,
      assigned_to,
      // pola szansy sprzedaży
      opp_value, opp_currency, opp_status, opp_due_date,
      // Gmail thread
      gmail_thread_id, gmail_message_id,
    } = req.body;

    if (!title) return res.status(400).json({ error: "Pole title jest wymagane" });

    // Pobierz dane partnera do Calendar
    const partnerQ = await pool.query(
      "SELECT company, email FROM crm_partners WHERE id = $1",
      [partnerId]
    );
    if (!partnerQ.rows.length) return res.status(404).json({ error: "Nie znaleziono partnera" });
    const partner = partnerQ.rows[0];

    const r = await pool.query(
      `INSERT INTO crm_partner_activities (
        partner_id, type, title, body,
        activity_at, duration_min, meeting_location, participants,
        assigned_to,
        opp_value, opp_currency, opp_status, opp_due_date,
        gmail_thread_id, gmail_message_id,
        created_by, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'new')
      RETURNING *,
        (SELECT display_name FROM users WHERE id = created_by)  AS created_by_name,
        (SELECT display_name FROM users WHERE id = assigned_to) AS assigned_to_name`,
      [
        partnerId, type, title, body || null,
        activity_at || null,
        duration_min ? parseInt(duration_min) : null,
        meeting_location || null,
        participants || null,
        assigned_to || null,
        opp_value ?? null, opp_currency || "PLN",
        opp_status || null, opp_due_date || null,
        gmail_thread_id || null, gmail_message_id || null,
        req.user.id,
      ]
    );
    const newAct = r.rows[0];

    await audit.log({
      user:       req.user,
      action:     'crm_activity_create',
      afterState: { type, title, assigned_to: assigned_to || null, activity_at: activity_at || null },
      metadata:   { partner_id: partnerId, activity_id: newAct.id, source: 'partner' },
    });

    // ── Powiadomienie email — tylko gdy przypisano do innego usera ────────────
    if (assigned_to && assigned_to !== req.user.id) {
      setImmediate(async () => {
        try {
          const { rows: assigneeRows } = await pool.query(
            'SELECT email, display_name FROM users WHERE id=$1', [assigned_to]
          );
          if (assigneeRows.length && assigneeRows[0].email) {
            await email.sendCrmActivityAssigned({
              to:            assigneeRows[0].email,
              assigneeName:  assigneeRows[0].display_name || assigneeRows[0].email,
              assignerName:  req.user.display_name || req.user.email,
              activityType:  type,
              activityTitle: title,
              activityAt:    activity_at || null,
              sourceName:    partner.company || `Partner #${partnerId}`,
              sourceType:    'partner',
              sourceId:      partnerId,
            });
          }
        } catch (emailErr) {
          logger.warn('Błąd wysyłki emaila o przypisaniu aktywności', { error: emailErr.message });
        }
      });
    }

    // ── Integracja Google Calendar (tylko dla spotkań) ─────────────────────────
    if (type === "meeting" && activity_at) {
      setImmediate(async () => {
        try {
          const startTime = new Date(activity_at);
          const durationMs = (parseInt(duration_min) || 60) * 60 * 1000;
          const endTime = new Date(startTime.getTime() + durationMs);

          const attendees = [];
          if (partner.email) attendees.push({ email: partner.email });
          if (participants) {
            participants.split(/[,;\s]+/).forEach(e => {
              const trimmed = e.trim();
              if (trimmed && trimmed.includes("@")) attendees.push({ email: trimmed });
            });
          }

          await calendarService.createEvent({
            summary: `${title} — ${partner.company}`,
            description: body || `Spotkanie z partnerem: ${partner.company}\nMiejsce: ${meeting_location || "—"}`,
            location: meeting_location || "",
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            attendees,
            organizerEmail: req.user.email || config.google.impersonateEmail,
          });
        } catch (calErr) {
          console.warn("[Calendar] Nie udało się utworzyć eventu dla partnera:", calErr.message);
        }
      });
    }

    res.status(201).json(newAct);
  } catch (err) {
    console.error("POST /crm/partners/:id/activities error:", err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

router.patch("/:id/activities/:actId", requireAuth, crmAuth, async (req, res) => {
  try {
    const partnerId = parseInt(req.params.id);
    const actId     = parseInt(req.params.actId);

    const { rows: existing } = await pool.query(
      'SELECT * FROM crm_partner_activities WHERE id=$1 AND partner_id=$2',
      [actId, partnerId]
    );
    if (!existing.length) return res.status(404).json({ error: 'Aktywność nie znaleziona' });
    const act = existing[0];

    const isManager  = req.user.is_admin || req.user.crm_role === 'sales_manager';
    const isAssigned = act.assigned_to === req.user.id;
    if (act.created_by !== req.user.id && !isManager && !isAssigned) {
      return res.status(403).json({ error: 'Brak uprawnień do edycji tej aktywności' });
    }

    const newStatus = req.body.status ?? act.status;
    if (newStatus === 'closed' && !req.body.close_comment && !act.close_comment) {
      return res.status(400).json({ error: 'Komentarz jest wymagany przy zamknięciu aktywności' });
    }

    const type             = req.body.type             ?? act.type;
    const title            = req.body.title            ?? act.title;
    const body             = req.body.body             !== undefined ? req.body.body             : act.body;
    const activity_at      = req.body.activity_at      !== undefined ? req.body.activity_at      : act.activity_at;
    const participants     = req.body.participants     !== undefined ? req.body.participants     : act.participants;
    const meeting_location = req.body.meeting_location !== undefined ? req.body.meeting_location : act.meeting_location;
    const assigned_to      = req.body.assigned_to      !== undefined ? req.body.assigned_to      : act.assigned_to;
    const close_comment    = req.body.close_comment    !== undefined ? req.body.close_comment    : act.close_comment;
    const opp_value        = req.body.opp_value        !== undefined ? req.body.opp_value        : act.opp_value;
    const opp_currency     = req.body.opp_currency     !== undefined ? req.body.opp_currency     : act.opp_currency;
    const opp_status       = req.body.opp_status       !== undefined ? req.body.opp_status       : act.opp_status;
    const opp_due_date     = req.body.opp_due_date     !== undefined ? req.body.opp_due_date     : act.opp_due_date;

    const { rows } = await pool.query(`
      UPDATE crm_partner_activities
      SET type=$1, title=$2, body=$3, activity_at=$4, participants=$5, meeting_location=$6,
          assigned_to=$7, status=$8, close_comment=$9,
          opp_value=$10, opp_currency=$11, opp_status=$12, opp_due_date=$13,
          updated_at=NOW()
      WHERE id=$14
      RETURNING *,
        (SELECT display_name FROM users WHERE id = created_by)  AS created_by_name,
        (SELECT display_name FROM users WHERE id = assigned_to) AS assigned_to_name
    `, [type, title, body||null, activity_at||null, participants||null, meeting_location||null,
        assigned_to||null, newStatus, close_comment||null,
        opp_value??null, opp_currency||'PLN', opp_status||null, opp_due_date||null,
        actId]);

    const auditAction = newStatus === 'closed' && act.status !== 'closed'
      ? 'crm_activity_close'
      : 'crm_activity_update';

    await audit.log({
      user:        req.user,
      action:      auditAction,
      beforeState: { type: act.type, title: act.title, status: act.status, assigned_to: act.assigned_to },
      afterState:  { type, title, status: newStatus, assigned_to, close_comment },
      metadata:    { partner_id: partnerId, activity_id: actId, source: 'partner' },
    });

    res.json(rows[0]);
  } catch (err) {
    console.error("PATCH /crm/partners/:id/activities/:actId error:", err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

router.delete("/:id/activities/:actId", requireAuth, crmAuth, async (req, res) => {
  try {
    const u = req.user;
    const actQ = await pool.query(
      "SELECT created_by FROM crm_partner_activities WHERE id = $1 AND partner_id = $2",
      [req.params.actId, req.params.id]
    );
    if (!actQ.rows.length) return res.status(404).json({ error: "Nie znaleziono" });
    const isOwner = actQ.rows[0].created_by === u.id;
    const isMgr   = u.is_admin || u.crm_role === "sales_manager";
    if (!isOwner && !isMgr) return res.status(403).json({ error: "Brak uprawnień" });

    await pool.query(
      "DELETE FROM crm_partner_activities WHERE id = $1 AND partner_id = $2",
      [req.params.actId, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ONBOARDING TASKS — /onboarding-tasks (alias zgodny z frontendem)
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/:id/onboarding-tasks", requireAuth, crmAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.*, u.display_name AS assigned_to_name, d.display_name AS done_by_name
       FROM crm_onboarding_tasks t
       LEFT JOIN users u ON u.id = t.assigned_to
       LEFT JOIN users d ON d.id = t.done_by
       WHERE t.partner_id = $1
       ORDER BY t.step, t.created_at`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
});

router.post("/:id/onboarding-tasks", requireAuth, crmAuth, async (req, res) => {
  try {
    const { step = 0, title, body, type = "task", assigned_to, due_date, due_time } = req.body;
    if (!title) return res.status(400).json({ error: "title jest wymagane" });
    const r = await pool.query(
      `INSERT INTO crm_onboarding_tasks (partner_id, step, title, body, type, assigned_to, due_date, due_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, step, title, body || null, type, assigned_to || null, due_date || null, due_time || null, req.user.id]
    );
    const task = r.rows[0];
    if (assigned_to) {
      const uQ = await pool.query("SELECT display_name FROM users WHERE id=$1", [assigned_to]);
      task.assigned_to_name = uQ.rows[0]?.display_name || null;
    }
    res.status(201).json(task);
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
});

router.patch("/:id/onboarding-tasks/:taskId", requireAuth, crmAuth, async (req, res) => {
  try {
    const { id, taskId } = req.params;
    const allowed = ["title", "body", "type", "assigned_to", "due_date", "due_time", "done"];
    const sets   = [];
    const params = [];
    for (const key of allowed) {
      if (key in req.body) {
        if (key === "done") {
          params.push(req.body.done ? req.user.id : null);
          sets.push(`done_by = $${params.length}`);
          params.push(req.body.done ? new Date().toISOString() : null);
          sets.push(`done_at = $${params.length}`);
          params.push(!!req.body.done);
          sets.push(`done = $${params.length}`);
        } else {
          params.push(req.body[key] === "" ? null : req.body[key]);
          sets.push(`${key} = $${params.length}`);
        }
      }
    }
    if (!sets.length) return res.status(400).json({ error: "Brak pól" });
    params.push(taskId, id);
    const r = await pool.query(
      `UPDATE crm_onboarding_tasks SET ${sets.join(", ")}, updated_at = NOW()
       WHERE id = $${params.length - 1} AND partner_id = $${params.length}
       RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: "Nie znaleziono" });
    const task = r.rows[0];
    if (task.assigned_to) {
      const uQ = await pool.query("SELECT display_name FROM users WHERE id=$1", [task.assigned_to]);
      task.assigned_to_name = uQ.rows[0]?.display_name || null;
    }
    if (task.done_by) {
      const dQ = await pool.query("SELECT display_name FROM users WHERE id=$1", [task.done_by]);
      task.done_by_name = dQ.rows[0]?.display_name || null;
    }
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
});

router.delete("/:id/onboarding-tasks/:taskId", requireAuth, crmAuth, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM crm_onboarding_tasks WHERE id = $1 AND partner_id = $2",
      [req.params.taskId, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ONBOARDING TASKS — /tasks (oryginalne endpointy — zachowane dla backcompatibility)
router.get("/:id/tasks", requireAuth, crmAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.*, u.display_name AS assigned_to_name, d.display_name AS done_by_name
       FROM crm_onboarding_tasks t
       LEFT JOIN users u ON u.id = t.assigned_to
       LEFT JOIN users d ON d.id = t.done_by
       WHERE t.partner_id = $1
       ORDER BY t.step, t.created_at`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
});

router.post("/:id/tasks", requireAuth, crmAuth, async (req, res) => {
  try {
    const { step = 0, title, body, type = "task", assigned_to, due_date, due_time } = req.body;
    if (!title) return res.status(400).json({ error: "title jest wymagane" });
    const r = await pool.query(
      `INSERT INTO crm_onboarding_tasks (partner_id, step, title, body, type, assigned_to, due_date, due_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, step, title, body || null, type, assigned_to || null, due_date || null, due_time || null, req.user.id]
    );
    const task = r.rows[0];
    if (assigned_to) {
      const uQ = await pool.query("SELECT display_name FROM users WHERE id=$1", [assigned_to]);
      task.assigned_to_name = uQ.rows[0]?.display_name || null;
    }
    res.status(201).json(task);
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
});

router.patch("/:id/tasks/:taskId", requireAuth, crmAuth, async (req, res) => {
  try {
    const { id, taskId } = req.params;
    const allowed = ["title", "body", "type", "assigned_to", "due_date", "due_time", "done"];
    const sets   = [];
    const params = [];
    for (const key of allowed) {
      if (key in req.body) {
        if (key === "done") {
          params.push(req.body.done ? req.user.id : null);
          sets.push(`done_by = $${params.length}`);
          params.push(req.body.done ? new Date().toISOString() : null);
          sets.push(`done_at = $${params.length}`);
          params.push(!!req.body.done);
          sets.push(`done = $${params.length}`);
        } else {
          params.push(req.body[key] === "" ? null : req.body[key]);
          sets.push(`${key} = $${params.length}`);
        }
      }
    }
    if (!sets.length) return res.status(400).json({ error: "Brak pól" });
    params.push(taskId, id);
    const r = await pool.query(
      `UPDATE crm_onboarding_tasks SET ${sets.join(", ")}, updated_at = NOW()
       WHERE id = $${params.length - 1} AND partner_id = $${params.length}
       RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: "Nie znaleziono" });
    const task = r.rows[0];
    // Dołącz display names
    if (task.assigned_to) {
      const uQ = await pool.query("SELECT display_name FROM users WHERE id=$1", [task.assigned_to]);
      task.assigned_to_name = uQ.rows[0]?.display_name || null;
    }
    if (task.done_by) {
      const dQ = await pool.query("SELECT display_name FROM users WHERE id=$1", [task.done_by]);
      task.done_by_name = dQ.rows[0]?.display_name || null;
    }
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
});

router.delete("/:id/tasks/:taskId", requireAuth, crmAuth, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM crm_onboarding_tasks WHERE id = $1 AND partner_id = $2",
      [req.params.taskId, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ONBOARDING STEP (advance)
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/:id/onboarding-step", requireAuth, crmAuth, async (req, res) => {
  if (!assertManager(req, res)) return;
  try {
    const { step } = req.body;
    const isFinishing = step >= 4; // > ostatni krok = zakończ onboarding
    const update = isFinishing
      ? "SET onboarding_step = 4, status = 'active', updated_at = NOW()"
      : `SET onboarding_step = ${parseInt(step)}, updated_at = NOW()`;
    const r = await pool.query(
      `UPDATE crm_partners ${update} WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Nie znaleziono" });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ── PATCH /:id/onboarding — alias wywoływany przez frontend (crm-api.service.ts)
router.patch("/:id/onboarding", requireAuth, crmAuth, async (req, res) => {
  try {
    const { step } = req.body;
    if (step === undefined || step === null) {
      return res.status(400).json({ error: "Pole step jest wymagane" });
    }
    const stepInt = parseInt(step);
    const isFinishing = stepInt >= 4;
    const update = isFinishing
      ? "SET onboarding_step = 4, status = 'active', updated_at = NOW()"
      : `SET onboarding_step = ${stepInt}, updated_at = NOW()`;
    const r = await pool.query(
      `UPDATE crm_partners ${update} WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Nie znaleziono partnera" });
    res.json(r.rows[0]);
  } catch (err) {
    console.error("PATCH /onboarding error:", err);
    res.status(500).json({ error: "Błąd serwera" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOKUMENTY POWIĄZANE
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/:id/documents", requireAuth, crmAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT pd.*, d.name AS document_title, d.status AS document_status,
              d.doc_number, d.doc_type
       FROM crm_partner_documents pd
       LEFT JOIN documents d ON d.id = pd.document_id
       WHERE pd.partner_id = $1
       ORDER BY pd.linked_at DESC`,
      [parseInt(req.params.id)]
    );
    res.json(r.rows);
  } catch (err) {
    console.error("GET /crm/partners/:id/documents error:", err.message);
    res.status(500).json({ error: "Błąd serwera", detail: err.message });
  }
});

router.post("/:id/documents", requireAuth, crmAuth, async (req, res) => {
  try {
    const { document_id, doc_role } = req.body;
    const r = await pool.query(
      `INSERT INTO crm_partner_documents (partner_id, document_id, doc_role, linked_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (partner_id, document_id) DO UPDATE SET doc_role = EXCLUDED.doc_role
       RETURNING *`,
      [parseInt(req.params.id), document_id, doc_role || null, req.user.id]
    );
    res.status(201).json(r.rows[0] || { partner_id: req.params.id, document_id });
  } catch (err) {
    console.error("POST /crm/partners/:id/documents error:", err.message);
    res.status(500).json({ error: "Błąd serwera", detail: err.message });
  }
});

router.delete("/:id/documents/:docId", requireAuth, crmAuth, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM crm_partner_documents WHERE partner_id = $1 AND document_id = $2",
      [parseInt(req.params.id), req.params.docId]
    );
    res.status(204).end();
  } catch (err) {
    console.error("DELETE /crm/partners/:id/documents error:", err.message);
    res.status(500).json({ error: "Błąd serwera", detail: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GRUPY PARTNERÓW
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/groups/list", requireAuth, crmAuth, async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM crm_partner_groups ORDER BY name");
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: "Błąd serwera" });
  }
});

module.exports = router;
