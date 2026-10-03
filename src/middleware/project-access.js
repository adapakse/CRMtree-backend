'use strict';
// middleware/project-access.js
//
// Loads the project named by :id for the calling user and exposes what the
// user may do in it. Shared by the project and project-task routers.

const projectService = require('../services/projectService');

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

module.exports = { loadProject, requireProjectManager, requireOpenProject };
