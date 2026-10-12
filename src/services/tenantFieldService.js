'use strict';
// ─────────────────────────────────────────────────────────────────
// services/tenantFieldService.js — pola dodatkowe definiowane przez admina
// tenanta na formatkach leada, partnera i dokumentu (migracja 0328).
//
// Odwzorowanie mechanizmu z modułu Projekty (projectConfigService: definicje +
// project_tasks.custom_values). Te same typy pól, ta sama zasada „nie usuwamy,
// tylko dezaktywujemy", wartości w JSONB kluczowane po id definicji.
//
// TYP POLA JEST NIEZMIENNY po utworzeniu — wartości zapisane na rekordach były
// walidowane pod ten typ, a zmiana na przykład z „money" na „number" zostawiłaby
// w bazie obiekty {amount, currency} tam, gdzie kod spodziewa się liczby.
// Admin zmienia nazwę, opcje listy i aktywność; żeby zmienić typ, dezaktywuje
// pole i zakłada nowe. Dokładnie tak samo działa to w Projektach.
//
// DEZAKTYWACJA NIE KASUJE WARTOŚCI. Nieaktywne pole znika z formatki, ale to, co
// klient już wpisał, zostaje w custom_values. Gdyby ktoś przywrócił pole,
// wartości wracają. Czyszczenie przy dezaktywacji byłoby cichą utratą danych.
// ─────────────────────────────────────────────────────────────────

const db = require('../config/database');

const ENTITIES = ['lead', 'partner', 'document'];
const FIELD_TYPES = ['text', 'number', 'list', 'date', 'money'];

const MAX_LIST_OPTIONS = 50;
const MAX_LIST_OPTION_LENGTH = 120;
const MAX_TEXT_LENGTH = 2000;
const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Kolumna z wartościami jest na rekordzie formatki — tabela zależy od encji. */
const VALUE_TABLES = Object.freeze({
  lead: 'crm_leads',
  partner: 'crm_partners',
  document: 'documents',
});

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function assertEntity(entity) {
  if (!ENTITIES.includes(entity)) throw httpError(400, `Nieznana formatka: ${entity}`);
}

function rethrowDuplicateName(err) {
  // 23505 na UNIQUE (tenant_id, entity, name) — dwa pola o tej samej nazwie na
  // jednej formatce byłyby nie do rozróżnienia dla użytkownika.
  if (err.code === '23505') throw httpError(409, 'Pole o tej nazwie już istnieje na tej formatce');
  throw err;
}

function sanitizeListOptions(fieldType, options) {
  if (fieldType !== 'list') return [];
  if (!Array.isArray(options)) throw httpError(400, 'Pole typu lista wymaga listy wartości');
  const clean = [...new Set(options.map((option) => String(option).trim()).filter(Boolean))];
  if (!clean.length) throw httpError(400, 'Pole typu lista wymaga co najmniej jednej wartości');
  if (clean.length > MAX_LIST_OPTIONS) throw httpError(400, 'Zbyt wiele wartości listy');
  if (clean.some((option) => option.length > MAX_LIST_OPTION_LENGTH)) {
    throw httpError(400, 'Wartość listy jest zbyt długa');
  }
  return clean;
}

// ── Definicje ───────────────────────────────────────────────────────────────

/** Pola jednej formatki. `activeOnly` dla widoku rekordu, pełna lista dla admina. */
async function listDefinitions(tenantId, entity, { activeOnly = false } = {}) {
  assertEntity(entity);
  const { rows } = await db.query(
    `SELECT id, entity, name, field_type, options, sort_order, is_active
       FROM tenant_field_definitions
      WHERE tenant_id = $1 AND entity = $2
        ${activeOnly ? 'AND is_active = TRUE' : ''}
      ORDER BY sort_order, name`,
    [tenantId, entity],
  );
  return rows;
}

/** Wszystkie formatki naraz — panel admina wypisuje je obok siebie. */
async function listAllDefinitions(tenantId) {
  const { rows } = await db.query(
    `SELECT id, entity, name, field_type, options, sort_order, is_active
       FROM tenant_field_definitions
      WHERE tenant_id = $1
      ORDER BY entity, sort_order, name`,
    [tenantId],
  );
  return Object.fromEntries(
    ENTITIES.map((entity) => [entity, rows.filter((row) => row.entity === entity)]),
  );
}

