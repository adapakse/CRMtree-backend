'use strict';
// services/projectFinanceService.js
//
// Project finance: budget, cost items, revenue items and the figures derived
// from them. Project controlling, not accounting — net amounts, no VAT, one
// currency per project.
//
// Who may do what (access = { canRead, canWrite, canAddOwnCosts }):
//   - PM / tenant admin: read and write everything.
//   - controller: reads everything, writes nothing.
//   - internal participant: nothing, unless the PM switched on
//     participants_can_add_costs — then they add cost items to tasks they are
//     assigned to and list / edit / delete only the items they created.
//     Budget, revenue and summary stay hidden from them.
//   - external participant: nothing.
// The whole feature is behind the tenant switch (projectConfigService.isFinanceEnabled).
//
// A cost item MAY be linked to a KSeF purchase invoice (ksef_invoice_id):
//   - linking and unlinking need finance write access AND the KSeF permission
//     (tenant admin or users.can_view_ksef_invoices); a participant who only
//     adds costs to own tasks can never use KSeF invoices;
//   - whoever may read the project's finance sees the invoice summary and the
//     other links of the same invoice on its cost items, with or without the
//     KSeF permission;
//   - linking is never blocked — see ksefInvoiceService for how over-allocation
//     is reported instead.
//
// A cost item MAY also be linked to an invoice DOCUMENT (document_id — a
// document of type invoice in the Documents module):
//   - a KSeF-linked item always points at the document registered from its
//     invoice (or at none while the invoice has no document). Linking a KSeF
//     invoice registers it in Documents when the tenant has chosen an access
//     group for invoice documents; attaching the document of a KSeF invoice is
//     the same as linking that invoice, with the same permission;
//   - a document entered by hand is attached and detached by whoever has
//     finance write access and can open the document in Documents;
//   - other_links lists every other cost item sharing the KSeF invoice or the
//     document, so the same rules apply to both kinds.
//
// Changes are recorded in audit_logs by the routes. Their metadata carries no
// task_id on purpose: the task history is read by everyone who sees the task.

const db = require('../config/database');
const projectConfigService = require('./projectConfigService');
const exchangeRateService = require('./exchangeRateService');
const ksefInvoiceService = require('./ksefInvoiceService');
const invoiceDocumentService = require('./invoiceDocumentService');
const { roundMoney, buildTotals, buildCategoryRows, buildTaskRows } = require('./projectFinanceCalculations');

const COST_STATUSES    = ['planned', 'incurred'];
const REVENUE_STATUSES = ['planned', 'invoiced', 'paid'];
const DEFAULT_CURRENCY = 'PLN';
const ISO_CURRENCIES   = new Set(Intl.supportedValuesOf('currency'));
const RATE_DECIMALS    = 8;

const COST_ITEM_SELECT = `
  SELECT c.id, c.project_id, c.cost_date AS "date", c.amount::float AS amount,
         c.category_id, category.name AS category_name, c.description,
         c.task_id, t.task_number, t.name AS task_name,
         c.supplier_name, c.document_number, c.status,
         c.original_amount::float AS original_amount, c.original_currency,
         c.exchange_rate::float AS exchange_rate, c.exchange_rate_date, c.ksef_invoice_id, c.document_id,
         c.created_by, author.display_name AS created_by_name, c.created_at, c.updated_at
  FROM project_cost_items c
  JOIN project_cost_categories category ON category.id = c.category_id
  LEFT JOIN project_tasks t ON t.id = c.task_id
  LEFT JOIN users author ON author.id = c.created_by`;

const REVENUE_ITEM_SELECT = `
  SELECT r.id, r.project_id, r.revenue_date AS "date", r.amount::float AS amount,
         r.description, r.status,
         r.created_by, author.display_name AS created_by_name, r.created_at, r.updated_at
  FROM project_revenue_items r
  LEFT JOIN users author ON author.id = r.created_by`;

const COST_AUDIT_FIELDS = [
  'date', 'amount', 'category_id', 'task_id', 'status', 'description', 'supplier_name',
  'document_number', 'original_amount', 'original_currency', 'exchange_rate', 'exchange_rate_date',
  'ksef_invoice_id', 'document_id',
];
const MAX_SUPPLIER_NAME_LENGTH   = 200;
const MAX_DOCUMENT_NUMBER_LENGTH = 100;
const KSEF_LINKING_DENIED =
  'Linking KSeF invoices requires the KSeF invoices permission and write access to the project finance';
