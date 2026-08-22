'use strict';
// src/services/seoAuthorRotationService.js
//
// Round-robin author assignment for SEObot's automatic publishing calendar —
// cycles through a tenant's active seo_authors in id order so every
// auto-scheduled article gets an author without human involvement (2026-08-22
// decision: sequential rotation, not weighted/pure random, so distribution
// stays even and deterministic). Rotation position persists on
// tenant_seo_calendar_config.last_author_id, shared between the weekly
// scheduler job and the manual drag&drop assign endpoint so both draw from
// the same cursor.

const db = require('../config/database');

async function nextAuthor(tenantId) {
  const { rows: configRows } = await db.query(
    `SELECT last_author_id FROM tenant_seo_calendar_config WHERE tenant_id = $1`,
    [tenantId],
  );
  const lastAuthorId = configRows[0]?.last_author_id ?? null;

  const { rows } = await db.query(
    `SELECT id FROM seo_authors
      WHERE tenant_id = $1 AND is_active AND ($2::int IS NULL OR id > $2)
      ORDER BY id ASC LIMIT 1`,
    [tenantId, lastAuthorId],
  );
  let nextId = rows[0]?.id ?? null;
  if (!nextId) {
    // Wrapped past the last author (or this is the first pick) — start over.
    const { rows: wrapped } = await db.query(
      `SELECT id FROM seo_authors WHERE tenant_id = $1 AND is_active ORDER BY id ASC LIMIT 1`,
      [tenantId],
    );
    nextId = wrapped[0]?.id ?? null;
  }
  if (nextId) {
    await db.query(`UPDATE tenant_seo_calendar_config SET last_author_id = $2 WHERE tenant_id = $1`, [tenantId, nextId]);
  }
  return nextId;
}

module.exports = { nextAuthor };
