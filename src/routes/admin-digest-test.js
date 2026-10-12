'use strict';
// ─────────────────────────────────────────────────────────────────
// routes/admin-digest-test.js
//
// TYMCZASOWE — ręczne odpalenie dziennego raportu zadań (normalnie 09:00
// Europe/Warsaw, jobs/daily-digest.js). Powstało wyłącznie po to, żeby dało się
// potwierdzić „czy raport działa" bez czekania do rana.
//
// DO USUNIĘCIA PO WERYFIKACJI: skasuj ten plik i dwie linie w app.js
// (`adminDigestTestRoutes`). Nic w produkcie od tego nie zależy.
//
// POST /api/admin/notifications/digest/run
//   body: { dry_run?: boolean, force?: boolean }
//     dry_run=true (DOMYŚLNIE) — buduje raporty i zwraca, kto ile by dostał,
//                                NIE wysyła ani jednego maila
//     dry_run=false            — realna wysyłka, przez ten sam
//                                dailyDigestService.sendDailyDigests() co job
//     force=true               — kasuje dzisiejsze wpisy w
//                                notification_digest_runs, żeby wysyłka mogła
//                                pójść drugi raz tego samego dnia (bez tego
//                                claimDay blokuje powtórkę po przebiegu 09:00)
//
// Dostęp: wyłącznie super admin.
// ─────────────────────────────────────────────────────────────────

const router = require('express').Router();
const db = require('../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const digestService = require('../services/dailyDigestService');

router.use(requireAuth, requireSuperAdmin);

router.post('/run', async (req, res, next) => {
  try {
    const isDryRun = req.body?.dry_run !== false;
    const isForced = req.body?.force === true;
    const today = digestService.todayWarsaw();

    if (!isDryRun) {
      if (isForced) {
        await db.query('DELETE FROM notification_digest_runs WHERE run_date = $1::date', [today]);
      }
      const sent = await digestService.sendDailyDigests();
      logger.warn('[DigestTest] Manual digest run', { by: req.user.id, today, forced: isForced, sent });
      return res.json({ mode: 'sent', date: today, forced: isForced, sent });
    }

    const { rows: tenants } = await db.query(`
      SELECT t.id, t.slug,
             COALESCE((
               SELECT f.is_enabled FROM tenant_features f
                WHERE f.tenant_id = t.id AND f.feature = 'projects'
             ), FALSE) AS projects_enabled
        FROM tenants t
       WHERE t.is_active = TRUE AND t.deleted_at IS NULL
    `);

    const recipients = [];
    for (const tenant of tenants) {
      const { rows: users } = await db.query(
        `SELECT id, email, display_name
           FROM users
          WHERE tenant_id = $1 AND is_active = TRUE AND digest_enabled = TRUE
            AND email IS NOT NULL AND email <> ''
          ORDER BY display_name`,
        [tenant.id],
      );
      for (const user of users) {
        const digest = await digestService.buildDigest(tenant.id, user.id, today, {
          projectsEnabled: tenant.projects_enabled,
        });
        const total = digestService.digestSize(digest);
        // Pusty raport nie wychodzi — ta sama zasada co w jobie.
        if (total === 0) continue;
        recipients.push({
          tenant: tenant.slug,
          email: user.email,
          name: user.display_name,
          total,
          overdue: digest.overdue.length,
          today: digest.today.length,
          unread: digest.unread.length,
          no_date: digest.noDate.length,
        });
      }
    }

    res.json({ mode: 'dry_run', date: today, would_send: recipients.length, recipients });
  } catch (err) { next(err); }
});

module.exports = router;
