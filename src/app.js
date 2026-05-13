'use strict';

const express       = require('express');
const cors          = require('cors');
const helmet        = require('helmet');
const compression   = require('compression');
const morgan        = require('morgan');
const rateLimit     = require('express-rate-limit');
const passport      = require('passport');
const config        = require('./config');
const logger        = require('./utils/logger');
const { errorHandler, notFound, injectAuditContext } = require('./middleware/errorHandler');

// Routes
const authRoutes          = require('./routes/auth');
const documentRoutes      = require('./routes/documents');
const tagRoutes           = require('./routes/tags');
const workflowRoutes      = require('./routes/workflow');
const signingRoutes       = require('./routes/signing');
const userRoutes          = require('./routes/users');
const groupRoutes         = require('./routes/groups');
const documentGroupRoutes = require('./routes/documentGroups');
const logRoutes           = require('./routes/logs');
const attachmentRoutes    = require('./routes/attachments');
const settingsRoutes      = require('./routes/settings');
const adminDataRoutes 	  = require('./routes/admin-data');
const adminTenantsRoutes  = require('./routes/admin-tenants');
const profileRoutes       = require('./routes/profile');
const crmGmail 		  = require('./routes/crm-gmail');

// ── CRM Routes ────────────────────────────────────────────── ★ DODANE
const crmLeadsRoutes        = require('./routes/crm-leads');
const crmPartnersRoutes     = require('./routes/crm-partners');
const crmGroupsRoutes       = require('./routes/crm-groups');
const crmDashboardRoutes    = require('./routes/crm-dashboard');
const crmTransactionsRoutes = require('./routes/crm-transactions');
const crmImportRoutes       = require('./routes/crm-import');
const crmSalesDataRoutes    = require('./routes/crm-sales-data');
const crmBudgetsRoutes      = require('./routes/crm-budgets');

require('./middleware/auth');

const app = express();

// ─── Trust proxy ──────────────────────────────────────────
// App stoi za reverse proxy (Azure App Service / App Gateway / nginx).
// Bez tego req.ip zwraca IP proxy, przez co rate limiter widzi wszystkich
// userow jako jednego klienta i blokuje cala aplikacje po dobiciu limitu.
// '1' = ufamy jednemu hopowi proxy. Zwiekszyc, jesli warstw proxy jest wiecej.
app.set('trust proxy', 2);

// ─── Security headers ─────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:', 'blob:'],
      connectSrc:  ["'self'"],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
}));

// ─── CORS ──────────────────────────────────────────────────
app.use(cors({
  origin:      [config.frontendUrl, config.appUrl].filter(Boolean),
  credentials: true,
  methods:     ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  // ★ dodano X-CRM-API-Key do allowedHeaders
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With','X-CRM-API-Key'],
}));

// ─── Rate limiter ─────────────────────────────────────────
// Uwaga: req.path jest wzgledem mountpointa ('/api/'), wiec '/auth/saml'
// zamiast '/api/auth/saml'. Webhook signing tez wylaczamy, bo zewnetrzne
// serwisy potrafia retry'owac w seriach i niepotrzebnie zjadaja limit.
app.use('/api/', rateLimit({
  windowMs: config.rateLimit.windowMs,
  max:      config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => (
    config.isDev ||
    req.path.startsWith('/auth/') ||
    req.path === '/signing/webhook'
  ),
}));

// ─── Request parsing ──────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/api/signing/webhook') {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      req.rawBody = data;
      try { req.body = JSON.parse(data); } catch { req.body = {}; }
      next();
    });
  } else {
    next();
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());

// ─── HTTP logging ─────────────────────────────────────────
app.use(morgan(
  config.isDev ? 'dev' : ':method :url :status :res[content-length] - :response-time ms',
  { stream: { write: msg => logger.info(msg.trim()) } }
));

// ─── Passport ─────────────────────────────────────────────
app.use(passport.initialize());