async function createDefinition(tenantId, { entity, name, field_type: fieldType, options }) {
  assertEntity(entity);
  if (!FIELD_TYPES.includes(fieldType)) throw httpError(400, 'Nieznany typ pola');
  const cleanName = String(name ?? '').trim();
  if (!cleanName) throw httpError(400, 'Nazwa pola jest wymagana');
  const cleanOptions = sanitizeListOptions(fieldType, options);

  try {
    const { rows: [row] } = await db.query(
      // $2 jest użyty i jako wartość kolumny, i w podzapytaniu — bez jawnego
      // rzutowania Postgres nie potrafi wywnioskować jednego typu i odrzuca
      // całe zapytanie („niezgodne typy wyprowadzone dla parametru").
      `INSERT INTO tenant_field_definitions (tenant_id, entity, name, field_type, options, sort_order)
       VALUES ($1, $2::varchar, $3, $4, $5::jsonb,
               (SELECT COALESCE(MAX(sort_order), -1) + 1
                  FROM tenant_field_definitions WHERE tenant_id = $1 AND entity = $2::varchar))
       RETURNING id, entity, name, field_type, options, sort_order, is_active`,
      [tenantId, entity, cleanName, fieldType, JSON.stringify(cleanOptions)],
    );
    return row;
  } catch (err) { return rethrowDuplicateName(err); }
}

/** field_type jest celowo pominięty — patrz nagłówek pliku. */
async function updateDefinition(tenantId, id, { name, options, is_active: isActive }) {
  const { rows: [current] } = await db.query(
    'SELECT field_type FROM tenant_field_definitions WHERE id = $1 AND tenant_id = $2',
    [id, tenantId],
  );
  if (!current) throw httpError(404, 'Nie znaleziono pola');

  const setClauses = [];
  const params = [];
  if (name !== undefined) {
    const cleanName = String(name).trim();
    if (!cleanName) throw httpError(400, 'Nazwa pola jest wymagana');
    params.push(cleanName); setClauses.push(`name = $${params.length}`);
  }
  if (isActive !== undefined) { params.push(isActive); setClauses.push(`is_active = $${params.length}`); }
  if (options !== undefined) {
    params.push(JSON.stringify(sanitizeListOptions(current.field_type, options)));
    setClauses.push(`options = $${params.length}::jsonb`);
  }
  if (!setClauses.length) throw httpError(400, 'Brak pól do zmiany');

  params.push(id, tenantId);
  try {
    const { rows: [row] } = await db.query(
      `UPDATE tenant_field_definitions SET ${setClauses.join(', ')}, updated_at = now()
        WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
       RETURNING id, entity, name, field_type, options, sort_order, is_active`,
      params,
    );
    return row;
  } catch (err) { return rethrowDuplicateName(err); }
}

/** Nowa kolejność pól jednej formatki, po id. */
/**
 * Ile rekordow formatki ma JAKAKOLWIEK wartosc w tym polu. Wartosci siedza w
 * kolumnie `custom_values` kluczowanej po id pola (patrz buildCustomValues),
 * wiec wystarczy operator istnienia klucza w JSONB.
 */
async function countFieldUsage(tenantId, entity, id) {
  assertEntity(entity);
  const { rows: [row] } = await db.query(
    `SELECT count(*)::int AS used FROM ${VALUE_TABLES[entity]}
      WHERE tenant_id = $1 AND custom_values ? $2`,
    [tenantId, id],
  );
  return row.used;
}

/**
 * Usuwa definicje pola — ale TYLKO gdy nikt jeszcze nic w nim nie zapisal.
 * Pole z wartosciami zostaje: usuniecie wyparowalo by dane, ktore ktos wpisal,
 * a od ukrywania takiego pola jest `is_active = false`. Dzieki temu przycisk
 * usuwania sluzy do sprzatania pomylek, a nie do kasowania historii.
 */
async function deleteDefinition(tenantId, id) {
  const { rows: [definition] } = await db.query(
    'SELECT id, entity, name FROM tenant_field_definitions WHERE id = $1 AND tenant_id = $2',
    [id, tenantId],
  );
  if (!definition) throw httpError(404, 'Nie znaleziono pola');

  const used = await countFieldUsage(tenantId, definition.entity, id);
  if (used > 0) {
    throw httpError(409,
      `Pole "${definition.name}" ma wypelnione wartosci w ${used} rekordach. `
      + 'Zeby nie stracic danych, zamiast usuwac odznacz "Aktywne" — pole zniknie '
      + 'z formatki, a wartosci zostana.');
  }

  await db.query('DELETE FROM tenant_field_definitions WHERE id = $1 AND tenant_id = $2',
    [id, tenantId]);
  return { deleted: true, id, entity: definition.entity };
}

async function reorderDefinitions(tenantId, entity, ids) {
  assertEntity(entity);
  if (!Array.isArray(ids) || !ids.length) throw httpError(400, 'Brak kolejności do zapisania');
  const { rowCount } = await db.query(
    `UPDATE tenant_field_definitions AS d
        SET sort_order = new_order.position, updated_at = now()
       FROM (SELECT id, ordinality - 1 AS position
               FROM unnest($3::uuid[]) WITH ORDINALITY AS t(id, ordinality)) AS new_order
      WHERE d.id = new_order.id AND d.tenant_id = $1 AND d.entity = $2`,
    [tenantId, entity, ids],
  );
  if (!rowCount) throw httpError(404, 'Nie znaleziono pól do uporządkowania');
  return listDefinitions(tenantId, entity);
}