const DOCUMENT_LINKING_DENIED =
  'Linking an invoice document requires write access to the project finance and access to the document';
const DOCUMENT_INVOICE_MISMATCH = 'The document does not belong to this KSeF invoice';
const REVENUE_AUDIT_FIELDS = ['date', 'amount', 'status', 'description'];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function pick(source, fields) {
  return Object.fromEntries(fields.map((field) => [field, source[field]]));
}

function changedFields(before, after, fields) {
  return fields.filter((field) => before[field] !== after[field]);
}

function assertKnownCurrency(currency) {
  if (!ISO_CURRENCIES.has(currency)) throw httpError(400, 'Unknown currency code');
}

// ── Settings and access ─────────────────────────────────────────────────

async function getSettings(projectId) {
  const { rows: [settings] } = await db.query(
    `SELECT currency, planned_revenue::float AS planned_revenue, participants_can_add_costs
     FROM project_finance WHERE project_id = $1`,
    [projectId],
  );
  return settings || { currency: DEFAULT_CURRENCY, planned_revenue: null, participants_can_add_costs: false };
}

function resolveAccess({ membership, canManage, settings }) {
  const canWrite = Boolean(canManage);
  const canRead = canWrite || membership?.role === 'controller';
  const canAddOwnCosts = !canRead
    && membership?.role === 'internal_participant'
    && settings.participants_can_add_costs;
  return { canRead, canWrite, canAddOwnCosts };
}

// Whether task lists may show (and filter by) the cost of this project's tasks.
async function canReadTaskCosts({ tenantId, membership, canManage }) {
  return resolveAccess({ membership, canManage, settings: {} }).canRead
    && projectConfigService.isFinanceEnabled(tenantId);
}

// What the project card tells the frontend about finance; null when the
// caller has nothing to do with it (or the tenant switch is off).
async function describeAccess({ tenantId, project, membership, canManage }) {
  if (!await projectConfigService.isFinanceEnabled(tenantId)) return null;
  const settings = await getSettings(project.id);
  const access = resolveAccess({ membership, canManage, settings });
  if (!access.canRead && !access.canAddOwnCosts) return null;
  const isOpen = project.status === 'open';
  return {
    currency: settings.currency,
    can_read: access.canRead,
    can_write: isOpen && access.canWrite,
    can_add_own_costs: isOpen && access.canAddOwnCosts,
  };
}

async function hasItems(projectId) {
  const { rows: [found] } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM project_cost_items WHERE project_id = $1)
         OR EXISTS (SELECT 1 FROM project_revenue_items WHERE project_id = $1) AS has_items`,
    [projectId],
  );
  return found.has_items;
}

// ── Totals shared by the project list and the CRM cards ─────────────────

async function loadTotalsByProject(projectIds) {
  if (!projectIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT p.id AS project_id,
            COALESCE(f.currency, $2) AS currency,
            f.planned_revenue::float AS revenue_planned,
            (SELECT COALESCE(SUM(b.planned_cost), 0)::float
               FROM project_category_budgets b WHERE b.project_id = p.id) AS cost_planned,
            (SELECT COALESCE(SUM(c.amount), 0)::float
               FROM project_cost_items c WHERE c.project_id = p.id AND c.status = 'incurred') AS cost_actual,
            (SELECT COALESCE(SUM(r.amount), 0)::float
               FROM project_revenue_items r
              WHERE r.project_id = p.id AND r.status IN ('invoiced', 'paid')) AS revenue_actual
     FROM projects p
     LEFT JOIN project_finance f ON f.project_id = p.id
     WHERE p.id = ANY($1::uuid[])`,
    [projectIds, DEFAULT_CURRENCY],
  );
  return new Map(rows.map((row) => [row.project_id, buildTotals(row)]));
}

// Totals for the project list, only for the projects whose finance the user
// may read: every project for the tenant admin, otherwise those where the
// user is PM or controller. `projects` are rows of projectService.listProjects.
async function loadTotalsForList({ tenantId, user, projects }) {
  const readableIds = projects
    .filter((project) => user.is_admin || ['pm', 'controller'].includes(project.my_role))
    .map((project) => project.id);
  if (!readableIds.length || !await projectConfigService.isFinanceEnabled(tenantId)) return new Map();
  return loadTotalsByProject(readableIds);
}

// ── Summary for the Finance tab ─────────────────────────────────────────