// ─── Health check (unauthenticated) ───────────────────────
app.get('/health', async (req, res) => {
  try {
    const db = require('./config/database');
    const pg = await db.healthCheck();
    res.json({ status: 'ok', pg: pg.pg_version.split(' ')[0], time: pg.now });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// ─── API Routes ───────────────────────────────────────────
app.use('/api/auth',            authRoutes);
app.use('/api/documents',       documentRoutes);

app.use('/api/documents/:documentId/tags',     tagRoutes);
app.use('/api/documents/:documentId/workflow', workflowRoutes);

app.use('/api',                 signingRoutes);

app.use('/api/admin/users',     userRoutes);
app.use('/api/admin/logs',      logRoutes);
app.use('/api/admin/settings',  settingsRoutes);
app.use('/api/admin/data',     adminDataRoutes);
app.use('/api/admin/tenants', adminTenantsRoutes);
app.use('/api/profile',         profileRoutes);
app.use('/api/crm/gmail', crmGmail);

app.use('/api/groups',          groupRoutes);
app.use('/api/document-groups', documentGroupRoutes);
app.use('/api/documents/:documentId/attachments', attachmentRoutes);

// ── CRM API Routes ────────────────────────────────────────── ★ DODANE
app.use('/api/crm/leads',        crmLeadsRoutes);
app.use('/api/crm/partners',     crmPartnersRoutes);
app.use('/api/crm/groups',       crmGroupsRoutes);
app.use('/api/crm/dashboard',    crmDashboardRoutes);
app.use('/api/crm/transactions', crmTransactionsRoutes);
app.use('/api/crm/import',       crmImportRoutes);
app.use('/api/crm/sales-data',   crmSalesDataRoutes);
app.use('/api/crm/budgets',      crmBudgetsRoutes);

// ─── Workflow global endpoints ─────────────────────────────
const { requireAuth } = require('./middleware/auth');

// ── GET /api/workflow/my-tasks ────────────────────────────
app.get('/api/workflow/my-tasks', requireAuth, injectAuditContext, async (req, res, next) => {
  try {
    const db = require('./config/database');
    const { rows } = await db.query(
      `SELECT wt.*,
              d.doc_number, d.name AS document_name, d.status AS document_status,
              assigner.display_name AS assigner_name,
              gp.name AS group_name, gp.display_name AS group_display
       FROM workflow_tasks wt
       JOIN documents d ON d.id = wt.document_id AND d.deleted_at IS NULL AND d.tenant_id = $2
       LEFT JOIN users assigner ON assigner.id = wt.assigned_by
       LEFT JOIN group_profiles gp ON gp.id = d.group_id
       WHERE wt.assigned_to = $1 AND wt.task_status IN ('pending','in_progress')
         AND wt.tenant_id = $2
       ORDER BY wt.created_at DESC`,
      [req.user.id, req.tenantId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/workflow/all-tasks ───────────────────────────
app.get('/api/workflow/all-tasks', requireAuth, injectAuditContext, async (req, res, next) => {
  try {
    const db = require('./config/database');
    const isAdmin = req.user.is_admin;

    let query, params;
    if (isAdmin) {
      query = `
        SELECT wt.*,
               d.doc_number, d.name AS document_name, d.status AS document_status,
               assignee.display_name AS assignee_name,
               assigner.display_name AS assigner_name,
               gp.name AS group_name, gp.display_name AS group_display
        FROM workflow_tasks wt
        JOIN documents d ON d.id = wt.document_id AND d.deleted_at IS NULL AND d.tenant_id = $1
        LEFT JOIN users assignee ON assignee.id = wt.assigned_to
        LEFT JOIN users assigner ON assigner.id = wt.assigned_by
        LEFT JOIN group_profiles gp ON gp.id = d.group_id
        WHERE wt.tenant_id = $1
        ORDER BY wt.created_at DESC`;
      params = [req.tenantId];
    } else {
      query = `
        SELECT wt.*,
               d.doc_number, d.name AS document_name, d.status AS document_status,
               assignee.display_name AS assignee_name,
               assigner.display_name AS assigner_name,
               gp.name AS group_name, gp.display_name AS group_display
        FROM workflow_tasks wt
        JOIN documents d ON d.id = wt.document_id AND d.deleted_at IS NULL AND d.tenant_id = $2
        LEFT JOIN users assignee ON assignee.id = wt.assigned_to
        LEFT JOIN users assigner ON assigner.id = wt.assigned_by
        LEFT JOIN group_profiles gp ON gp.id = d.group_id
        WHERE wt.tenant_id = $2
          AND d.group_id IN (
            SELECT group_id FROM user_group_roles WHERE user_id = $1 AND tenant_id = $2
          )
        ORDER BY wt.created_at DESC`;
      params = [req.user.id, req.tenantId];
    }

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/workflow/kanban-docs ─────────────────────────
app.get('/api/workflow/kanban-docs', requireAuth, injectAuditContext, async (req, res, next) => {
  try {
    const db = require('./config/database');
    const isAdmin = req.user.is_admin;

    // Always pass [userId, tenantId] so $1=userId and $2=tenantId are stable.
    // For admins groupFilter is empty, so $1 goes unused but params stay consistent.
    const params = [req.user.id, req.tenantId];

    const groupFilter = isAdmin
      ? ''
      : `AND (
           d.group_id IN (
             SELECT group_id FROM user_group_roles WHERE user_id = $1 AND tenant_id = $2
           )
           OR d.id IN (
             SELECT document_id FROM workflow_tasks
             WHERE assigned_to = $1
               AND tenant_id = $2
               AND task_status IN ('pending','in_progress')
           )
         )`;

    const { rows } = await db.query(
      `SELECT d.id, d.doc_number, d.name, d.status, d.expiration_date,
              d.owner_id, u.display_name AS owner_name,
              gp.name AS group_name, gp.display_name AS group_display,
              (SELECT COUNT(*)
               FROM workflow_tasks wt
               WHERE wt.document_id = d.id
                 AND wt.tenant_id = $2
                 AND wt.task_status IN ('pending','in_progress')) AS active_task_count,
              (SELECT json_agg(json_build_object(
                'id',          wt.id,
                'task_type',   wt.task_type,
                'task_status', wt.task_status,
                'assigned_to', wt.assigned_to,
                'assignee_name', au.display_name,
                'assigner_name', ab.display_name,
                'due_date',    wt.due_date,
                'message',     wt.message
              ) ORDER BY wt.created_at)
               FROM workflow_tasks wt
               LEFT JOIN users au ON au.id = wt.assigned_to
               LEFT JOIN users ab ON ab.id = wt.assigned_by
               WHERE wt.document_id = d.id
                 AND wt.tenant_id = $2
                 AND wt.task_status IN ('pending','in_progress')) AS active_tasks
       FROM documents d
       LEFT JOIN users u ON u.id = d.owner_id
       LEFT JOIN group_profiles gp ON gp.id = d.group_id
       WHERE d.deleted_at IS NULL AND d.tenant_id = $2
       ${groupFilter}
       ORDER BY d.updated_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── 404 & error handler ──────────────────────────
// dev-login is registered in routes/auth.js (active only when NODE_ENV=development)

app.use(notFound);
app.use(errorHandler);

// ─── Gmail watch auto-renewal (co 6 dni) ──────────────────────────────────────
// Gmail watch wygasa po 7 dniach — odnawiamy co 6 dni aby nie stracić push-notyfikacji.
// Uruchamiamy przy starcie serwera, a potem co 6 * 24h.
if (config.google.pubsubTopic) {
  const gmailService = require('./services/gmailService');
  const { pool: dbPool } = require('./config/database');
  const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

  const scheduleWatchRenewal = () => {
    gmailService.renewAllWatches(dbPool).catch(() => {});
    setTimeout(scheduleWatchRenewal, SIX_DAYS_MS);
  };
  // Pierwsze odnowienie po 60s od startu (serwer musi być gotowy)
  setTimeout(scheduleWatchRenewal, 60 * 1000);
  logger.info('[Gmail] Watch renewal scheduled every 6 days');
}

module.exports = app;