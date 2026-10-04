'use strict';
// services/projectConfigService.js
//
// Tenant-level configuration of the Projects module, edited by the tenant
// admin: task dictionaries (statuses, types, priorities), the status
// transition matrix per project role, and custom field definitions.
//
// Dictionary rows are deactivated, never deleted — tasks keep referencing
// them, so an old task still shows the status it was left in.

const db = require('../config/database');

const DICTIONARY_TABLES = {
  statuses:   'project_task_statuses',
  types:      'project_task_types',
  priorities: 'project_task_priorities',
};

const STATUS_CATEGORIES = ['todo', 'in_progress', 'done'];
// The PM is absent on purpose: a PM may always move a task between any statuses.
const TRANSITION_ROLES  = ['internal_participant', 'external_participant', 'controller'];
const FIELD_TYPES       = ['text', 'number', 'list', 'date', 'money'];

const MAX_LIST_OPTIONS       = 100;
const MAX_LIST_OPTION_LENGTH = 120;

const DEFAULT_STATUSES = [
  { name: 'Do zrobienia',   category: 'todo',        color: '#6B7280' },
  { name: 'W toku',         category: 'in_progress', color: '#3B82F6' },
  { name: 'Do weryfikacji', category: 'in_progress', color: '#F59E0B' },
  { name: 'Zakończone',     category: 'done',        color: '#3BAA5D' },
];
const DEFAULT_TYPES = [
  { name: 'Zadanie',        color: '#3B82F6' },
  { name: 'Spotkanie',      color: '#8B5CF6' },
  { name: 'Kamień milowy',  color: '#F59E0B' },
];
const DEFAULT_PRIORITIES = [
  { name: 'Niski',     color: '#6B7280' },
  { name: 'Średni',    color: '#3B82F6' },
  { name: 'Wysoki',    color: '#F59E0B' },
  { name: 'Krytyczny', color: '#DC2626' },
];
// [role, from status name, to status name]
const DEFAULT_TRANSITIONS = [
  ['internal_participant', 'Do zrobienia',   'W toku'],
  ['internal_participant', 'W toku',         'Do zrobienia'],
  ['internal_participant', 'W toku',         'Do weryfikacji'],
  ['external_participant', 'Do zrobienia',   'W toku'],
  ['external_participant', 'W toku',         'Do zrobienia'],
  ['external_participant', 'W toku',         'Do weryfikacji'],
  ['controller',           'Do weryfikacji', 'Zakończone'],
  ['controller',           'Do weryfikacji', 'W toku'],
];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function dictionaryTable(dictionary) {
  const table = DICTIONARY_TABLES[dictionary];
  if (!table) throw httpError(404, 'Nieznany słownik');
  return table;
}

function rethrowDuplicateName(err) {
  if (err.code === '23505') throw httpError(409, 'Pozycja o tej nazwie już istnieje');
  throw err;
}

async function seedDefaults(tenantId) {
  await db.transaction(async (client) => {
    // Serialises concurrent first reads of the same tenant's configuration.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`project_config:${tenantId}`]);
    const { rows: existing } = await client.query(
      'SELECT 1 FROM project_task_statuses WHERE tenant_id = $1 LIMIT 1', [tenantId],
    );
    if (existing.length) return;

    const statusIdByName = {};
    for (const [index, status] of DEFAULT_STATUSES.entries()) {
      const { rows: [row] } = await client.query(
        `INSERT INTO project_task_statuses (tenant_id, name, category, color, sort_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tenantId, status.name, status.category, status.color, index],
      );
      statusIdByName[status.name] = row.id;
    }
    for (const [index, type] of DEFAULT_TYPES.entries()) {
      await client.query(
        `INSERT INTO project_task_types (tenant_id, name, color, sort_order)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [tenantId, type.name, type.color, index],
      );
    }
    for (const [index, priority] of DEFAULT_PRIORITIES.entries()) {
      await client.query(
        `INSERT INTO project_task_priorities (tenant_id, name, color, sort_order)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [tenantId, priority.name, priority.color, index],
      );
    }
    for (const [role, from, to] of DEFAULT_TRANSITIONS) {
      await client.query(
        `INSERT INTO project_status_transitions (tenant_id, role, from_status_id, to_status_id)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, role, statusIdByName[from], statusIdByName[to]],
      );
    }
  });
}

