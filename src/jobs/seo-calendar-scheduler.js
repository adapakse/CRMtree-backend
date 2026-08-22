'use strict';
// src/jobs/seo-calendar-scheduler.js
//
// Weekly auto-fill for tenants with the SEObot publishing calendar enabled
// (tenant_seo_calendar_config.is_enabled). Modeled on jobs/billing-run.js:
// instead of firing on one specific Monday tick — which permanently skips a
// week if the server happens to be down at that exact moment — it tracks how
// far each tenant's calendar has actually been filled
// (tenant_seo_calendar_config.last_filled_week_start) and, on every tick and
// once unconditionally on boot, catches up any week that should already be
// filled. Self-healing instead of a fragile single-shot cron.
//
// "Filled" means: the week starting 7 days after the current Monday has an
// article assigned to every configured weekday slot (pulled from the
// unassigned queue first, generated fresh only for the remainder). That
// keeps a rolling 2-week buffer — this week (filled last cycle, now locked
// and publishing via jobs/seo-scheduler.js) plus next week (filled now,
// still editable via drag&drop until its Monday arrives — see
// routes/crm-seo.js PATCH /calendar/content/:id/assign, which is the only
// place that enforces the lock, by comparing against today's date).
//
// Auto-scheduled articles skip the manual /content/:id/approve gate entirely
// — they go straight from 'queued'/fresh-generation to 'scheduled', and the
// existing jobs/seo-scheduler.js publishes them exactly like a human-approved
// one once scheduled_at arrives. An article that fails generateArticle's
// validation lands as 'needs_update' and is never auto-scheduled — a slot
// with no valid candidate is left open rather than publishing bad content.

const db = require('../config/database');
const logger = require('../utils/logger');
const seoContentService = require('../services/seoContentService');
const authorRotation = require('../services/seoAuthorRotationService');
const { mondayOf, addDays, toDateStr } = require('../utils/isoWeek');

const TZ = 'Europe/Warsaw';
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

// getUTCDay(): 0=Sun..6=Sat — indexed the same way as this array.
const DAY_COLUMNS = [
  'sunday_count', 'monday_count', 'tuesday_count', 'wednesday_count',
  'thursday_count', 'friday_count', 'saturday_count',
];

function getTodayWarsaw() {
  return new Date(`${dateFmt.format(new Date())}T00:00:00Z`);
}

async function fetchActiveConfigs() {
  const { rows } = await db.query(
    `SELECT * FROM tenant_seo_calendar_config WHERE is_enabled = true AND (end_date IS NULL OR end_date >= $1)`,
    [toDateStr(getTodayWarsaw())],
  );
  return rows;
}

async function fillWeek(tenantId, weekStart, dayCounts) {
  for (let offset = 0; offset < 7; offset++) {
    const targetDate = addDays(weekStart, offset);
    const targetCount = dayCounts[DAY_COLUMNS[targetDate.getUTCDay()]];
    if (!targetCount) continue;
    const targetDateStr = toDateStr(targetDate);

    const { rows: existing } = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM seo_content_pieces
        WHERE tenant_id = $1 AND status = 'scheduled' AND scheduled_at::date = $2`,
      [tenantId, targetDateStr],
    );
    let need = targetCount - existing[0].cnt;

    while (need > 0) {
      let contentId;
      const { rows: queued } = await db.query(
        `SELECT id FROM seo_content_pieces WHERE tenant_id = $1 AND status = 'queued' ORDER BY created_at ASC LIMIT 1`,
        [tenantId],
      );
      if (queued[0]) {
        contentId = queued[0].id;
      } else {
        const { rows: tenantRows } = await db.query(`SELECT seo_daily_article_limit FROM tenants WHERE id = $1`, [tenantId]);
        const generatedToday = await seoContentService.countGeneratedToday(tenantId);
        if (generatedToday >= (tenantRows[0]?.seo_daily_article_limit ?? 0)) {
          logger.info('[seo-calendar-scheduler] Daily generation limit reached — leaving slot open', { tenantId, targetDate: targetDateStr });
          break;
        }
        let content;
        try {
          content = await seoContentService.generateArticle(tenantId);
        } catch (err) {
          logger.error('[seo-calendar-scheduler] Generation failed — leaving slot open', { tenantId, targetDate: targetDateStr, error: err.message });
          break;
        }
        if (content.status !== 'in_review') {
          logger.info('[seo-calendar-scheduler] Generated article failed validation — leaving slot open', { tenantId, contentId: content.id, targetDate: targetDateStr });
          break;
        }
        contentId = content.id;
      }

      const authorId = await authorRotation.nextAuthor(tenantId);
      await db.query(
        `UPDATE seo_content_pieces
            SET status = 'scheduled', scheduled_at = $2::date + TIME '09:00', author_id = COALESCE(author_id, $3)
          WHERE id = $1`,
        [contentId, targetDateStr, authorId],
      );
      need--;
    }
  }
}

// Fills every week between the tenant's last-filled cursor and "next week"
// (currentMonday + 7d), one at a time, in order — so a multi-week gap left
// by downtime gets closed in full rather than jumping straight to the
// latest week and silently leaving earlier ones empty.
async function catchUpTenant(config) {
  const currentMonday = mondayOf(getTodayWarsaw());
  const targetWeekStart = addDays(currentMonday, 7);
  let week = config.last_filled_week_start ? addDays(mondayOf(new Date(config.last_filled_week_start)), 7) : targetWeekStart;

  while (week <= targetWeekStart) {
    await fillWeek(config.tenant_id, week, config);
    await db.query(`UPDATE tenant_seo_calendar_config SET last_filled_week_start = $2 WHERE tenant_id = $1`, [config.tenant_id, toDateStr(week)]);
    week = addDays(week, 7);
  }
}

async function runCatchUp() {
  const configs = await fetchActiveConfigs();
  for (const config of configs) {
    try {
      await catchUpTenant(config);
    } catch (err) {
      logger.error('[seo-calendar-scheduler] Tenant catch-up failed', { tenantId: config.tenant_id, error: err.message });
    }
  }
  return configs.length;
}

function startSeoCalendarSchedulerJob() {
  // Unconditional catch-up on boot — a restart doesn't have to wait for the
  // next hourly tick to notice a week rolled over while the server was down.
  (async () => {
    try {
      const count = await runCatchUp();
      logger.info('[seo-calendar-scheduler] Startup catch-up complete', { tenantsChecked: count });
    } catch (err) {
      logger.error('[seo-calendar-scheduler] Startup catch-up failed', { error: err.message });
    }
  })();

  // Hourly is plenty — this only ever needs to notice a new week has
  // started, unlike jobs/seo-scheduler.js which publishes at minute
  // precision.
  setInterval(async () => {
    try {
      await runCatchUp();
    } catch (err) {
      logger.error('[seo-calendar-scheduler] Tick error', { error: err.message });
    }
  }, 60 * 60_000);

  logger.info('[seo-calendar-scheduler] Job started (catch-up on boot, then hourly)');
}

module.exports = { startSeoCalendarSchedulerJob };