// ── Wartości ────────────────────────────────────────────────────────────────

/**
 * Jedna wartość sprawdzona pod typ swojego pola. Zwraca wartość do zapisu albo
 * `null`, gdy pole ma zostać wyczyszczone.
 *
 * Walidacja jest tutaj, a nie w trasach, bo te same reguły obowiązują leada,
 * partnera i dokument — i bo wartość spoza typu psuje potem każdego czytającego
 * (raport, eksport, formatkę), a nie tylko zapis.
 */
function validateValue(definition, raw) {
  if (raw === null || raw === undefined || raw === '') return null;

  switch (definition.field_type) {
    case 'text': {
      // Przycinamy brzegi: inaczej „ABC" i „ABC " to dla filtrów i raportów dwie
      // różne wartości, a użytkownik nie ma jak zobaczyć różnicy.
      const text = String(raw).trim();
      if (!text) return null;
      if (text.length > MAX_TEXT_LENGTH) {
        throw httpError(400, `Pole „${definition.name}": tekst jest zbyt długi`);
      }
      return text;
    }
    case 'number': {
      const num = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(num)) throw httpError(400, `Pole „${definition.name}": oczekiwano liczby`);
      return num;
    }
    case 'date': {
      const text = String(raw).slice(0, 10);
      if (!DATE_RE.test(text) || Number.isNaN(Date.parse(text))) {
        throw httpError(400, `Pole „${definition.name}": oczekiwano daty w formacie RRRR-MM-DD`);
      }
      return text;
    }
    case 'list': {
      const text = String(raw);
      // Wartość spoza listy przepuszczona raz zostaje w bazie na zawsze i wraca
      // w raportach jako „lewa" kategoria — stąd twarde odrzucenie.
      if (!definition.options.includes(text)) {
        throw httpError(400, `Pole „${definition.name}": wartość spoza listy`);
      }
      return text;
    }
    case 'money': {
      const amount = typeof raw?.amount === 'number' ? raw.amount : Number(String(raw?.amount).replace(',', '.'));
      const currency = String(raw?.currency ?? '').toUpperCase();
      if (!Number.isFinite(amount)) throw httpError(400, `Pole „${definition.name}": oczekiwano kwoty`);
      if (!CURRENCY_RE.test(currency)) {
        throw httpError(400, `Pole „${definition.name}": oczekiwano waluty w formacie ISO (np. PLN)`);
      }
      return { amount, currency };
    }
    default:
      throw httpError(400, `Pole „${definition.name}": nieobsługiwany typ`);
  }
}

/**
 * Łączy wartości z żądania z tym, co już jest na rekordzie, i sprawdza je pod
 * definicje tenanta. Zwraca `null`, gdy żądanie nie dotyczy pól dodatkowych —
 * wołający pomija wtedy kolumnę zamiast nadpisywać ją pustką.
 *
 * NIEZNANE KLUCZE SĄ POMIJANE, nie są błędem: formatka otwarta przed
 * dezaktywacją pola wysyła je przy zapisie i odrzucenie całego zapisu z tego
 * powodu byłoby dla użytkownika niezrozumiałe. Pomijamy też pola nieaktywne —
 * ich wcześniejsze wartości zostają nietknięte.
 */
async function buildCustomValues(tenantId, entity, incoming, existing = {}) {
  if (incoming === null || incoming === undefined) return null;
  if (typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw httpError(400, 'Pola dodatkowe muszą być obiektem id → wartość');
  }

  const definitions = await listDefinitions(tenantId, entity, { activeOnly: true });
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));

  const result = { ...existing };
  for (const [id, raw] of Object.entries(incoming)) {
    const definition = byId.get(id);
    if (!definition) continue;
    const value = validateValue(definition, raw);
    if (value === null) delete result[id];
    else result[id] = value;
  }
  return result;
}

/** Wartości z rekordu wzbogacone o definicje — do wyświetlenia na formatce. */
async function describeValues(tenantId, entity, customValues = {}) {
  const definitions = await listDefinitions(tenantId, entity, { activeOnly: true });
  return definitions.map((definition) => ({
    ...definition,
    value: customValues?.[definition.id] ?? null,
  }));
}

module.exports = {
  ENTITIES,
  FIELD_TYPES,
  VALUE_TABLES,
  listDefinitions,
  listAllDefinitions,
  createDefinition,
  updateDefinition,
  reorderDefinitions,
  countFieldUsage,
  deleteDefinition,
  buildCustomValues,
  describeValues,
  validateValue,
};