// The lead's value in the project currency at the newest known rate, offered
// only while the project has no planned revenue. Nothing is stored.
async function suggestPlannedRevenue({ tenantId, project, settings }) {
  if (settings.planned_revenue !== null || !project.lead_id) return null;
  const { rows: [lead] } = await db.query(
    `SELECT value_pln::float AS value, COALESCE(annual_turnover_currency, $3) AS currency
     FROM crm_leads WHERE id = $1 AND tenant_id = $2`,
    [project.lead_id, tenantId, DEFAULT_CURRENCY],
  );
  if (!lead || !(lead.value > 0)) return null;
  const rate = await exchangeRateService.getLatestCrossRate(lead.currency, settings.currency);
  return rate === null ? null : roundMoney(lead.value * rate);
}

async function getSummary({ tenantId, project }) {
  // A category budget screen needs the dictionary even before anyone opened the settings.
  await projectConfigService.listCostCategories(tenantId);
  const settings = await getSettings(project.id);

  const [categories, tasks, revenues, isCurrencyLocked, suggestedPlannedRevenue] = await Promise.all([
    db.query(
      `SELECT category.id, category.name, category.is_active,
              b.planned_cost::float AS budget,
              COALESCE(SUM(c.amount) FILTER (WHERE c.status = 'incurred'), 0)::float AS incurred,
              COALESCE(SUM(c.amount) FILTER (WHERE c.status = 'planned'), 0)::float AS planned
       FROM project_cost_categories category
       LEFT JOIN project_category_budgets b ON b.category_id = category.id AND b.project_id = $2
       LEFT JOIN project_cost_items c ON c.category_id = category.id AND c.project_id = $2
       WHERE category.tenant_id = $1
       GROUP BY category.id, b.planned_cost
       ORDER BY category.sort_order, category.name`,
      [tenantId, project.id],
    ),
    db.query(
      `SELECT t.id, t.task_number, t.name, t.parent_task_id, t.planned_cost::float AS planned_cost,
              COALESCE(SUM(c.amount) FILTER (WHERE c.status = 'incurred'), 0)::float AS incurred,
              COALESCE(SUM(c.amount) FILTER (WHERE c.status = 'planned'), 0)::float AS planned
       FROM project_tasks t
       LEFT JOIN project_cost_items c ON c.task_id = t.id
       WHERE t.project_id = $1
       GROUP BY t.id
       ORDER BY t.task_number`,
      [project.id],
    ),
    db.query(
      `SELECT status, SUM(amount)::float AS total
       FROM project_revenue_items WHERE project_id = $1 GROUP BY status`,
      [project.id],
    ),
    hasItems(project.id),
    suggestPlannedRevenue({ tenantId, project, settings }),
  ]);

  const sum = (rows, field) => roundMoney(rows.reduce((total, row) => total + (row[field] ?? 0), 0));
  const revenueByStatus = Object.fromEntries(REVENUE_STATUSES.map((status) => [status, 0]));
  for (const row of revenues.rows) revenueByStatus[row.status] = row.total;

  const totals = buildTotals({
    currency: settings.currency,
    revenue_planned: settings.planned_revenue,
    revenue_actual: roundMoney(revenueByStatus.invoiced + revenueByStatus.paid),
    cost_planned: sum(categories.rows, 'budget'),
    cost_actual: sum(categories.rows, 'incurred'),
  });

  return {
    currency: totals.currency,
    is_currency_locked: isCurrencyLocked,
    participants_can_add_costs: settings.participants_can_add_costs,
    revenue: { ...totals.revenue, by_status: revenueByStatus },
    suggested_planned_revenue: suggestedPlannedRevenue,
    cost: {
      ...totals.cost,
      planned_items: sum(categories.rows, 'planned'),
      task_planned_total: sum(tasks.rows, 'planned_cost'),
    },
    margin: totals.margin,
    remaining_budget: roundMoney(totals.cost.planned - totals.cost.actual),
    categories: buildCategoryRows(categories.rows),
    tasks: buildTaskRows(tasks.rows),
  };
}

// ── Budget (plan) ───────────────────────────────────────────────────────

async function loadCategoryBudgets(projectId) {
  const { rows } = await db.query(
    `SELECT category_id, planned_cost::float AS planned_cost
     FROM project_category_budgets WHERE project_id = $1 ORDER BY category_id`,
    [projectId],
  );
  return rows;
}

