'use strict';

// Pola dodatkowe definiowane przez admina tenanta na formatkach leada, partnera
// i dokumentu (migracja 0328).
//
// Testuje to, co w tym mechanizmie najdrożej byłoby zepsuć:
//   - listy są ROZŁĄCZNE per formatka: pole partnera nie pojawia się na leadzie,
//     a ta sama nazwa może istnieć na dwóch formatkach,
//   - wartość jest sprawdzana pod typ swojego pola — wartość spoza typu
//     przepuszczona raz zostaje w bazie na zawsze i wraca w raportach,
//   - dezaktywacja pola NIE kasuje wartości już wpisanych na rekordach,
//   - nieznane klucze w żądaniu są pomijane, a nie wywalają całego zapisu:
//     formatka otwarta przed dezaktywacją pola nadal je wysyła,
//   - typu pola nie da się zmienić po utworzeniu.
//
// Integracyjny na realnej lokalnej bazie — mechanizm jest w całości o SQL-u i
// walidacji, więc mock niczego by tu nie dowiódł.

const db = require('../config/database');
const svc = require('../services/tenantFieldService');

const SLUG = 'zz-tenant-fields-test';
let tenantId;

beforeAll(async () => {
  const { rows: [tenant] } = await db.query(
    `INSERT INTO tenants (name, slug, is_active) VALUES ('Tenant Fields Test', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET is_active = TRUE, deleted_at = NULL RETURNING id`,
    [SLUG],
  );
  tenantId = tenant.id;
});

beforeEach(async () => {
  await db.query('DELETE FROM tenant_field_definitions WHERE tenant_id = $1', [tenantId]);
});

afterAll(async () => {
  await db.query('DELETE FROM tenant_field_definitions WHERE tenant_id = $1', [tenantId]);
  await db.query('DELETE FROM tenants WHERE slug = $1', [SLUG]);
});

const makeField = (entity, name, fieldType, options) =>
  svc.createDefinition(tenantId, { entity, name, field_type: fieldType, options });

describe('listy pól są rozłączne per formatka', () => {
  test('ta sama nazwa może istnieć na leadzie i na partnerze', async () => {
    const onLead = await makeField('lead', 'Numer umowy', 'text');
    const onPartner = await makeField('partner', 'Numer umowy', 'text');
    expect(onLead.id).not.toBe(onPartner.id);

    const all = await svc.listAllDefinitions(tenantId);
    expect(all.lead.map((d) => d.name)).toEqual(['Numer umowy']);
    expect(all.partner.map((d) => d.name)).toEqual(['Numer umowy']);
    expect(all.document).toEqual([]);
  });

  test('dwa pola o tej samej nazwie na JEDNEJ formatce są odrzucane', async () => {
    await makeField('partner', 'Segment', 'text');
    await expect(makeField('partner', 'Segment', 'number'))
      .rejects.toMatchObject({ status: 409 });
  });

  test('kolejność liczy się osobno dla każdej formatki', async () => {
    await makeField('lead', 'A', 'text');
    await makeField('lead', 'B', 'text');
    const pierwszeNaPartnerze = await makeField('partner', 'C', 'text');
    expect(pierwszeNaPartnerze.sort_order).toBe(0);
  });

  test('nieznana formatka jest odrzucana', async () => {
    await expect(makeField('faktura', 'X', 'text')).rejects.toMatchObject({ status: 400 });
  });
});

