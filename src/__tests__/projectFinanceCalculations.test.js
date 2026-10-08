'use strict';

// Project finance arithmetic: margins, totals, the per-category table and the
// per-task roll-up over subtasks. No database involved.

const {
  roundMoney, buildMargin, buildTotals, buildCategoryRows, buildTaskRows,
} = require('../services/projectFinanceCalculations');

describe('roundMoney', () => {
  test('rounds half up to two decimals despite binary float noise', () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(1234.5649)).toBe(1234.56);
  });
});

describe('margin', () => {
  test('amount and percent of revenue', () => {
    expect(buildMargin(1000, 750)).toEqual({ amount: 250, percent: 25 });
    expect(buildMargin(300, 400)).toEqual({ amount: -100, percent: -33.33 });
  });

  test('percent is undefined without revenue; nothing is known without a plan', () => {
    expect(buildMargin(0, 120)).toEqual({ amount: -120, percent: null });
    expect(buildMargin(null, 120)).toEqual({ amount: null, percent: null });
  });
});

describe('totals', () => {
  test('plan and actuals side by side', () => {
    expect(buildTotals({
      currency: 'EUR', revenue_planned: 10000, revenue_actual: 4000, cost_planned: 6000, cost_actual: 3000,
    })).toEqual({
      currency: 'EUR',
      revenue: { planned: 10000, actual: 4000 },
      cost: { planned: 6000, actual: 3000 },
      margin: {
        planned: { amount: 4000, percent: 40 },
        actual: { amount: 1000, percent: 25 },
      },
    });
  });
});

describe('category table', () => {
  const category = (overrides) => ({
    id: 'c1', name: 'Materiały', is_active: true, budget: null, incurred: 0, planned: 0, ...overrides,
  });

  test('variance is budget minus incurred; planned items do not make a category over budget', () => {
    const [row] = buildCategoryRows([category({ budget: 1000, incurred: 400, planned: 900 })]);
    expect(row).toEqual({
      category_id: 'c1', name: 'Materiały', is_active: true,
      budget: 1000, incurred: 400, planned: 900, variance: 600, is_over_budget: false,
    });
  });

  test('a category without a budget is over budget as soon as it has an incurred cost', () => {
    const [row] = buildCategoryRows([category({ incurred: 50 })]);
    expect(row).toMatchObject({ budget: 0, variance: -50, is_over_budget: true });
  });

  test('an inactive category stays only while it carries a budget or items', () => {
    const rows = buildCategoryRows([
      category({ id: 'unused', is_active: false }),
      category({ id: 'budgeted', is_active: false, budget: 0 }),
      category({ id: 'used', is_active: false, planned: 10 }),
      category({ id: 'active' }),
    ]);
    expect(rows.map((row) => row.category_id)).toEqual(['budgeted', 'used', 'active']);
  });
});

describe('task roll-up', () => {
  const task = (id, parentId, incurred = 0, planned = 0, plannedCost = null) => ({
    id, task_number: Number(id.slice(1)), name: `Task ${id}`, parent_task_id: parentId,
    planned_cost: plannedCost, incurred, planned,
  });

  test('a parent totals its own items plus those of all descendants', () => {
    const rows = buildTaskRows([
      task('t1', null, 100, 0, 5000),
      task('t2', 't1', 200, 50),
      task('t3', 't2', 300, 25),
      task('t4', 't1', 0, 0),
      task('t5', null, 7, 0),
    ]);
    const byId = Object.fromEntries(rows.map((row) => [row.task_id, row]));

    expect(byId.t1).toMatchObject({
      planned_cost: 5000, own_incurred: 100, own_planned: 0, total_incurred: 600, total_planned: 75,
    });
    expect(byId.t2).toMatchObject({ own_incurred: 200, total_incurred: 500, total_planned: 75 });
    expect(byId.t3).toMatchObject({ own_incurred: 300, total_incurred: 300, total_planned: 25 });
    expect(byId.t5).toMatchObject({ total_incurred: 7 });
  });

  test('tasks without any figure are left out; a planned cost alone keeps a task in', () => {
    const rows = buildTaskRows([task('t1', null), task('t2', null, 0, 0, 0), task('t3', 't1')]);
    expect(rows.map((row) => row.task_id)).toEqual(['t2']);
  });

  test('the order of the input does not matter', () => {
    const rows = buildTaskRows([task('t3', 't2', 1), task('t2', 't1', 2), task('t1', null, 4)]);
    expect(rows.find((row) => row.task_id === 't1').total_incurred).toBe(7);
  });
});