// A deactivated category may keep the budget it already has, but cannot be
// given one for the first time.
async function assertBudgetCategories({ tenantId, categoryBudgets, currentBudgets }) {
  const categoryIds = categoryBudgets.map((entry) => entry.category_id);
  if (new Set(categoryIds).size !== categoryIds.length) {
    throw httpError(400, 'A cost category is listed more than once');
  }
  const { rows: known } = await db.query(
    'SELECT id, is_active FROM project_cost_categories WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
    [tenantId, categoryIds],
  );
  if (known.length !== categoryIds.length) throw httpError(400, 'Unknown cost category');
  const alreadyBudgeted = new Set(currentBudgets.map((entry) => entry.category_id));
  if (known.some((category) => !category.is_active && !alreadyBudgeted.has(category.id))) {
    throw httpError(400, 'An inactive cost category cannot be added to the budget');
  }
}

// `changes`: any of currency, planned_revenue, participants_can_add_costs,
// category_budgets ([{ category_id, planned_cost }] — replaces the whole list).
async function updateFinancePlan({ tenantId, project, changes }) {
  const settings = await getSettings(project.id);
  const currentBudgets = await loadCategoryBudgets(project.id);
  const has = (field) => changes[field] !== undefined;

  const next = { ...settings };
  if (has('currency') && changes.currency !== settings.currency) {
    assertKnownCurrency(changes.currency);
    if (await hasItems(project.id)) {
      throw httpError(409, 'The project currency can be changed only while the project has no cost or revenue items');
    }
    next.currency = changes.currency;
  }
  if (has('planned_revenue')) next.planned_revenue = changes.planned_revenue;
  if (has('participants_can_add_costs')) next.participants_can_add_costs = changes.participants_can_add_costs;
  if (has('category_budgets')) {
    await assertBudgetCategories({ tenantId, categoryBudgets: changes.category_budgets, currentBudgets });
  }

  await db.transaction(async (client) => {
    await client.query(
      `INSERT INTO project_finance (project_id, tenant_id, currency, planned_revenue, participants_can_add_costs)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id) DO UPDATE
         SET currency = EXCLUDED.currency, planned_revenue = EXCLUDED.planned_revenue,
             participants_can_add_costs = EXCLUDED.participants_can_add_costs, updated_at = now()`,
      [project.id, tenantId, next.currency, next.planned_revenue, next.participants_can_add_costs],
    );
    if (!has('category_budgets')) return;
    await client.query('DELETE FROM project_category_budgets WHERE project_id = $1', [project.id]);
    for (const entry of changes.category_budgets) {
      await client.query(
        `INSERT INTO project_category_budgets (project_id, category_id, tenant_id, planned_cost)
         VALUES ($1, $2, $3, $4)`,
        [project.id, entry.category_id, tenantId, entry.planned_cost],
      );
    }
  });

  const before = { ...settings, category_budgets: currentBudgets };
  const after = { ...next, category_budgets: await loadCategoryBudgets(project.id) };
  return { before, after };
}

async function setTaskPlannedCost({ projectId, taskId, plannedCost }) {
  const { rows: [task] } = await db.query(
    `SELECT id, task_number, planned_cost::float AS planned_cost
     FROM project_tasks WHERE id = $1 AND project_id = $2`,
    [taskId, projectId],
  );
  if (!task) throw httpError(404, 'Task not found');
  await db.query('UPDATE project_tasks SET planned_cost = $1 WHERE id = $2', [plannedCost, taskId]);
  return { task_id: task.id, task_number: task.task_number, before: task.planned_cost, after: plannedCost };
}

// ── Cost items ──────────────────────────────────────────────────────────

async function listCostItems({ projectId, access, user, taskId }) {
  const params = [projectId];
  const conditions = ['c.project_id = $1'];
  if (!access.canRead) {
    params.push(user.id);
    conditions.push(`c.created_by = $${params.length}`);
  }
  if (taskId) {
    params.push(taskId);
    conditions.push(`c.task_id = $${params.length}`);
  }
  const { rows } = await db.query(
    `${COST_ITEM_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY c.cost_date DESC, c.created_at DESC`,
    params,
  );
  return withInvoiceInfo(rows, access, user);
}

function withInvoiceInfo(items, access, user) {
  return ksefInvoiceService.attachInvoiceInfo(items, { canSeeInvoices: access.canRead, user });
}

// Returns null when the item does not exist in the project or the caller may
// not see it — a participant sees only the items they created.
async function findCostItem({ projectId, itemId, access, userId }) {
  const { rows: [item] } = await db.query(
    `${COST_ITEM_SELECT} WHERE c.id = $1 AND c.project_id = $2`, [itemId, projectId],
  );
  if (!item) return null;
  if (!access.canRead && item.created_by !== userId) return null;
  return item;
}

