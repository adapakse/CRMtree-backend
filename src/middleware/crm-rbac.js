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
 * Async middleware: ładuje zakres widoczności CRM dla bieżącego usera.
 *
 * Ustawia:
 *   req.crmScopeUserIds  - null (admin, bez ograniczeń) | uuid[] (manager: users w grupach)
 *   req.crmGroupIds      - uuid[] grup managera | null
 *
 * Dla sales_manager bez żadnej grupy zwraca 403 z komunikatem dla użytkownika.
 * Musi być wywoływany po crmAuth.
 */
async function loadCrmScope(req, res, next) {
  try {
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

    if (req.user.crm_role === 'salesperson') {
      req.crmScopeUserIds = [req.user.id];
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

      req.crmScopeUserIds = userRows.map(r => r.user_id);
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
 * - admin          → zawsze tak
 * - sales_manager  → tylko gdy właściciel rekordu należy do grupy managera
 * - salesperson    → tylko własne rekordy
 *
 * Rzuca błąd 403 przy braku uprawnień.
 */
function assertOwnership(record, req, ownerProp = 'assigned_to') {
  if (req.user.is_admin) return;

  if (req.user.crm_role === 'sales_manager') {
    if (req.crmScopeUserIds && !req.crmScopeUserIds.includes(record[ownerProp])) {
      const err = new Error(
        'Nie możesz edytować tego rekordu — handlowiec nie należy do Twojej grupy.',
      );
      err.status = 403;
      throw err;
    }
    return;
  }

  // salesperson
  if (record[ownerProp] !== req.user.id) {
    const err = new Error('Brak dostępu do tego rekordu.');
    err.status = 403;
    throw err;
  }
}

module.exports = { crmAuth, loadCrmScope, requireCrmManager, crmScope, assertOwnership };