async function ensureDefaults(tenantId) {
  const { rows: anyStatus } = await db.query(
    'SELECT 1 FROM project_task_statuses WHERE tenant_id = $1 LIMIT 1', [tenantId],
  );
  if (!anyStatus.length) await seedDefaults(tenantId);
}

async function getConfig(tenantId) {
  await ensureDefaults(tenantId);

  const [statuses, types, priorities, transitions, fieldDefinitions] = await Promise.all([
    db.query(
      `SELECT id, name, category, color, sort_order, is_active
       FROM project_task_statuses WHERE tenant_id = $1 ORDER BY sort_order, name`, [tenantId]),
    db.query(
      `SELECT id, name, color, sort_order, is_active
       FROM project_task_types WHERE tenant_id = $1 ORDER BY sort_order, name`, [tenantId]),
    db.query(
      `SELECT id, name, color, sort_order, is_active
       FROM project_task_priorities WHERE tenant_id = $1 ORDER BY sort_order, name`, [tenantId]),
    db.query(
      `SELECT role, from_status_id, to_status_id
       FROM project_status_transitions WHERE tenant_id = $1`, [tenantId]),
    db.query(
      `SELECT id, name, field_type, options, sort_order, is_active
       FROM project_field_definitions WHERE tenant_id = $1 ORDER BY sort_order, name`, [tenantId]),
  ]);

  return {
    statuses:          statuses.rows,
    types:             types.rows,
    priorities:        priorities.rows,
    transitions:       transitions.rows,
    field_definitions: fieldDefinitions.rows,
  };
}

async function createDictionaryItem(tenantId, dictionary, { name, color, category }) {
  const table = dictionaryTable(dictionary);
  const isStatus = dictionary === 'statuses';
  if (isStatus && !STATUS_CATEGORIES.includes(category)) {
    throw httpError(400, 'Status wymaga kategorii: todo, in_progress lub done');
  }
  const columns = ['tenant_id', 'name', 'color', 'sort_order'];
  const params  = [tenantId, name, color || '#6B7280'];
  if (isStatus) { columns.push('category'); params.push(category); }
  const categoryPlaceholder = isStatus ? ', $4' : '';
  try {
    const { rows: [row] } = await db.query(
      `INSERT INTO ${table} (${columns.join(', ')})
       VALUES ($1, $2, $3,
               (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM ${table} WHERE tenant_id = $1)
               ${categoryPlaceholder})
       RETURNING *`,
      params,
    );
    return row;
  } catch (err) { return rethrowDuplicateName(err); }
}

async function updateDictionaryItem(tenantId, dictionary, id, changes) {
  const table = dictionaryTable(dictionary);
  const editable = ['name', 'color', 'is_active'];
  if (dictionary === 'statuses') editable.push('category');

  const setClauses = [];
  const params = [];
  for (const field of editable) {
    if (changes[field] === undefined) continue;
    params.push(changes[field]);
    setClauses.push(`${field} = $${params.length}`);
  }
  if (!setClauses.length) throw httpError(400, 'Brak pól do zmiany');

  if (dictionary === 'statuses' && changes.is_active === false) {
    const { rows } = await db.query(
      `SELECT 1 FROM project_task_statuses
       WHERE tenant_id = $1 AND is_active AND id <> $2 LIMIT 1`,
      [tenantId, id],
    );
    if (!rows.length) throw httpError(409, 'Musi pozostać co najmniej jeden aktywny status');
  }

  params.push(id, tenantId);
  try {
    const { rows: [row] } = await db.query(
      `UPDATE ${table} SET ${setClauses.join(', ')}, updated_at = now()
       WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
       RETURNING *`,
      params,
    );
    if (!row) throw httpError(404, 'Nie znaleziono pozycji słownika');
    return row;
  } catch (err) { return rethrowDuplicateName(err); }
}

async function reorderDictionary(tenantId, dictionary, orderedIds) {
  const table = dictionaryTable(dictionary);
  await db.query(
    `UPDATE ${table} AS item
     SET sort_order = ordered.position - 1, updated_at = now()
     FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, position)
     WHERE item.id = ordered.id AND item.tenant_id = $1`,
    [tenantId, orderedIds],
  );
}

