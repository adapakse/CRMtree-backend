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

// Initialise SAML passport strategy (side-effect)
require('./middleware/auth');

const app = express();

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
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With'],
}));

// ─── Rate limiter ─────────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs: config.rateLimit.windowMs,
  max:      config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => config.isDev,
}));

// ─── Request parsing ──────────────────────────────────────
// For Signus webhook: capture raw body before JSON parsing
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

// Document sub-resources (mergeParams in those routers)
app.use('/api/documents/:documentId/tags',     tagRoutes);
app.use('/api/documents/:documentId/workflow', workflowRoutes);

// Signing
app.use('/api',                 signingRoutes);

// Admin
app.use('/api/admin/users',     userRoutes);
app.use('/api/admin/logs',      logRoutes);
app.use('/api/admin/settings',  settingsRoutes);

// Shared
app.use('/api/groups',          groupRoutes);
app.use('/api/document-groups', documentGroupRoutes);
app.use('/api/documents/:documentId/attachments', attachmentRoutes);

// Workflow global endpoints (not under a document)
const { requireAuth } = require('./middleware/auth');

app.get('/api/workflow/my-tasks', requireAuth, injectAuditContext, async (req, res, next) => {
  try {
    const db = require('./config/database');
    const { rows } = await db.query(
      `SELECT wt.*,
              d.doc_number, d.name AS document_name, d.status AS document_status,
              assigner.display_name AS assigner_name,
              gp.name AS group_name, gp.display_name AS group_display
       FROM workflow_tasks wt
       JOIN documents d ON d.id = wt.document_id AND d.deleted_at IS NULL
       LEFT JOIN users assigner ON assigner.id = wt.assigned_by
       LEFT JOIN group_profiles gp ON gp.id = d.group_id
       WHERE wt.assigned_to = $1 AND wt.task_status IN ('pending','in_progress')
       ORDER BY wt.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

app.get('/api/workflow/all-tasks', requireAuth, injectAuditContext, async (req, res, next) => {
  try {
    const db = require('./config/database');
    const isAdmin = req.user.role === 'admin';

    let query, params;
    if (isAdmin) {
      query = `
        SELECT wt.*,
               d.doc_number, d.name AS document_name, d.status AS document_status,
               assignee.display_name AS assignee_name,
               assigner.display_name AS assigner_name,
               gp.name AS group_name, gp.display_name AS group_display
        FROM workflow_tasks wt
        JOIN documents d ON d.id = wt.document_id AND d.deleted_at IS NULL
        LEFT JOIN users assignee ON assignee.id = wt.assigned_to
        LEFT JOIN users assigner ON assigner.id = wt.assigned_by
        LEFT JOIN group_profiles gp ON gp.id = d.group_id
        ORDER BY wt.created_at DESC`;
      params = [];
    } else {
      query = `
        SELECT wt.*,
               d.doc_number, d.name AS document_name, d.status AS document_status,
               assignee.display_name AS assignee_name,
               assigner.display_name AS assigner_name,
               gp.name AS group_name, gp.display_name AS group_display
        FROM workflow_tasks wt
        JOIN documents d ON d.id = wt.document_id AND d.deleted_at IS NULL
        LEFT JOIN users assignee ON assignee.id = wt.assigned_to
        LEFT JOIN users assigner ON assigner.id = wt.assigned_by
        LEFT JOIN group_profiles gp ON gp.id = d.group_id
        WHERE d.group_id IN (
          SELECT group_id FROM user_group_roles WHERE user_id = $1
        )
        ORDER BY wt.created_at DESC`;
      params = [req.user.id];
    }

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
});

app.get('/api/workflow/kanban-docs', requireAuth, injectAuditContext, async (req, res, next) => {
  try {
    const db = require('./config/database');
    const isAdmin = req.user.role === 'admin';

    // Admins see all documents; regular users only see documents
    // belonging to groups they are members of.
    const groupFilter = isAdmin
      ? ''
      : `AND d.group_id IN (
           SELECT group_id FROM user_group_roles WHERE user_id = $1
         )`;
    const params = isAdmin ? [] : [req.user.id];

    const { rows } = await db.query(
      `SELECT d.id, d.doc_number, d.name, d.status, d.expiration_date,
              d.owner_id, u.display_name AS owner_name,
              gp.name AS group_name, gp.display_name AS group_display,
              (SELECT COUNT(*) FROM workflow_tasks wt
               WHERE wt.document_id = d.id
               AND wt.task_status IN ('pending','in_progress')) AS active_task_count,
              (SELECT json_agg(json_build_object(
                'id', wt.id, 'task_type', wt.task_type, 'task_status', wt.task_status,
                'assignee_name', au.display_name, 'due_date', wt.due_date
              )) FROM workflow_tasks wt
               LEFT JOIN users au ON au.id = wt.assigned_to
               WHERE wt.document_id = d.id
               AND wt.task_status IN ('pending','in_progress')) AS active_tasks
       FROM documents d
       LEFT JOIN users u ON u.id = d.owner_id
       LEFT JOIN group_profiles gp ON gp.id = d.group_id
       WHERE d.deleted_at IS NULL
       ${groupFilter}
       ORDER BY d.updated_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── 404 & error handler ──────────────────────────────────

// DEV ONLY - usuń przed produkcją
if (process.env.NODE_ENV === 'development') {
  app.post('/api/auth/dev-login', async (req, res) => {
    const { rows } = await require('./config/database').query(
      'SELECT * FROM users WHERE email = $1', [req.body.email]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const { signAccessToken } = require('./middleware/auth');
    res.json({ access_token: signAccessToken(rows[0]) });
  });
}

app.use(notFound);
app.use(errorHandler);

module.exports = app;
