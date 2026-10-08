'use strict';
// middleware/project-list-query.js
//
// Query parameters shared by the lists of the Projects module, so every list
// is paged, sorted and filtered the same way:
//   paging  — page (≥ 1, default 1), page_size (1–50, default 50);
//   sorting — sort (a key of the list) + order (asc | desc, default asc);
//   filters — one set for task lists, one for project lists (their meaning:
//             services/projectTaskFilters.js, projectService.searchProjects).
// A malformed value is a 400; an empty value is an unused filter. Booleans
// arrive as the strings "true" / "false".

const { query } = require('express-validator');
const { STATUS_CATEGORIES } = require('../services/projectConfigService');
const { TIMELINESS_VALUES } = require('../services/projectDeadlineService');
const { UNASSIGNED } = require('../services/projectTaskFilters');
const { MAX_PAGE_SIZE, SORT_KEYS: TASK_SORT_KEYS } = require('../services/projectTaskListService');
const { PROJECT_SORT_KEYS, MY_ROLE_FILTERS, DELAY_REASONS } = require('../services/projectService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(value);

const splitList = (value) => (value ? value.split(',').map((item) => item.trim()) : []);
const optional = (name) => query(name).optional({ values: 'falsy' });
const commaList = (name, isValidItem) => optional(name).isString()
  .custom((value) => splitList(value).every(isValidItem));
const text = (name, maxLength) => optional(name).isString().trim().isLength({ max: maxLength });
const dateOnly = (name) => optional(name).isISO8601({ strict: true }).isLength({ min: 10, max: 10 });
const amount = (name) => optional(name).isFloat({ min: 0 }).toFloat();
const count = (name) => optional(name).isInt({ min: 0 }).toInt();
const percent = (name) => optional(name).isInt({ min: 0, max: 100 }).toInt();
// Sanitised values are numbers; anything else was left out or empty.
const numberOf = (value) => (typeof value === 'number' ? value : undefined);

const pagingRules = [
  optional('page').isInt({ min: 1 }).toInt(),
  optional('page_size').isInt({ min: 1, max: MAX_PAGE_SIZE }).toInt(),
];
const sortRules = (sortKeys) => [
  optional('sort').isIn(sortKeys),
  optional('order').isIn(['asc', 'desc']),
];

// To be called after `validate`, like the other read* functions below.
function readPagingAndSort(req) {
  return {
    page: numberOf(req.query.page) ?? 1,
    pageSize: numberOf(req.query.page_size) ?? MAX_PAGE_SIZE,
    sort: req.query.sort || undefined,
    order: req.query.order || 'asc',
  };
}

const taskFilterRules = [
  text('name', 300),
  text('number', 30),
  commaList('project_ids', isUuid),
  commaList('status_ids', isUuid),
  commaList('status_category', (value) => STATUS_CATEGORIES.includes(value)),
  commaList('priority_ids', isUuid),
  commaList('type_ids', isUuid),
  optional('assignee').custom((value) => value === UNASSIGNED || isUuid(value)),
  dateOnly('start_from'), dateOnly('start_to'),
  dateOnly('end_from'), dateOnly('end_to'),
  dateOnly('original_end_from'), dateOnly('original_end_to'),
  optional('slip_min').isInt().toInt(), optional('slip_max').isInt().toInt(),
  amount('cost_min'), amount('cost_max'),
  commaList('timeliness', (value) => TIMELINESS_VALUES.includes(value)),
];
const taskListRules = [...taskFilterRules, ...pagingRules, ...sortRules(TASK_SORT_KEYS)];

function readTaskFilters(req) {
  const { query: params } = req;
  return {
    name: params.name || undefined,
    number: params.number || undefined,
    projectIds: splitList(params.project_ids),
    statusIds: splitList(params.status_ids),
    statusCategories: splitList(params.status_category),
    priorityIds: splitList(params.priority_ids),
    typeIds: splitList(params.type_ids),
    assignee: params.assignee || undefined,
    startFrom: params.start_from || undefined,
    startTo: params.start_to || undefined,
    endFrom: params.end_from || undefined,
    endTo: params.end_to || undefined,
    originalEndFrom: params.original_end_from || undefined,
    originalEndTo: params.original_end_to || undefined,
    slipMin: numberOf(params.slip_min),
    slipMax: numberOf(params.slip_max),
    costMin: numberOf(params.cost_min),
    costMax: numberOf(params.cost_max),
    timeliness: splitList(params.timeliness),
  };
}

const projectListRules = [
  optional('status').isIn(['open', 'closed', 'all']),
  text('name', 200),
  dateOnly('start_from'), dateOnly('start_to'),
  dateOnly('end_from'), dateOnly('end_to'),
  optional('delayed').isBoolean().toBoolean(),
  optional('lead_id').isInt({ min: 1 }).toInt(),
  optional('partner_id').custom(isUuid),
  commaList('my_role', (value) => Object.hasOwn(MY_ROLE_FILTERS, value)),
  optional('pm').custom(isUuid),
  commaList('delay_reason', (value) => DELAY_REASONS.includes(value)),
  count('overdue_min'), count('overdue_max'),
  count('at_risk_min'), count('at_risk_max'),
  percent('progress_min'), percent('progress_max'),
  amount('cost_min'), amount('cost_max'),
  amount('revenue_min'), amount('revenue_max'),
  ...pagingRules,
  ...sortRules(PROJECT_SORT_KEYS),
];

function readProjectFilters(req) {
  const { query: params } = req;
  return {
    status: params.status || undefined,
    name: params.name || undefined,
    startFrom: params.start_from || undefined,
    startTo: params.start_to || undefined,
    endFrom: params.end_from || undefined,
    endTo: params.end_to || undefined,
    isDelayed: typeof params.delayed === 'boolean' ? params.delayed : undefined,
    leadId: numberOf(params.lead_id),
    partnerId: params.partner_id || undefined,
    myRoles: splitList(params.my_role),
    managerId: params.pm || undefined,
    delayReasons: splitList(params.delay_reason),
    overdueMin: numberOf(params.overdue_min),
    overdueMax: numberOf(params.overdue_max),
    atRiskMin: numberOf(params.at_risk_min),
    atRiskMax: numberOf(params.at_risk_max),
    progressMin: numberOf(params.progress_min),
    progressMax: numberOf(params.progress_max),
    costMin: numberOf(params.cost_min),
    costMax: numberOf(params.cost_max),
    revenueMin: numberOf(params.revenue_min),
    revenueMax: numberOf(params.revenue_max),
  };
}

module.exports = {
  taskFilterRules,
  taskListRules,
  readTaskFilters,
  projectListRules,
  readProjectFilters,
  readPagingAndSort,
};