async function assertActiveCategory(tenantId, categoryId) {
  const { rows } = await db.query(
    'SELECT 1 FROM project_cost_categories WHERE id = $1 AND tenant_id = $2 AND is_active',
    [categoryId, tenantId],
  );
  if (!rows.length) throw httpError(400, 'Unknown or inactive cost category');
}

// A PM may book a cost on any task of the project or on none; a participant
// only on a task they are assigned to.
async function assertTaskAllowed({ projectId, taskId, access, userId }) {
  if (!taskId) {
    if (access.canWrite) return;
    throw httpError(403, 'You can add costs only to tasks you are assigned to');
  }
  const { rows: [task] } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM project_task_assignees a
                    WHERE a.task_id = t.id AND a.user_id = $3) AS is_assigned
     FROM project_tasks t WHERE t.id = $1 AND t.project_id = $2`,
    [taskId, projectId, userId],
  );
  if (!task) throw httpError(400, 'The task must belong to the same project');
  if (!access.canWrite && !task.is_assigned) {
    throw httpError(403, 'You can add costs only to tasks you are assigned to');
  }
}

function canUseKsefInvoices(user, access) {
  return access.canWrite && Boolean(user.is_admin || user.can_view_ksef_invoices);
}

async function loadInvoiceDocument(tenantId, documentId) {
  const document = await invoiceDocumentService.findInvoiceDocument({ tenantId, documentId });
  if (!document) throw httpError(400, 'Unknown invoice document');
  return document;
}

async function assertCanLinkDocument({ user, access, documentId }) {
  if (!access.canWrite || !await invoiceDocumentService.canOpenDocument(user, documentId)) {
    throw httpError(403, DOCUMENT_LINKING_DENIED);
  }
}

// The KSeF invoice a request points at — directly, or through the document
// registered from it — after checking that the two agree.
function resolveKsefInvoiceId({ requestedInvoiceId, isInvoiceRequested, document }) {
  if (!document) return requestedInvoiceId;
  const isMismatch = document.ksef_invoice_id
    ? isInvoiceRequested && requestedInvoiceId !== document.ksef_invoice_id
    : Boolean(requestedInvoiceId);
  if (isMismatch) throw httpError(400, DOCUMENT_INVOICE_MISMATCH);
  return document.ksef_invoice_id || requestedInvoiceId;
}

// What a cost item takes over from a hand-entered invoice document, in the
// shape of a KSeF invoice summary. The seller is the second entity; with fewer
// than two the only name may be the buyer's, so none is taken.
function invoiceDefaultsOf(document) {
  return {
    issue_date: document.signing_date,
    net_amount: document.net_amount,
    currency: document.currency,
    seller_name: document.entities.length > 1 ? document.entities[1] : null,
    invoice_number: document.invoice_number,
  };
}

// Decides the amount in the project currency. An explicit amount always wins;
// otherwise an amount entered in another currency is converted with the NBP
// rate for `date` (the cost date, or the issue date of the linked KSeF
// invoice), and the rate used is kept with the item.
async function resolveCostAmounts({ amount, originalAmount, originalCurrency, projectCurrency, date }) {
  const hasOriginalAmount = originalAmount !== null && originalAmount !== undefined;
  if (hasOriginalAmount !== Boolean(originalCurrency)) {
    throw httpError(400, 'An original amount requires both original_amount and original_currency');
  }
  if (originalCurrency) assertKnownCurrency(originalCurrency);
  const isForeign = Boolean(originalCurrency) && originalCurrency !== projectCurrency;
  const original = {
    original_amount: isForeign ? originalAmount : null,
    original_currency: isForeign ? originalCurrency : null,
  };

  if (amount !== null && amount !== undefined) {
    return { amount, ...original, exchange_rate: null, exchange_rate_date: null };
  }
  if (!hasOriginalAmount) throw httpError(400, 'Provide amount, or original_amount with original_currency');
  if (!isForeign) return { amount: originalAmount, ...original, exchange_rate: null, exchange_rate_date: null };

  const { rate, rate_date: rateDate } = await exchangeRateService.getCrossRate(originalCurrency, projectCurrency, date);
  const converted = roundMoney(originalAmount * rate);
  if (!(converted > 0)) throw httpError(400, 'The converted amount must be greater than zero');
  return {
    amount: converted,
    ...original,
    exchange_rate: Number(rate.toFixed(RATE_DECIMALS)),
    exchange_rate_date: rateDate,
  };
}

async function createCostItem({ tenantId, project, access, user, input }) {
  const taskId = input.task_id || null;
  const document = input.document_id ? await loadInvoiceDocument(tenantId, input.document_id) : null;
  const ksefInvoiceId = resolveKsefInvoiceId({
    requestedInvoiceId: input.ksef_invoice_id || null,
    isInvoiceRequested: Boolean(input.ksef_invoice_id),
    document,
  });
  let ksefInvoice = null;
  if (ksefInvoiceId) {
    if (!canUseKsefInvoices(user, access)) throw httpError(403, KSEF_LINKING_DENIED);
    ksefInvoice = await ksefInvoiceService.findInvoiceSummary({ tenantId, invoiceId: ksefInvoiceId });
    if (!ksefInvoice) throw httpError(400, 'Unknown KSeF invoice');
  } else if (document) {
    await assertCanLinkDocument({ user, access, documentId: document.id });
  }
  // The invoice the defaults come from: the KSeF invoice, else the hand-entered document.
  const invoice = ksefInvoice || (document && invoiceDefaultsOf(document));
  const date = input.date || invoice?.issue_date;
  if (!date) throw httpError(400, 'The date is required');
  await assertActiveCategory(tenantId, input.category_id);
  await assertTaskAllowed({ projectId: project.id, taskId, access, userId: user.id });
  const settings = await getSettings(project.id);

  // Without any amount in the request the whole net amount of the invoice is assigned.
  const hasNoAmount = (input.amount === null || input.amount === undefined)
    && (input.original_amount === null || input.original_amount === undefined);
  const usesInvoiceAmount = Boolean(invoice) && hasNoAmount;
  if (usesInvoiceAmount && !(invoice.net_amount > 0 && invoice.currency)) {
    throw httpError(400, 'The invoice has no positive net amount; provide the amount');
  }
  const amounts = await resolveCostAmounts({
    amount: input.amount,
    originalAmount: usesInvoiceAmount ? invoice.net_amount : input.original_amount,
    originalCurrency: usesInvoiceAmount ? invoice.currency : input.original_currency,
    projectCurrency: settings.currency,
    date: invoice?.issue_date || date,
  });
  const supplierName = input.supplier_name || invoice?.seller_name?.slice(0, MAX_SUPPLIER_NAME_LENGTH) || null;
  const documentNumber = input.document_number
    || invoice?.invoice_number?.slice(0, MAX_DOCUMENT_NUMBER_LENGTH)
    || null;

  const documentId = ksefInvoice
    ? await invoiceDocumentService.registerKsefInvoiceOnLink({ tenantId, user, invoiceId: ksefInvoice.id })
    : document?.id || null;
  const linkedAt = new Date();
  const { rows: [created] } = await db.query(
    `INSERT INTO project_cost_items
       (tenant_id, project_id, task_id, category_id, cost_date, amount, description, supplier_name,
        document_number, status, original_amount, original_currency, exchange_rate, exchange_rate_date,
        created_by, ksef_invoice_id, ksef_linked_by, ksef_linked_at,
        document_id, document_linked_by, document_linked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     RETURNING id`,
    [tenantId, project.id, taskId, input.category_id, date, amounts.amount,
     input.description || null, supplierName, documentNumber,
     input.status || 'incurred', amounts.original_amount, amounts.original_currency,
     amounts.exchange_rate, amounts.exchange_rate_date, user.id,
     ksefInvoice?.id || null, ksefInvoice ? user.id : null, ksefInvoice ? linkedAt : null,
     documentId, documentId ? user.id : null, documentId ? linkedAt : null],
  );
  const item = await findCostItem({ projectId: project.id, itemId: created.id, access, userId: user.id });
  const [itemWithInvoice] = await withInvoiceInfo([item], access, user);
  return { item: itemWithInvoice, after: pick(item, COST_AUDIT_FIELDS) };
}

const COST_COLUMN_BY_FIELD = {
  date: 'cost_date',
  amount: 'amount',
  category_id: 'category_id',
  task_id: 'task_id',
  status: 'status',
  description: 'description',
  supplier_name: 'supplier_name',
  document_number: 'document_number',
  original_amount: 'original_amount',
  original_currency: 'original_currency',
  exchange_rate: 'exchange_rate',
  exchange_rate_date: 'exchange_rate_date',
  ksef_invoice_id: 'ksef_invoice_id',
  document_id: 'document_id',
};

// Works out the invoice link a PATCH results in and checks the permission for
// changing it. An unchanged link needs no permission, so the other fields of a
// linked item stay editable. Returns the KSeF invoice id, its summary, and the
// document id — `undefined` when the item was just linked to another KSeF
// invoice and the document is still to be registered.
async function resolveInvoiceLinkChange({ tenantId, user, access, item, changes }) {
  const has = (field) => changes[field] !== undefined;
  const isNewDocumentRequested = Boolean(changes.document_id) && changes.document_id !== item.document_id;
  const requestedDocument = isNewDocumentRequested ? await loadInvoiceDocument(tenantId, changes.document_id) : null;
  const ksefInvoiceId = resolveKsefInvoiceId({
    requestedInvoiceId: has('ksef_invoice_id') ? changes.ksef_invoice_id || null : item.ksef_invoice_id,
    isInvoiceRequested: has('ksef_invoice_id'),
    document: requestedDocument,
  });

  const isKsefLinkChanged = ksefInvoiceId !== item.ksef_invoice_id;
  if (isKsefLinkChanged && !canUseKsefInvoices(user, access)) throw httpError(403, KSEF_LINKING_DENIED);
  const ksefInvoice = ksefInvoiceId
    ? await ksefInvoiceService.findInvoiceSummary({ tenantId, invoiceId: ksefInvoiceId })
    : null;
  if (isKsefLinkChanged && ksefInvoiceId && !ksefInvoice) throw httpError(400, 'Unknown KSeF invoice');

  // The document of a KSeF-linked item follows the invoice, whatever the request says about it.
  if (ksefInvoiceId) {
    return { ksefInvoiceId, ksefInvoice, documentId: isKsefLinkChanged ? undefined : item.document_id };
  }
  let documentId = item.document_id;
  if (requestedDocument) documentId = requestedDocument.id;
  else if (isKsefLinkChanged || (has('document_id') && !changes.document_id)) documentId = null;
  if (!isKsefLinkChanged && documentId !== item.document_id) {
    await assertCanLinkDocument({ user, access, documentId: documentId || item.document_id });
  }
  return { ksefInvoiceId, ksefInvoice, documentId };
}

async function updateCostItem({ tenantId, project, access, user, itemId, changes }) {
  const item = await findCostItem({ projectId: project.id, itemId, access, userId: user.id });
  if (!item) throw httpError(404, 'Cost item not found');

  const has = (field) => changes[field] !== undefined;
  const next = pick(item, COST_AUDIT_FIELDS);
  for (const field of ['date', 'category_id', 'status', 'description', 'supplier_name', 'document_number']) {
    if (has(field)) next[field] = changes[field];
  }
  if (has('task_id')) next.task_id = changes.task_id || null;

  const link = await resolveInvoiceLinkChange({ tenantId, user, access, item, changes });
  const invoice = link.ksefInvoice;
  next.ksef_invoice_id = link.ksefInvoiceId;
  const isLinkChanged = next.ksef_invoice_id !== item.ksef_invoice_id;

  if (next.category_id !== item.category_id) await assertActiveCategory(tenantId, next.category_id);
  if (next.task_id !== item.task_id) {
    await assertTaskAllowed({ projectId: project.id, taskId: next.task_id, access, userId: user.id });
  }
  // Money is recalculated only when the request touches it; moving the date
  // alone keeps the amount the user has already seen.
  if (has('amount') || has('original_amount') || has('original_currency')) {
    const settings = await getSettings(project.id);
    Object.assign(next, await resolveCostAmounts({
      amount: has('amount') ? changes.amount : null,
      originalAmount: has('original_amount') ? changes.original_amount : item.original_amount,
      originalCurrency: has('original_currency') ? changes.original_currency : item.original_currency,
      projectCurrency: settings.currency,
      date: invoice?.issue_date || next.date,
    }));
  }

  // Last, once nothing can reject the request any more: it may create a document.
  next.document_id = link.documentId !== undefined
    ? link.documentId
    : await invoiceDocumentService.registerKsefInvoiceOnLink({ tenantId, user, invoiceId: next.ksef_invoice_id });

  const changed = changedFields(pick(item, COST_AUDIT_FIELDS), next, COST_AUDIT_FIELDS);
  if (!changed.length) {
    const [unchangedItem] = await withInvoiceInfo([item], access, user);
    return { item: unchangedItem, before: null, after: null };
  }

  const setClauses = changed.map((field, index) => `${COST_COLUMN_BY_FIELD[field]} = $${index + 1}`);
  const params = changed.map((field) => next[field]);
  const linkedAt = new Date();
  if (isLinkChanged) {
    params.push(next.ksef_invoice_id ? user.id : null, next.ksef_invoice_id ? linkedAt : null);
    setClauses.push(`ksef_linked_by = $${params.length - 1}`, `ksef_linked_at = $${params.length}`);
  }
  if (next.document_id !== item.document_id) {
    params.push(next.document_id ? user.id : null, next.document_id ? linkedAt : null);
    setClauses.push(`document_linked_by = $${params.length - 1}`, `document_linked_at = $${params.length}`);
  }
  params.push(itemId);
  await db.query(
    `UPDATE project_cost_items SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
    params,
  );
  const updated = await findCostItem({ projectId: project.id, itemId, access, userId: user.id });
  const [updatedWithInvoice] = await withInvoiceInfo([updated], access, user);
  return { item: updatedWithInvoice, before: pick(item, changed), after: pick(updated, changed) };
}

