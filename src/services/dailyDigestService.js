'use strict';
// ─────────────────────────────────────────────────────────────────
// services/dailyDigestService.js — dzienny raport zadań.
//
// Jeden zbiorczy mail na osobę, o 09:00 czasu Europe/Warsaw, tylko w dni
// robocze. Cztery sekcje: po terminie, na dziś, nieprzeczytane maile, bez daty.
//
// PO CO TO JEST, skoro są już przypomnienia: crmReminderService wysyła
// przypomnienie JEDNORAZOWO i wyłącznie PRZED terminem
// (`reminder_at <= now() AND reminder_sent = false`, potem `reminder_sent =
// true`). Zadanie, które minęło termin i nadal jest otwarte, nie generuje
// potem żadnego sygnału, a zadanie bez ustawionego przypomnienia nie generuje
// go nigdy. Ten raport zamyka tę dziurę: pyta codziennie „co masz po
// terminie", zamiast raz „zbliża się termin".
//
// Port z worktrips-doc (followUpService.js). ZASADY PRZENIESIONE 1:1 — to
// decyzje produktowe stamtąd, nie moje, więc nie zmieniaj ich bez pytania:
//   * jeden mail na osobę, nie jeden na zadanie,
//   * wyłącznie osoba PRZYPISANA do zadania — worktrips nigdzie nie eskaluje
//     ani do przełożonego, ani do właściciela projektu,
//   * PUSTA LISTA = MAIL NIE WYCHODZI. Inaczej ludzie dostają codzienne „nie
//     masz nic do zrobienia" i po tygodniu przestają czytać raport.
//
// CZYM RÓŻNI SIĘ OD WORKTRIPS (wymuszone przez CRMtree, nie kaprys):
//   1. PIĄTE ŹRÓDŁO — zadania modułu Projekty, których worktrips nie ma.
//      Mają wielu przypisanych (project_task_assignees), więc jedno zadanie
//      trafia do raportu każdej z tych osób.
//   2. WIELU TENANTÓW — każde zapytanie filtruje tenant_id. Ten sam adres
//      e-mail potrafi istnieć w kilku tenantach naraz (patrz CLAUDE.md,
//      pułapka z logowaniem), więc raport budujemy per para (tenant, user).
//   3. JĘZYK ODBIORCY — worktrips ma zaszyty polski. Tutaj treść idzie przez
//      resolveLocale() i zakres i18n `emails`, jak każdy inny mail w CRMtree.
//   4. MODUŁY ZA FLAGAMI — tenant bez modułu Projekty nie dostaje sekcji z
//      zadaniami projektowymi, nawet jeśli w bazie zostały po wyłączeniu.
//
// JEDNO ZAPYTANIE ZAMIAST TRZECH: worktrips ma osobne queryOverdue/queryToday/
// queryNoDate, każde z tym samym czterokrotnym UNION-em i różniące się jedynie
// warunkiem na datę. Przy pięciu źródłach byłoby to trzysta linii prawie
// identycznego SQL-a, w którym łatwo poprawić warunek w dwóch miejscach na
// trzy. Tutaj pobieramy otwarte zadania RAZ i dzielimy je na kubełki w JS —
// reguła podziału jest wtedy w jednym miejscu i widać ją na pierwszy rzut oka.
// ─────────────────────────────────────────────────────────────────

const db = require('../config/database');
const logger = require('../utils/logger');
const email = require('../utils/email');
const { resolveLocale } = require('../config/locales');

const TIME_ZONE = 'Europe/Warsaw';

/** Dzisiejsza data 'YYYY-MM-DD' wg strefy Europe/Warsaw. */
function todayWarsaw() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TIME_ZONE });
}

/**
 * Wszystkie OTWARTE zadania jednej osoby w jednym tenancie, ze wszystkich
 * pięciu źródeł. Podział na „po terminie / na dziś / bez daty" robi bucket()
 * na podstawie kolumny due_date — tutaj interesuje nas tylko to, co otwarte.
 *
 * `step_name` wypełnia wyłącznie onboarding (numer kroku); w pozostałych
 * źródłach jest NULL i mail po prostu go nie pokazuje.
 */
