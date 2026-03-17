// ─────────────────────────────────────────────────────────────────
// src/middleware/crm-rbac.js
//
// Logika dostępu CRM opiera się na:
//   req.user.crm_role  → 'salesperson' | 'sales_manager' | null
//   req.user.is_admin  → true/false (admin widzi wszystko jak manager)
//
// Reguły:
//   salesperson    → widzi TYLKO swoje leady (assigned_to) i partnerów (manager_id)
//   sales_manager  → widzi WSZYSTKO
//   admin          → widzi WSZYSTKO (jak manager)
// ─────────────────────────────────────────────────────────────────
'use strict';

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
  // Attach helpers
  req.isCrmManager = req.user.is_admin || req.user.crm_role === 'sales_manager';
  next();
}

/**
 * Middleware: tylko sales_manager lub admin.
 * Używaj dla: bulk delete, reassign, export, zarządzanie grupami.
 */
function requireCrmManager(req, res, next) {
  if (!req.isCrmManager) {
    return res.status(403).json({ error: 'Wymagana rola sales_manager lub admin.' });
  }
  next();
}

/**
 * Middleware: dodaje req.scopeFilter() helper.
 * Wywołaj PRZED handlerem (po crmAuth).
 */
function crmScope(req, res, next) {
  /**
   * Buduje fragment WHERE ograniczający widoczność.
   * @param {string} alias    - alias tabeli np. 'l' → 'l.assigned_to'
   * @param {string} ownerCol - kolumna właściciela np. 'assigned_to'
   * @param {Array}  params   - tablica parametrów zapytania (zostanie rozszerzona)
   * @returns {string}        - fragment SQL zaczynający się od ' AND ...' lub ''
   */
  req.scopeFilter = (alias, ownerCol, params) => {
    if (req.isCrmManager) return '';
    const col = alias ? `${alias}.${ownerCol}` : ownerCol;
    params.push(req.user.id);
    return ` AND ${col} = $${params.length}`;
  };
  next();
}

/**
 * Sprawdza własność rekordu (dla salesperson).
 * Rzuca błąd 403 jeśli handlowiec próbuje edytować cudzy rekord.
 *
 * @param {object} record
 * @param {object} req
 * @param {string} ownerProp - domyślnie 'assigned_to'
 */
function assertOwnership(record, req, ownerProp = 'assigned_to') {
  if (req.isCrmManager) return;
  if (record[ownerProp] !== req.user.id) {
    const err = new Error('Brak dostępu do tego rekordu.');
    err.status = 403;
    throw err;
  }
}

module.exports = { crmAuth, requireCrmManager, crmScope, assertOwnership };
