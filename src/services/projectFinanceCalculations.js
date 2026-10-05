'use strict';
// services/projectFinanceCalculations.js
//
// The arithmetic behind project finance figures, free of database access so
// the same rules serve the Finance tab, the project list and the CRM cards.
//
// Definitions:
//   * actual revenue = revenue items with status invoiced or paid;
//   * actual cost    = cost items with status incurred;
//   * planned cost   = sum of the category budgets (task planned costs are
//                      reported separately and never added to it);
//   * margin %       = margin / revenue, undefined (null) without revenue.

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function buildMargin(revenue, cost) {
  if (revenue === null) return { amount: null, percent: null };
  const amount = roundMoney(revenue - cost);
  return { amount, percent: revenue > 0 ? roundMoney((amount / revenue) * 100) : null };
}

// `figures`: { currency, revenue_planned (number|null), revenue_actual,
// cost_planned, cost_actual }.
function buildTotals(figures) {
  return {
    currency: figures.currency,
    revenue: { planned: figures.revenue_planned, actual: figures.revenue_actual },
    cost: { planned: figures.cost_planned, actual: figures.cost_actual },
    margin: {
      planned: buildMargin(figures.revenue_planned, figures.cost_planned),
      actual: buildMargin(figures.revenue_actual, figures.cost_actual),
    },
  };
}

// `categories`: [{ id, name, is_active, budget (number|null), incurred, planned }].
// A deactivated category is listed only while it still carries a budget or items.
function buildCategoryRows(categories) {
  return categories
    .filter((category) => category.is_active || category.budget !== null || category.incurred || category.planned)
    .map((category) => {
      const budget = category.budget ?? 0;
      return {
        category_id: category.id,
        name: category.name,
        is_active: category.is_active,
        budget,
        incurred: category.incurred,
        planned: category.planned,
        variance: roundMoney(budget - category.incurred),
        is_over_budget: category.incurred > budget,
      };
    });
}

// `tasks`: [{ id, task_number, name, parent_task_id, planned_cost (number|null),
// incurred, planned }] where incurred / planned are the task's own items.
// A parent's total is its own items plus those of all its descendants.
// Tasks without any figure are left out.
function buildTaskRows(tasks) {
  const childrenByParent = new Map();
  for (const task of tasks) {
    if (!task.parent_task_id) continue;
    if (!childrenByParent.has(task.parent_task_id)) childrenByParent.set(task.parent_task_id, []);
    childrenByParent.get(task.parent_task_id).push(task);
  }

  const totalsById = new Map();
  function totalsOf(task) {
    if (totalsById.has(task.id)) return totalsById.get(task.id);
    const totals = { incurred: task.incurred, planned: task.planned };
    // Registered before descending so a corrupt parent cycle cannot recurse forever.
    totalsById.set(task.id, totals);
    for (const child of childrenByParent.get(task.id) || []) {
      const childTotals = totalsOf(child);
      totals.incurred += childTotals.incurred;
      totals.planned += childTotals.planned;
    }
    return totals;
  }

  return tasks
    .map((task) => {
      const totals = totalsOf(task);
      return {
        task_id: task.id,
        task_number: task.task_number,
        name: task.name,
        parent_task_id: task.parent_task_id,
        planned_cost: task.planned_cost,
        own_incurred: roundMoney(task.incurred),
        own_planned: roundMoney(task.planned),
        total_incurred: roundMoney(totals.incurred),
        total_planned: roundMoney(totals.planned),
      };
    })
    .filter((row) => row.planned_cost !== null || row.total_incurred || row.total_planned);
}

module.exports = { roundMoney, buildMargin, buildTotals, buildCategoryRows, buildTaskRows };