async function deleteCostItem({ project, access, user, itemId }) {
  const item = await findCostItem({ projectId: project.id, itemId, access, userId: user.id });
  if (!item) throw httpError(404, 'Cost item not found');
  await db.query('DELETE FROM project_cost_items WHERE id = $1', [itemId]);
  return { item, before: pick(item, COST_AUDIT_FIELDS) };
}

// ── Revenue items ───────────────────────────────────────────────────────

async function listRevenueItems(projectId) {
  const { rows } = await db.query(
    `${REVENUE_ITEM_SELECT} WHERE r.project_id = $1 ORDER BY r.revenue_date DESC, r.created_at DESC`,
    [projectId],
  );
  return rows;
}

async function findRevenueItem(projectId, itemId) {
  const { rows: [item] } = await db.query(
    `${REVENUE_ITEM_SELECT} WHERE r.id = $1 AND r.project_id = $2`, [itemId, projectId],
  );
  return item || null;
}

async function createRevenueItem({ tenantId, project, user, input }) {
  const { rows: [created] } = await db.query(
    `INSERT INTO project_revenue_items (tenant_id, project_id, revenue_date, amount, description, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [tenantId, project.id, input.date, input.amount, input.description || null,
     input.status || 'planned', user.id],
  );
  const item = await findRevenueItem(project.id, created.id);
  return { item, after: pick(item, REVENUE_AUDIT_FIELDS) };
}

const REVENUE_COLUMN_BY_FIELD = {
  date: 'revenue_date', amount: 'amount', status: 'status', description: 'description',
};

async function updateRevenueItem({ project, itemId, changes }) {
  const item = await findRevenueItem(project.id, itemId);
  if (!item) throw httpError(404, 'Revenue item not found');

  const next = pick(item, REVENUE_AUDIT_FIELDS);
  for (const field of REVENUE_AUDIT_FIELDS) {
    if (changes[field] !== undefined) next[field] = changes[field];
  }
  const changed = changedFields(pick(item, REVENUE_AUDIT_FIELDS), next, REVENUE_AUDIT_FIELDS);
  if (!changed.length) return { item, before: null, after: null };

  const setClauses = changed.map((field, index) => `${REVENUE_COLUMN_BY_FIELD[field]} = $${index + 1}`);
  const params = changed.map((field) => next[field]);
  params.push(itemId);
  await db.query(
    `UPDATE project_revenue_items SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
    params,
  );
  const updated = await findRevenueItem(project.id, itemId);
  return { item: updated, before: pick(item, changed), after: pick(updated, changed) };
}

async function deleteRevenueItem({ project, itemId }) {
  const item = await findRevenueItem(project.id, itemId);
  if (!item) throw httpError(404, 'Revenue item not found');
  await db.query('DELETE FROM project_revenue_items WHERE id = $1', [itemId]);
  return { item, before: pick(item, REVENUE_AUDIT_FIELDS) };
}

module.exports = {
  COST_STATUSES,
  REVENUE_STATUSES,
  getSettings,
  resolveAccess,
  canReadTaskCosts,
  describeAccess,
  loadTotalsByProject,
  loadTotalsForList,
  getSummary,
  updateFinancePlan,
  setTaskPlannedCost,
  listCostItems,
  createCostItem,
  updateCostItem,
  deleteCostItem,
  listRevenueItems,
  createRevenueItem,
  updateRevenueItem,
  deleteRevenueItem,
};