async function queryOpenTasks(tenantId, userId, { projectsEnabled }) {
  const { rows } = await db.query(
    `
    -- Zadania obiegu dokumentów
    SELECT 'workflow'          AS source,
           wt.id::text         AS task_id,
           wt.task_type::text  AS type,
           d.name              AS title,
           d.name              AS source_name,
           d.id::text          AS source_id,
           wt.due_date::text   AS due_date,
           NULL::int           AS step
      FROM workflow_tasks wt
      JOIN documents d ON d.id = wt.document_id AND d.deleted_at IS NULL
     WHERE wt.tenant_id = $1
       AND wt.assigned_to = $2
       AND wt.task_status IN ('pending','in_progress')

    UNION ALL

    -- Zadania na leadzie
    SELECT 'lead', a.id::text, a.type, a.title,
           l.company, l.id::text,
           a.activity_at::date::text, NULL
      FROM crm_lead_activities a
      JOIN crm_leads l ON l.id = a.lead_id AND l.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1
       AND a.assigned_to = $2
       AND a.status <> 'closed'
       AND a.type = 'task'

    UNION ALL

    -- Zadania na partnerze
    SELECT 'partner', a.id::text, a.type, a.title,
           p.company, p.id::text,
           a.activity_at::date::text, NULL
      FROM crm_partner_activities a
      JOIN crm_partners p ON p.id = a.partner_id AND p.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1
       AND a.assigned_to = $2
       AND a.status <> 'closed'
       AND a.type = 'task'

    UNION ALL

    -- Zadania onboardingu partnera
    SELECT 'onboarding', t.id::text, t.type, t.title,
           p.company, p.id::text,
           t.due_date::text, t.step
      FROM crm_onboarding_tasks t
      JOIN crm_partners p ON p.id = t.partner_id AND p.tenant_id = t.tenant_id
     WHERE t.tenant_id = $1
       AND t.assigned_to = $2
       AND t.done = false

    UNION ALL

    -- Zadania projektowe. Wielu przypisanych, więc join przez tabelę
    -- przypisań; zamknięte projekty i zadania w kategorii „done" odpadają.
    -- $3 = czy tenant ma włączony moduł Projekty.
    SELECT 'project', t.id::text, 'task', t.name,
           p.key || '-' || t.task_number, p.id::text,
           t.end_date::text, NULL
      FROM project_tasks t
      JOIN project_task_assignees pa ON pa.task_id = t.id AND pa.user_id = $2
      JOIN projects p ON p.id = t.project_id
      JOIN project_task_statuses s ON s.id = t.status_id
     WHERE $3 = TRUE
       AND t.tenant_id = $1
       AND p.status = 'open'
       AND s.category <> 'done'
    `,
    [tenantId, userId, projectsEnabled],
  );
  return rows;
}

/**
 * Nieprzeczytane maile przypisane do tej osoby. Osobne zapytanie, bo to nie są
 * zadania z terminem — mają własną sekcję i nie wpadają do kubełków po dacie.
 */
async function queryUnreadEmails(tenantId, userId) {
  const { rows } = await db.query(
    `
    SELECT 'lead' AS source, a.id::text AS task_id, 'email' AS type,
           a.title, l.company AS source_name, l.id::text AS source_id,
           NULL::text AS due_date, NULL::int AS step
      FROM crm_lead_activities a
      JOIN crm_leads l ON l.id = a.lead_id AND l.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1 AND a.assigned_to = $2
       AND a.type = 'email' AND a.is_read = false

    UNION ALL

    SELECT 'partner', a.id::text, 'email',
           a.title, p.company, p.id::text, NULL, NULL
      FROM crm_partner_activities a
      JOIN crm_partners p ON p.id = a.partner_id AND p.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1 AND a.assigned_to = $2
       AND a.type = 'email' AND a.is_read = false
    `,
    [tenantId, userId],
  );
  return rows;
}

/**
 * Dzieli otwarte zadania na sekcje raportu. Zadanie bez daty trafia do „bez
 * daty", a nie do „po terminie" — brak terminu to nie to samo co spóźnienie.
 */
function bucket(tasks, today) {
  const overdue = [];
  const dueToday = [];
  const noDate = [];
  for (const task of tasks) {
    if (!task.due_date) noDate.push(task);
    else if (task.due_date < today) overdue.push(task);
    else if (task.due_date === today) dueToday.push(task);
    // Zadania z terminem w przyszłości świadomie pomijamy — od tego są
    // przypomnienia przed terminem (crmReminderService), a raport ma pokazywać
    // to, co wymaga uwagi DZIŚ.
  }
  const byDate = (a, b) => String(a.due_date).localeCompare(String(b.due_date));
  const bySource = (a, b) => a.source.localeCompare(b.source)
    || String(a.source_name).localeCompare(String(b.source_name));
  return {
    overdue: overdue.sort(byDate),
    today: dueToday.sort(byDate),
    noDate: noDate.sort(bySource),
  };
}

