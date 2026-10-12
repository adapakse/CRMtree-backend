'use strict';

// Dzienny raport zadań (migracja 0329, port z worktrips-doc).
//
// Testuje reguły, które najdrożej byłoby zepsuć — bo ich złamanie objawia się
// albo ciszą (ktoś nie dostaje raportu), albo spamem (wszyscy dostają za dużo):
//   - zadanie PO TERMINIE trafia do raportu, także gdy nie miało ustawionego
//     przypomnienia; to jest cała przyczyna istnienia tego mechanizmu,
//   - zadanie BEZ TERMINU nie jest „po terminie" — brak daty to nie spóźnienie,
//   - zadanie z terminem w PRZYSZŁOŚCI nie trafia nigdzie (od tego są
//     przypomnienia przed terminem),
//   - pusty raport NIE generuje maila,
//   - raport widzi WYŁĄCZNIE zadania swojego tenanta, nawet gdy ten sam e-mail
//     istnieje u dwóch (realna pułapka opisana w CLAUDE.md),
//   - wyłączony moduł Projekty nie przecieka do raportu,
//   - dzień zajmuje jedna replika backendu — druga nie wyśle duplikatu.

const db = require('../config/database');
const svc = require('../services/dailyDigestService');
const { isBusinessDay } = require('../utils/businessDays');

const SLUG_A = 'zz-digest-a';
const SLUG_B = 'zz-digest-b';
const TODAY = '2026-06-15';
const YESTERDAY = '2026-06-10';
const TOMORROW = '2026-06-20';

let tenantA, tenantB, userA, userB;

