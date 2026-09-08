// ─────────────────────────────────────────────────────────────────
// src/middleware/crm-rbac.js
//
// Logika dostępu CRM opiera się na:
//   req.user.crm_role  → 'salesperson' | 'sales_manager' | null
//   req.user.is_admin  → true/false (admin widzi wszystko)
//
// Reguły:
//   salesperson    → widzi TYLKO swoje leady (assigned_to) i partnerów (manager_id)
//   sales_manager  → widzi leady/partnerów przypisanych do handlowców z tej samej grupy
//                    (user_group_roles); z możliwością rozszerzenia widoku przez filtr
//                    na konkretnego usera spoza grupy (tylko podgląd, bez edycji)
//   admin          → widzi WSZYSTKO
// ─────────────────────────────────────────────────────────────────
'use strict';

const db = require('../config/database');

const CRM_ROLES = ['salesperson', 'sales_manager'];

/**
 * Middleware: wymaga zalogowania + posiadania roli CRM lub bycia adminem.
 */
function crmAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const hasCrmAccess = req.user.is_admin || CRM_ROLES.includes(req.user.crm_role);
  if (!hasCrmAccess) {
    return res.status(403).json({
      error: 'Brak uprawnień do modułu CRM. Wymagana rola: salesperson lub sales_manager.',
    });
  }
  req.isCrmManager = req.user.is_admin || req.user.crm_role === 'sales_manager';
  next();
}

/**
 * Returns the user_id list of people the current user is actively substituting
 * TODAY within their tenant (crm_absences: non-cancelled, CURRENT_DATE inside the
 * inclusive window). One person can hold several concurrent substitutions — all
 * are unioned. Day-level granularity (DATE + server CURRENT_DATE).
 */