/** Raport jednej osoby w jednym tenancie. */
async function buildDigest(tenantId, userId, today, { projectsEnabled }) {
  const [tasks, unread] = await Promise.all([
    queryOpenTasks(tenantId, userId, { projectsEnabled }),
    queryUnreadEmails(tenantId, userId),
  ]);
  return { ...bucket(tasks, today), unread };
}

function digestSize(digest) {
  return digest.overdue.length + digest.today.length
    + digest.unread.length + digest.noDate.length;
}

/** Tenanci z aktywnymi użytkownikami, razem z informacją o module Projekty. */
async function tenantsToProcess() {
  const { rows } = await db.query(`
    SELECT t.id, t.slug, t.default_locale,
           COALESCE((
             SELECT f.is_enabled FROM tenant_features f
              WHERE f.tenant_id = t.id AND f.feature = 'projects'
           ), FALSE) AS projects_enabled
      FROM tenants t
     WHERE t.is_active = TRUE AND t.deleted_at IS NULL
  `);
  return rows;
}

/**
 * Zajmuje dzień dla tenanta. Zwraca false, gdy inna replika backendu już go
 * zajęła — wtedy ta replika nie wysyła niczego.
 *
 * Wzorzec z crmReminderService (UPDATE ... RETURNING) tu nie zadziała: raport
 * nie ma własnego wiersza do zaklepania. Zamkiem jest sam fakt wysyłki w danym
 * dniu, stąd osobna tabela i INSERT ON CONFLICT DO NOTHING.
 */
async function claimDay(tenantId, runDate) {
  const { rows } = await db.query(
    `INSERT INTO notification_digest_runs (tenant_id, run_date)
     VALUES ($1, $2::date)
     ON CONFLICT (tenant_id, run_date) DO NOTHING
     RETURNING tenant_id`,
    [tenantId, runDate],
  );
  return rows.length > 0;
}

/**
 * Wysyła dzienny raport wszystkim, którzy mają co dostać.
 *
 * Nie rzuca: błąd u jednego tenanta albo jednej osoby nie może zatrzymać
 * pozostałych — to ta sama zasada co w synchronizacji KSeF.
 */
async function sendDailyDigests() {
  const today = todayWarsaw();
  let totalSent = 0;

  for (const tenant of await tenantsToProcess()) {
    if (!await claimDay(tenant.id, today)) {
      logger.debug('[Digest] Dzień już zajęty przez inną replikę', { tenant: tenant.slug, today });
      continue;
    }

    let sent = 0;
    try {
      const { rows: users } = await db.query(
        `SELECT id, email, display_name, locale
           FROM users
          WHERE tenant_id = $1
            AND is_active = TRUE
            AND digest_enabled = TRUE
            AND email IS NOT NULL AND email <> ''
          ORDER BY display_name`,
        [tenant.id],
      );

      for (const user of users) {
        try {
          const digest = await buildDigest(tenant.id, user.id, today, {
            projectsEnabled: tenant.projects_enabled,
          });
          // Pusty raport nie wychodzi — zasada z worktrips, patrz nagłówek.
          if (digestSize(digest) === 0) continue;

          await email.sendDailyDigest({
            tenantId: tenant.id,
            to: user.email,
            locale: resolveLocale({
              userLocale: user.locale,
              tenantDefaultLocale: tenant.default_locale,
            }),
            recipientName: user.display_name,
            digest,
            date: today,
          });
          sent++;
        } catch (err) {
          logger.error('[Digest] Błąd wysyłki do użytkownika', {
            tenant: tenant.slug, userId: user.id, error: err.message,
          });
        }
      }

      await db.query(
        `UPDATE notification_digest_runs SET finished_at = now(), sent_count = $3
          WHERE tenant_id = $1 AND run_date = $2::date`,
        [tenant.id, today, sent],
      );
      totalSent += sent;
      logger.info('[Digest] Raport wysłany', { tenant: tenant.slug, sent, users: users.length });
    } catch (err) {
      await db.query(
        `UPDATE notification_digest_runs SET finished_at = now(), error = $3
          WHERE tenant_id = $1 AND run_date = $2::date`,
        [tenant.id, today, String(err.message).slice(0, 1000)],
      ).catch(() => { /* zapis diagnostyki nie może przykryć pierwotnego błędu */ });
      logger.error('[Digest] Błąd raportu tenanta', { tenant: tenant.slug, error: err.message });
    }
  }

  return totalSent;
}

module.exports = {
  sendDailyDigests,
  buildDigest,
  bucket,
  todayWarsaw,
  digestSize,
};
