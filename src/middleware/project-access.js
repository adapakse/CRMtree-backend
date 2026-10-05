'use strict';
// middleware/project-access.js
//
// Loads the project named by :id for the calling user and exposes what the
// user may do in it. Shared by the project, project-task and project-finance
// routers.

const projectService = require('../services/projectService');
const projectConfigService = require('../services/projectConfigService');
const projectFinanceService = require('../services/projectFinanceService');

async function loadProject(req, res, next) {
  try {
    const access = await projectService.loadProjectForUser({
      tenantId: req.tenantId, user: req.user, projectId: req.params.id,
    });
    // Same answer for "does not exist" and "not a member" — project ids must not leak.
    if (!access) return res.status(404).json({ error: 'Nie znaleziono projektu' });
    req.project = access.project;
    req.projectMembership = access.membership;
    req.canManageProject = access.canManage;
    next();
  } catch (err) { next(err); }
}

function requireProjectManager(req, res, next) {
  if (req.canManageProject) return next();
  return res.status(403).json({ error: 'Wymagana rola PM w tym projekcie' });
}

function requireOpenProject(req, res, next) {
  if (req.project.status === 'open') return next();
  return res.status(409).json({ error: 'Projekt jest zamknięty' });
}

// Project finance is a tenant-level option; with it switched off every finance
// route answers the same way, whoever asks.
async function requireFinanceEnabled(req, res, next) {
  try {
    if (await projectConfigService.isFinanceEnabled(req.tenantId)) return next();
    return res.status(403).json({ error: 'Project finance is switched off' });
  } catch (err) { next(err); }
}

// Needs loadProject. Exposes what the caller may do with the project's finance.
async function loadFinanceAccess(req, res, next) {
  try {
    const settings = await projectFinanceService.getSettings(req.project.id);
    req.financeAccess = projectFinanceService.resolveAccess({
      membership: req.projectMembership, canManage: req.canManageProject, settings,
    });
    next();
  } catch (err) { next(err); }
}

const FINANCE_ACCESS_DENIED = 'No access to the finance of this project';

function requireFinanceRead(req, res, next) {
  if (req.financeAccess.canRead) return next();
  return res.status(403).json({ error: FINANCE_ACCESS_DENIED });
}

function requireFinanceWrite(req, res, next) {
  if (req.financeAccess.canWrite) return next();
  return res.status(403).json({ error: FINANCE_ACCESS_DENIED });
}

// Cost items are also open to a participant who may add costs to own tasks;
// the service narrows what such a caller sees and changes.
function requireCostAccess(req, res, next) {
  if (req.financeAccess.canRead || req.financeAccess.canAddOwnCosts) return next();
  return res.status(403).json({ error: FINANCE_ACCESS_DENIED });
}

function requireCostWriteAccess(req, res, next) {
  if (req.financeAccess.canWrite || req.financeAccess.canAddOwnCosts) return next();
  return res.status(403).json({ error: FINANCE_ACCESS_DENIED });
}

module.exports = {
  loadProject,
  requireProjectManager,
  requireOpenProject,
  requireFinanceEnabled,
  loadFinanceAccess,
  requireFinanceRead,
  requireFinanceWrite,
  requireCostAccess,
  requireCostWriteAccess,
};