async function loadActiveSubstituteForIds(userId, tenantId) {
  if (!userId || !tenantId) return [];
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT absent_user_id
         FROM crm_absences
        WHERE substitute_user_id = $1
          AND tenant_id = $2
          AND cancelled_at IS NULL
          AND CURRENT_DATE BETWEEN starts_on AND ends_on`,
      [userId, tenantId],
    );
    return rows.map(r => r.absent_user_id);
  } catch {
    // Table may not exist yet (env without migration 0281) — treat as no substitutions.
    return [];
  }
}

/**
 * Async middleware: ładuje zakres widoczności CRM dla bieżącego usera.
 *
 * Ustawia:
 *   req.crmScopeUserIds     - null (admin, bez ograniczeń) | uuid[]
 *                             (salesperson: [self, ...substituted-for];
 *                              manager: [users w grupach, ...substituted-for])
 *   req.crmSubstituteForIds - uuid[] osób, które user aktywnie zastępuje (może być pusta)
 *   req.crmGroupIds         - uuid[] grup managera | null
 *
 * Aktywne zastępstwo rozszerza scope 1:1 z uprawnieniami przypisanego handlowca —
 * ten sam mechanizm obsługuje odczyt (scopeFilter) i zapis (assertOwnership).
 *
 * Dla sales_manager bez żadnej grupy zwraca 403 z komunikatem dla użytkownika.
 * Musi być wywoływany po crmAuth.
 */
async function loadCrmScope(req, res, next) {
  try {
    req.crmSubstituteForIds = [];
    if (!req.user) return next();

    // Czytaj ustawienie crm_global_read z bazy (raz per request)
    let globalRead = false;
    try {
      const { rows: settingRows } = await db.query(
        `SELECT value FROM app_settings WHERE key = 'crm_global_read'`,
      );
      globalRead = settingRows[0]?.value === 'true';
    } catch { /* brak ustawienia = false */ }

    req.crmGlobalRead = globalRead;

    if (req.user.is_admin) {
      req.crmScopeUserIds = null; // brak ograniczeń
      req.crmGroupIds     = null;
      return next();
    }

    // Global read: przy żądaniach GET traktuj jak admina (tylko odczyt)
    if (globalRead && req.method === 'GET') {
      req.crmScopeUserIds = null;
      req.crmGroupIds     = null;
      return next();
    }

    const subIds = await loadActiveSubstituteForIds(req.user.id, req.user.tenant_id);
    req.crmSubstituteForIds = subIds;
    const withSubs = (baseIds) => {
      const out = baseIds.slice();
      for (const id of subIds) if (!out.includes(id)) out.push(id);
      return out;
    };

    if (req.user.crm_role === 'salesperson') {
      req.crmScopeUserIds = withSubs([req.user.id]);
      req.crmGroupIds     = null;
      return next();
    }

    if (req.user.crm_role === 'sales_manager') {
      // Pobierz grupy managera
      const { rows: groupRows } = await db.query(
        `SELECT ugr.group_id
         FROM user_group_roles ugr
         JOIN group_profiles gp ON gp.id = ugr.group_id
         WHERE ugr.user_id = $1 AND gp.is_active = TRUE`,
        [req.user.id],
      );

      if (groupRows.length === 0) {
        return res.status(403).json({
          error:
            'Manager Sprzedaży nie jest przypisany do żadnej grupy. ' +
            'Skontaktuj się z administratorem w celu przypisania do grupy.',
        });
      }

      const groupIds = groupRows.map(r => r.group_id);
      req.crmGroupIds = groupIds;

      // Pobierz wszystkich userów należących do tych grup
      const { rows: userRows } = await db.query(
        `SELECT DISTINCT user_id
         FROM user_group_roles
         WHERE group_id = ANY($1::uuid[])`,
        [groupIds],
      );

      req.crmScopeUserIds = withSubs(userRows.map(r => r.user_id));
      return next();
    }

    next();
  } catch (err) { next(err); }
}

/**
 * Middleware: dodaje req.scopeFilter() helper.
 * Wywołaj po loadCrmScope (który ustawia req.crmScopeUserIds).
 *
 * Logika scopeFilter(alias, ownerCol, params):
 *   - admin                       → '' (brak ograniczeń)
 *   - sales_manager + explicit    → '' (manager podał ownerCol w query → ekspansja; route handler doda filtr)
 *   - sales_manager (default)     → AND col = ANY($n::uuid[]) (tylko scope grupy)
 *   - salesperson                 → AND col = $n (tylko własne)
 */
function crmScope(req, res, next) {
  req.scopeFilter = (alias, ownerCol, params) => {
    if (req.user.is_admin || req.crmGlobalRead) return '';

    const col = alias ? `${alias}.${ownerCol}` : ownerCol;

    // sales_manager z jawnym filtrem ownerCol → ekspansja, scope pominięty
    if (req.user.crm_role === 'sales_manager' && req.query && req.query[ownerCol]) {
      return '';
    }

    if (!req.crmScopeUserIds || req.crmScopeUserIds.length === 0) {
      return ' AND 1=0';
    }

    params.push(req.crmScopeUserIds);
    return ` AND ${col} = ANY($${params.length}::uuid[])`;
  };
  next();
}

/**
 * Middleware: tylko sales_manager lub admin.
 */
function requireCrmManager(req, res, next) {
  if (!req.isCrmManager) {
    return res.status(403).json({ error: 'Wymagana rola sales_manager lub admin.' });
  }
  next();
}

/**
 * Sprawdza czy bieżący user może EDYTOWAĆ dany rekord.
 *
 * - admin     → zawsze tak
 * - pozostali → właściciel rekordu musi mieścić się w req.crmScopeUserIds:
 *               własny rekord, rekord handlowca z grupy managera, albo rekord
 *               osoby, którą user aktywnie zastępuje (loadCrmScope rozszerza scope).
 *
 * Rzuca błąd 403 przy braku uprawnień.
 */
function assertOwnership(record, req, ownerProp = 'assigned_to') {
  if (req.user.is_admin) return;

  const ownerId = record[ownerProp];
  if (Array.isArray(req.crmScopeUserIds) && req.crmScopeUserIds.includes(ownerId)) {
    return;
  }

  const err = new Error(
    req.user.crm_role === 'sales_manager'
      ? 'Nie możesz edytować tego rekordu — handlowiec nie należy do Twojej grupy.'
      : 'Brak dostępu do tego rekordu.',
  );
  err.status = 403;
  throw err;
}

/**
 * Czy bieżący user może operować na rekordach należących do ownerId
 * (własne / grupa managera / aktywne zastępstwo). Admin — zawsze.
 * Pomocnik do miejsc, które nie używają assertOwnership (np. aktywności).
 */
function canOperateForOwner(req, ownerId) {
  if (req.user?.is_admin) return true;
  return Array.isArray(req.crmScopeUserIds) && req.crmScopeUserIds.includes(ownerId);
}

/**
 * Middleware factory: blokuje endpoint jeśli dany moduł nie jest włączony dla tenanta.
 * Tenanci bez wiersza w tenant_features (np. gold) mają dostęp do wszystkiego.
 */
function requireFeature(feature) {
  return async (req, res, next) => {
    try {
      const tenantId = req.user?.tenant_id;
      if (!tenantId) return next(); // super admin / gold — brak ograniczeń
      const { rows } = await db.query(
        'SELECT is_enabled FROM tenant_features WHERE tenant_id = $1 AND feature = $2',
        [tenantId, feature]
      );
      if (rows.length && rows[0].is_enabled === false) {
        return res.status(403).json({ error: `Moduł '${feature}' nie jest aktywny dla tego tenanta.` });
      }
      next();
    } catch (err) { next(err); }
  };
}

module.exports = { crmAuth, loadCrmScope, requireCrmManager, crmScope, assertOwnership, canOperateForOwner, requireFeature };
