'use strict';
// routes/project-portfolio.js — mounted at /api/projects/portfolio
//
// The cross-project view for whoever runs several projects. Scope rules live
// in projectPortfolioService: the tenant admin gets every open project, anyone
// else the open projects where they are PM or controller; a user with neither
// gets 403 (GET /api/projects/config tells the frontend beforehand).
//
// GET /tasks     — tasks across the projects in scope: paged, filtered, sorted
// GET /gantt     — the same filtered tasks for the timeline, unpaged up to a cap
// GET /projects  — the projects in scope: paged, filtered, sorted; dates, task
//                  counts, delay, PMs
// Query parameters: middleware/project-list-query.

const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { requireFeature } = require('../middleware/crm-rbac');
const { validate } = require('../middleware/errorHandler');
const {
  taskFilterRules, taskListRules, readTaskFilters, projectListRules, readProjectFilters, readPagingAndSort,
} = require('../middleware/project-list-query');
const projectConfigService = require('../services/projectConfigService');
const projectFinanceService = require('../services/projectFinanceService');
const projectPortfolioService = require('../services/projectPortfolioService');
const projectService = require('../services/projectService');
const projectTaskListService = require('../services/projectTaskListService');

async function loadScope(req, res, next) {
  try {
    const scopeProjectIds = await projectPortfolioService.listScopeProjectIds({
      tenantId: req.tenantId, user: req.user,
    });
    if (!req.user.is_admin && !scopeProjectIds.length) {
      return res.status(403).json({ error: 'The cross-project view is for the tenant admin, PMs and controllers' });
    }
    req.scopeProjectIds = scopeProjectIds;
    req.isFinanceEnabled = await projectConfigService.isFinanceEnabled(req.tenantId);
    next();
  } catch (err) { next(err); }
}

router.use(requireAuth, requireFeature('projects'), loadScope);

const filteredTasksOf = (req) => ({
  scope: projectTaskListService.portfolioScope({
    scopeProjectIds: req.scopeProjectIds, isFinanceEnabled: req.isFinanceEnabled,
  }),
  filters: readTaskFilters(req),
});

router.get('/tasks', taskListRules, validate, async (req, res, next) => {
  try {
    res.json(await projectTaskListService.searchTasks({ ...filteredTasksOf(req), ...readPagingAndSort(req) }));
  } catch (err) { next(err); }
});

router.get('/gantt', taskFilterRules, validate, async (req, res, next) => {
  try {
    res.json(await projectTaskListService.listForGantt(filteredTasksOf(req)));
  } catch (err) { next(err); }
});

router.get('/projects', projectListRules, validate, async (req, res, next) => {
  try {
    const page = await projectService.searchProjects({
      tenantId: req.tenantId,
      user: req.user,
      scopeProjectIds: req.scopeProjectIds,
      isFinanceEnabled: req.isFinanceEnabled,
      // The scope holds open projects only, whatever status is asked for.
      filters: { ...readProjectFilters(req), status: 'open' },
      ...readPagingAndSort(req),
    });
    const financeByProject = await projectFinanceService.loadTotalsForList({
      tenantId: req.tenantId, user: req.user, projects: page.items,
    });
    res.json({
      ...page,
      items: page.items.map((project) => ({ ...project, finance: financeByProject.get(project.id) ?? null })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