async function replaceRoleTransitions(tenantId, role, transitions) {
  if (!TRANSITION_ROLES.includes(role)) throw httpError(400, 'Nieznana rola projektowa');

  const statusIds = [...new Set(transitions.flatMap((t) => [t.from_status_id, t.to_status_id]))];
  const { rows: known } = await db.query(
    'SELECT id FROM project_task_statuses WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
    [tenantId, statusIds],
  );
  if (known.length !== statusIds.length) throw httpError(400, 'Nieznany status w macierzy przejść');
  if (transitions.some((t) => t.from_status_id === t.to_status_id)) {
    throw httpError(400, 'Przejście musi prowadzić do innego statusu');
  }

  await db.transaction(async (client) => {
    await client.query(
      'DELETE FROM project_status_transitions WHERE tenant_id = $1 AND role = $2', [tenantId, role],
    );
    for (const transition of transitions) {
      await client.query(
        `INSERT INTO project_status_transitions (tenant_id, role, from_status_id, to_status_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [tenantId, role, transition.from_status_id, transition.to_status_id],
      );
    }
  });
}

function sanitizeListOptions(fieldType, options) {
  if (fieldType !== 'list') return [];
  if (!Array.isArray(options)) throw httpError(400, 'Pole typu lista wymaga tablicy wartości');
  const clean = [...new Set(options.map((option) => String(option).trim()).filter(Boolean))];
  if (!clean.length) throw httpError(400, 'Pole typu lista wymaga co najmniej jednej wartości');
  if (clean.length > MAX_LIST_OPTIONS) throw httpError(400, 'Zbyt wiele wartości listy');
  if (clean.some((option) => option.length > MAX_LIST_OPTION_LENGTH)) {
    throw httpError(400, 'Wartość listy jest zbyt długa');
  }
  return clean;
}

async function createFieldDefinition(tenantId, { name, field_type: fieldType, options }) {
  if (!FIELD_TYPES.includes(fieldType)) throw httpError(400, 'Nieznany typ pola');
  const cleanOptions = sanitizeListOptions(fieldType, options);
  try {
    const { rows: [row] } = await db.query(
      `INSERT INTO project_field_definitions (tenant_id, name, field_type, options, sort_order)
       VALUES ($1, $2, $3, $4::jsonb,
               (SELECT COALESCE(MAX(sort_order), -1) + 1
                FROM project_field_definitions WHERE tenant_id = $1))
       RETURNING id, name, field_type, options, sort_order, is_active`,
      [tenantId, name, fieldType, JSON.stringify(cleanOptions)],
    );
    return row;
  } catch (err) { return rethrowDuplicateName(err); }
}

// field_type is immutable: values already stored on tasks were validated against it.
async function updateFieldDefinition(tenantId, id, { name, options, is_active: isActive }) {
  const { rows: [current] } = await db.query(
    'SELECT field_type FROM project_field_definitions WHERE id = $1 AND tenant_id = $2',
    [id, tenantId],
  );
  if (!current) throw httpError(404, 'Nie znaleziono pola');

  const setClauses = [];
  const params = [];
  if (name !== undefined)     { params.push(name);     setClauses.push(`name = $${params.length}`); }
  if (isActive !== undefined) { params.push(isActive); setClauses.push(`is_active = $${params.length}`); }
  if (options !== undefined) {
    params.push(JSON.stringify(sanitizeListOptions(current.field_type, options)));
    setClauses.push(`options = $${params.length}::jsonb`);
  }
  if (!setClauses.length) throw httpError(400, 'Brak pól do zmiany');

  params.push(id, tenantId);
  try {
    const { rows: [row] } = await db.query(
      `UPDATE project_field_definitions SET ${setClauses.join(', ')}, updated_at = now()
       WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
       RETURNING id, name, field_type, options, sort_order, is_active`,
      params,
    );
    return row;
  } catch (err) { return rethrowDuplicateName(err); }
}

module.exports = {
  STATUS_CATEGORIES,
  TRANSITION_ROLES,
  FIELD_TYPES,
  ensureDefaults,
  getConfig,
  createDictionaryItem,
  updateDictionaryItem,
  reorderDictionary,
  replaceRoleTransitions,
  createFieldDefinition,
  updateFieldDefinition,
};