describe('wartość jest sprawdzana pod typ swojego pola', () => {
  test('poprawne wartości są normalizowane, nie tylko przepuszczane', async () => {
    const tekst = await makeField('partner', 'Umowa', 'text');
    const liczba = await makeField('partner', 'Zatrudnieni', 'number');
    const kwota = await makeField('partner', 'Limit', 'money');

    const saved = await svc.buildCustomValues(tenantId, 'partner', {
      [tekst.id]: '  UR/2026/14  ',
      [liczba.id]: '42',
      // Przecinek dziesiętny i mała waluta — tak to realnie przychodzi z formatki.
      [kwota.id]: { amount: '120000,50', currency: 'pln' },
    });

    expect(saved[tekst.id]).toBe('UR/2026/14');
    expect(saved[liczba.id]).toBe(42);
    expect(saved[kwota.id]).toEqual({ amount: 120000.5, currency: 'PLN' });
  });

  test.each([
    ['liczba z tekstu nieliczbowego', 'number', {}, 'abc'],
    ['data w złym formacie', 'date', {}, '10-05-2026'],
    ['kwota bez waluty ISO', 'money', {}, { amount: 5, currency: 'zloty' }],
    ['kwota bez liczby', 'money', {}, { amount: 'dużo', currency: 'PLN' }],
    ['wartość spoza listy', 'list', { options: ['A', 'B'] }, 'Z'],
  ])('odrzuca: %s', async (_opis, fieldType, extra, value) => {
    const field = await makeField('lead', `Pole ${fieldType} ${_opis}`, fieldType, extra.options);
    await expect(svc.buildCustomValues(tenantId, 'lead', { [field.id]: value }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('komunikat błędu nazywa pole, którego dotyczy', async () => {
    const field = await makeField('lead', 'Data audytu', 'date');
    await expect(svc.buildCustomValues(tenantId, 'lead', { [field.id]: 'wczoraj' }))
      .rejects.toThrow(/Data audytu/);
  });

  test('pusta wartość czyści pole, a nie zapisuje pustki', async () => {
    const field = await makeField('lead', 'Umowa', 'text');
    const istniejace = { [field.id]: 'UR/1' };
    expect(await svc.buildCustomValues(tenantId, 'lead', { [field.id]: '' }, istniejace)).toEqual({});
    expect(await svc.buildCustomValues(tenantId, 'lead', { [field.id]: null }, istniejace)).toEqual({});
    // Same spacje też są pustą wartością, nie tekstem.
    expect(await svc.buildCustomValues(tenantId, 'lead', { [field.id]: '   ' }, istniejace)).toEqual({});
  });

  test('pola z innej formatki nie dają się zapisać na tym rekordzie', async () => {
    const naPartnerze = await makeField('partner', 'Limit', 'number');
    const wynik = await svc.buildCustomValues(tenantId, 'lead', { [naPartnerze.id]: 5 });
    expect(wynik).toEqual({});
  });
});

describe('zmiana żądania nie niszczy tego, co już jest', () => {
  test('wysłanie jednego pola nie kasuje pozostałych', async () => {
    const a = await makeField('lead', 'A', 'text');
    const b = await makeField('lead', 'B', 'text');
    const istniejace = { [a.id]: 'pierwsze', [b.id]: 'drugie' };

    const wynik = await svc.buildCustomValues(tenantId, 'lead', { [a.id]: 'zmienione' }, istniejace);
    expect(wynik).toEqual({ [a.id]: 'zmienione', [b.id]: 'drugie' });
  });

  test('nieznany klucz jest pomijany, a nie wywala zapisu', async () => {
    const a = await makeField('lead', 'A', 'text');
    const wynik = await svc.buildCustomValues(tenantId, 'lead', {
      [a.id]: 'ok', '00000000-0000-0000-0000-000000000000': 'duch',
    });
    expect(wynik).toEqual({ [a.id]: 'ok' });
  });

  test('brak pola custom_values w żądaniu zwraca null — wołający pomija kolumnę', async () => {
    expect(await svc.buildCustomValues(tenantId, 'lead', undefined)).toBeNull();
    expect(await svc.buildCustomValues(tenantId, 'lead', null)).toBeNull();
  });

  test('tablica zamiast obiektu jest odrzucana', async () => {
    await expect(svc.buildCustomValues(tenantId, 'lead', ['a', 'b']))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe('dezaktywacja ukrywa pole, ale nie kasuje danych', () => {
  test('wartość nieaktywnego pola zostaje na rekordzie', async () => {
    const field = await makeField('partner', 'Segment', 'list', ['A', 'B']);
    const zapisane = await svc.buildCustomValues(tenantId, 'partner', { [field.id]: 'B' });
    expect(zapisane[field.id]).toBe('B');

    await svc.updateDefinition(tenantId, field.id, { is_active: false });

    // Kolejny zapis innych pól nie może zgubić wartości ukrytego pola.
    const poDezaktywacji = await svc.buildCustomValues(tenantId, 'partner', {}, zapisane);
    expect(poDezaktywacji[field.id]).toBe('B');
  });

  test('nieaktywne pole znika z tego, co dostaje formatka', async () => {
    const widoczne = await makeField('partner', 'Widoczne', 'text');
    const ukryte = await makeField('partner', 'Ukryte', 'text');
    await svc.updateDefinition(tenantId, ukryte.id, { is_active: false });

    const opis = await svc.describeValues(tenantId, 'partner', {
      [widoczne.id]: 'tak', [ukryte.id]: 'schowane',
    });
    expect(opis.map((d) => d.name)).toEqual(['Widoczne']);
    expect(opis[0].value).toBe('tak');
  });

  test('admin widzi też nieaktywne pola, formatka nie', async () => {
    const field = await makeField('lead', 'Wyłączone', 'text');
    await svc.updateDefinition(tenantId, field.id, { is_active: false });

    expect((await svc.listDefinitions(tenantId, 'lead')).length).toBe(1);
    expect((await svc.listDefinitions(tenantId, 'lead', { activeOnly: true })).length).toBe(0);
  });
});

describe('definicje', () => {
  test('typu pola nie da się zmienić — nie ma go wśród zmienianych pól', async () => {
    const field = await makeField('lead', 'Kwota', 'money');
    const po = await svc.updateDefinition(tenantId, field.id, { name: 'Kwota netto' });
    expect(po.field_type).toBe('money');
    expect(po.name).toBe('Kwota netto');
  });

  test('pole typu lista wymaga wartości, inne typy ich nie dostają', async () => {
    await expect(makeField('lead', 'Pusta lista', 'list', [])).rejects.toMatchObject({ status: 400 });
    const tekst = await makeField('lead', 'Zwykły tekst', 'text', ['ignorowane']);
    expect(tekst.options).toEqual([]);
  });

  test('duplikaty w opcjach listy są scalane', async () => {
    const field = await makeField('lead', 'Segment', 'list', ['A', ' A ', 'B', '']);
    expect(field.options).toEqual(['A', 'B']);
  });

  test('zmiana kolejności zapisuje nowe sort_order', async () => {
    const a = await makeField('lead', 'A', 'text');
    const b = await makeField('lead', 'B', 'text');
    const c = await makeField('lead', 'C', 'text');

    const po = await svc.reorderDefinitions(tenantId, 'lead', [c.id, a.id, b.id]);
    expect(po.map((d) => d.name)).toEqual(['C', 'A', 'B']);
  });

  test('nieznane pole przy aktualizacji daje 404', async () => {
    await expect(svc.updateDefinition(tenantId, '00000000-0000-0000-0000-000000000000', { name: 'X' }))
      .rejects.toMatchObject({ status: 404 });
  });
});