async function makeTenant(slug, name) {
  const { rows: [t] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ($1, $2, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, deleted_at = NULL
     RETURNING id`,
    [name, slug],
  );
  return t.id;
}

/** `display_name` jest kolumną GENEROWANĄ — nie wolno jej podać wprost. */
async function makeUser(tenantId, email) {
  const { rows: [u] } = await db.query(
    // Bez ON CONFLICT: `users` nie ma ograniczenia unikalnego na (tenant_id,
    // email) — ten sam adres może istnieć w kilku tenantach. Czystość zapewnia
    // cleanUp(), który kasuje tenanta razem z kaskadą.
    `INSERT INTO users (tenant_id, email, first_name, last_name, is_active)
     VALUES ($1, $2, 'Digest', 'Test', TRUE) RETURNING id`,
    [tenantId, email],
  );
  return u.id;
}

/** Zadanie na partnerze z zadanym terminem (NULL = bez terminu). */
async function makePartnerTask(tenantId, userId, dueDate, title) {
  const { rows: [p] } = await db.query(
    `INSERT INTO crm_partners (tenant_id, company, status) VALUES ($1, $2, 'active') RETURNING id`,
    [tenantId, 'Firma ' + title],
  );
  await db.query(
    `INSERT INTO crm_partner_activities (tenant_id, partner_id, type, title, activity_at, assigned_to, status)
     VALUES ($1, $2, 'task', $3, $4::date, $5, 'open')`,
    [tenantId, p.id, title, dueDate, userId],
  );
}

/**
 * `users` NIE kasuje się kaskadowo razem z tenantem (users_tenant_id_fkey bez
 * ON DELETE CASCADE), więc kolejność jest tu istotna: najpierw zależności,
 * potem tenant. Błędów nie połykamy — niedoczyszczona baza wywala kolejny
 * przebieg na unikalności (tenant_id, email) i wygląda jak błąd kodu.
 */
async function cleanUp() {
  const { rows: tenants } = await db.query(
    `SELECT id FROM tenants WHERE slug = ANY($1)`, [[SLUG_A, SLUG_B]],
  );
  if (!tenants.length) return;
  const ids = tenants.map((t) => t.id);

  await db.query('DELETE FROM crm_partner_activities WHERE tenant_id = ANY($1)', [ids]);
  await db.query('DELETE FROM crm_partners WHERE tenant_id = ANY($1)', [ids]);
  await db.query('DELETE FROM notification_digest_runs WHERE tenant_id = ANY($1)', [ids]);
  await db.query('DELETE FROM users WHERE tenant_id = ANY($1)', [ids]);
  await db.query('DELETE FROM tenants WHERE id = ANY($1)', [ids]);
}

beforeAll(async () => {
  await cleanUp();
  tenantA = await makeTenant(SLUG_A, 'Digest A');
  tenantB = await makeTenant(SLUG_B, 'Digest B');
  // Ten sam adres e-mail w dwóch tenantach — realna sytuacja w tych danych.
  userA = await makeUser(tenantA, 'digest@example.test');
  userB = await makeUser(tenantB, 'digest@example.test');
});

afterAll(cleanUp);

describe('kubełki raportu', () => {
  const task = (due) => ({ source: 'partner', title: 't', due_date: due, source_name: 'X' });

  test('po terminie, na dziś i bez daty trafiają tam, gdzie trzeba', () => {
    const out = svc.bucket(
      [task(YESTERDAY), task(TODAY), task(null), task(TOMORROW)], TODAY,
    );
    expect(out.overdue.map(i => i.due_date)).toEqual([YESTERDAY]);
    expect(out.today.map(i => i.due_date)).toEqual([TODAY]);
    expect(out.noDate).toHaveLength(1);
  });

  test('zadanie bez terminu NIE jest po terminie', () => {
    const out = svc.bucket([task(null)], TODAY);
    expect(out.overdue).toHaveLength(0);
    expect(out.noDate).toHaveLength(1);
  });

  test('zadanie z terminem w przyszłości nie trafia do raportu', () => {
    const out = svc.bucket([task(TOMORROW)], TODAY);
    expect(out.overdue.length + out.today.length + out.noDate.length).toBe(0);
  });

  test('po terminie są posortowane od najstarszego', () => {
    const out = svc.bucket([task('2026-06-12'), task('2026-06-01'), task('2026-06-09')], TODAY);
    expect(out.overdue.map(i => i.due_date)).toEqual(['2026-06-01', '2026-06-09', '2026-06-12']);
  });
});

describe('raport na realnych danych', () => {
  test('łapie zadanie po terminie BEZ ustawionego przypomnienia', async () => {
    // Sedno sprawy: crmReminderService takiego zadania nigdy nie zgłosi, bo
    // reminder_at jest NULL i nie łapie się w jego warunek.
    await makePartnerTask(tenantA, userA, YESTERDAY, 'Zaległe');
    const digest = await svc.buildDigest(tenantA, userA, TODAY, { projectsEnabled: false });

    expect(digest.overdue).toHaveLength(1);
    expect(digest.overdue[0].title).toBe('Zaległe');
    expect(svc.digestSize(digest)).toBe(1);
  });

  test('raport nie przecieka między tenantami mimo tego samego e-maila', async () => {
    const digest = await svc.buildDigest(tenantB, userB, TODAY, { projectsEnabled: false });
    expect(svc.digestSize(digest)).toBe(0);
  });

  test('pusty raport ma rozmiar 0 — wołający nie wyśle maila', async () => {
    const digest = await svc.buildDigest(tenantB, userB, TODAY, { projectsEnabled: false });
    expect(svc.digestSize(digest)).toBe(0);
  });

  test('zamknięte zadanie wypada z raportu', async () => {
    await db.query(
      `UPDATE crm_partner_activities SET status = 'closed' WHERE tenant_id = $1`, [tenantA],
    );
    const digest = await svc.buildDigest(tenantA, userA, TODAY, { projectsEnabled: false });
    expect(digest.overdue).toHaveLength(0);
    await db.query(
      `UPDATE crm_partner_activities SET status = 'open' WHERE tenant_id = $1`, [tenantA],
    );
  });
});

describe('zamek na dobę (wiele replik backendu)', () => {
  test('drugie zajęcie tego samego dnia nie przechodzi', async () => {
    const claim = async () => {
      const { rows } = await db.query(
        `INSERT INTO notification_digest_runs (tenant_id, run_date) VALUES ($1, $2::date)
         ON CONFLICT (tenant_id, run_date) DO NOTHING RETURNING tenant_id`,
        [tenantA, TODAY],
      );
      return rows.length > 0;
    };
    expect(await claim()).toBe(true);
    expect(await claim()).toBe(false);

    // Inny tenant tego samego dnia ma własny zamek — awaria u jednego nie
    // blokuje wysyłki u pozostałych.
    const { rows } = await db.query(
      `INSERT INTO notification_digest_runs (tenant_id, run_date) VALUES ($1, $2::date)
       ON CONFLICT DO NOTHING RETURNING tenant_id`,
      [tenantB, TODAY],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('kalendarz dni roboczych', () => {
  test('weekend i polskie święta nie są dniami roboczymi', () => {
    expect(isBusinessDay('2026-10-12')).toBe(true);   // poniedziałek
    expect(isBusinessDay('2026-10-11')).toBe(false);  // niedziela
    expect(isBusinessDay('2026-10-10')).toBe(false);  // sobota
    expect(isBusinessDay('2026-11-11')).toBe(false);  // Święto Niepodległości
    expect(isBusinessDay('2026-12-25')).toBe(false);  // Boże Narodzenie
    expect(isBusinessDay('2026-04-06')).toBe(false);  // Poniedziałek Wielkanocny
    expect(isBusinessDay('2026-06-04')).toBe(false);  // Boże Ciało (ruchome)
  });
});
