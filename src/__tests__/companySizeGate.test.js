// Bramka company_size jest deterministyczna: liczona w backendzie z
// employment_count (dane z importu), nigdy z odpowiedzi AI. Audyt Alior Bank
// (20.09): rekord bez employment_count dostawał od DeepSeek company_size="pass"
// 3/3 razy mimo instrukcji "przy braku danych zwróć unknown".

const {
  calcCompanySizeGate, buildIcpGates, icpGateStatus, calcIcpGatePoints,
} = require('../services/prospectEnrichmentService');

describe('calcCompanySizeGate — reguła deterministyczna', () => {
  test('14 → fail', () => expect(calcCompanySizeGate(14)).toBe('fail'));
  test('15 → pass (granica włącznie)', () => expect(calcCompanySizeGate(15)).toBe('pass'));
  test('100 → pass', () => expect(calcCompanySizeGate(100)).toBe('pass'));
  test('null → unknown', () => expect(calcCompanySizeGate(null)).toBe('unknown'));
  test('brak pola (undefined) → unknown', () => expect(calcCompanySizeGate(undefined)).toBe('unknown'));
  test('wywołanie bez argumentu → unknown', () => expect(calcCompanySizeGate()).toBe('unknown'));

  test('liczba jako string z bazy/CSV ("20") → pass, ("9") → fail', () => {
    expect(calcCompanySizeGate('20')).toBe('pass');
    expect(calcCompanySizeGate(' 9 ')).toBe('fail');
  });

  test.each([
    ['pusty string', ''],
    ['same spacje', '   '],
    ['tekst', 'abc'],
    ['tekst z liczbą, ale bez struktury zakresu', 'około dwudziestu'],
    ['odwrócony zakres', '49-20'],
    ['zakres z brakującą górną granicą', '10-'],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['liczba ujemna (niepoprawna dana)', -5],
    ['boolean', true],
    ['obiekt', {}],
    ['tablica', [20]],
  ])('niepoprawna wartość (%s) → unknown, nie fail', (_label, value) => {
    expect(calcCompanySizeGate(value)).toBe('unknown');
  });

  test('0 to poprawna liczba mniejsza niż 15 → fail', () => {
    expect(calcCompanySizeGate(0)).toBe('fail');
  });
});

// Zatrudnienie z importu bywa ZAKRESEM. Dolna granica przedziału NIE jest dokładną
// liczbą, a wartość ze środka zakresu nie jest zgadywana:
//   cały przedział < 15 → fail, cały >= 15 → pass, przecina próg → unknown.
describe('calcCompanySizeGate — zakresy zatrudnienia', () => {
  test.each([
    ['1-9', 'fail'],
    ['10-19', 'unknown'],
    ['20-49', 'pass'],
    ['50-99', 'pass'],
    ['250+', 'pass'],
    ['14', 'fail'],
    ['15', 'pass'],
    ['5-14', 'fail'],
    ['15-19', 'pass'],
    ['5-15', 'unknown'],
    ['14-15', 'unknown'],
    ['20-49 osób', 'pass'],
    ['100-249 osób', 'pass'],
    ['500-999 osób', 'pass'],
    ['powyżej 1000 osób', 'pass'],
    ['ponad 14', 'pass'],
    ['powyżej 14 osób', 'pass'],
    ['do 9', 'fail'],
    ['do 15', 'unknown'],
    ['poniżej 15', 'fail'],
    ['poniżej 16', 'unknown'],
    ['10–19', 'unknown'],
    ['10 - 19', 'unknown'],
    ['od 10 do 19', 'unknown'],
    ['od 20 do 49', 'pass'],
    ['10+', 'unknown'],
    ['15+', 'pass'],
    ['10 000+', 'pass'],
    ['1 000', 'pass'],
  ])('zakres/wartość "%s" → %s', (raw, expected) => {
    expect(calcCompanySizeGate(raw)).toBe(expected);
    expect(calcCompanySizeGate(null, raw)).toBe(expected);
  });

  test('null → unknown (także przy pustym zakresie)', () => {
    expect(calcCompanySizeGate(null, null)).toBe('unknown');
    expect(calcCompanySizeGate(undefined, undefined)).toBe('unknown');
    expect(calcCompanySizeGate(null, '')).toBe('unknown');
  });

  test('zakres (employment_range) ma pierwszeństwo przed dolną granicą w employment_count', () => {
    // employment_count=10 to dolna granica "10-19" — nie wolno jej traktować jak dokładnej liczby.
    expect(calcCompanySizeGate(10, '10-19')).toBe('unknown');
    // employment_count=20 to dolna granica "20-49" — zakres w całości >= 15.
    expect(calcCompanySizeGate(20, '20-49')).toBe('pass');
    expect(calcCompanySizeGate(1, '1-9')).toBe('fail');
    // zakres wygrywa nawet, gdyby count był niespójny
    expect(calcCompanySizeGate(100, '10-19')).toBe('unknown');
  });

  test('nieparsowalny zakres → fallback na employment_count jako dokładną liczbę (rekordy sprzed zapisu zakresu)', () => {
    expect(calcCompanySizeGate(20, 'brak danych')).toBe('pass');
    expect(calcCompanySizeGate(10, 'brak danych')).toBe('fail');
    expect(calcCompanySizeGate(null, 'brak danych')).toBe('unknown');
  });

  test('nie zgaduje wartości ze środka zakresu (10-19 nie staje się 14/15)', () => {
    expect(calcCompanySizeGate('10-19')).toBe('unknown');
    expect(calcCompanySizeGate('11-18')).toBe('unknown');
  });
});

describe('buildIcpGates — zakresy i AI', () => {
  test('AI mówi pass przy 10-19 → finalnie unknown', () => {
    const gates = buildIcpGates({ b2b: 'pass', company_size: 'pass' }, 10, '10-19');
    expect(gates.company_size).toBe('unknown');
    expect(icpGateStatus(gates)).toBe('needs_review');
    expect(calcIcpGatePoints(gates).points).toBe(10);
  });

  test('AI mówi fail przy 20-49 → finalnie pass', () => {
    const gates = buildIcpGates({ b2b: 'pass', company_size: 'fail' }, 20, '20-49');
    expect(gates.company_size).toBe('pass');
    expect(icpGateStatus(gates)).toBe('qualified');
  });

  test('AI mówi pass przy 1-9 → finalnie fail i disqualified', () => {
    const gates = buildIcpGates({ b2b: 'pass', company_size: 'pass' }, 1, '1-9');
    expect(gates.company_size).toBe('fail');
    expect(icpGateStatus(gates)).toBe('disqualified');
  });

  test('AI pass, brak zatrudnienia → unknown (bez regresji względem poprzedniej wersji)', () => {
    expect(buildIcpGates({ b2b: 'pass', company_size: 'pass' }, null, null).company_size).toBe('unknown');
  });
});

describe('getIcpScoringRules — Inspekcja mówi, skąd jest company_size', () => {
  const svc = require('../services/prospectEnrichmentService');
  const FAKE_TENANT_ID = '00000000-0000-0000-0000-000000000000';

  test('note wprost opisuje regułę: minimum 15, employment_count, zakres przecinający próg = unknown', async () => {
    const rules = await svc.getIcpScoringRules(FAKE_TENANT_ID);
    expect(rules.gates.note).toMatch(/company_size: minimum 15 pracowników/);
    expect(rules.gates.note).toMatch(/employment_count/);
    expect(rules.gates.note).toMatch(/zakres przecinający próg 15 \(np\. 10-19\) = unknown/);
  });

  test('definicja company_size ma źródło "backend" i próg 15, b2b ma źródło AI', async () => {
    const rules = await svc.getIcpScoringRules(FAKE_TENANT_ID);
    const size = rules.gates.definitions.find(d => d.id === 'company_size');
    const b2b = rules.gates.definitions.find(d => d.id === 'b2b');
    expect(size.source).toMatch(/backend/);
    expect(size.threshold).toBe(15);
    expect(b2b.source).toMatch(/AI/);
  });
});

describe('buildIcpGates — AI nie może nadpisać company_size', () => {
  test('AI mówi pass przy null → końcowo unknown (case Alior Bank)', () => {
    const gates = buildIcpGates({ b2b: 'pass', company_size: 'pass' }, null);
    expect(gates.company_size).toBe('unknown');
  });

  test('AI mówi fail przy 100 → końcowo pass', () => {
    const gates = buildIcpGates({ b2b: 'pass', company_size: 'fail' }, 100);
    expect(gates.company_size).toBe('pass');
  });

  test('AI mówi pass przy 14 → końcowo fail', () => {
    expect(buildIcpGates({ b2b: 'pass', company_size: 'pass' }, 14).company_size).toBe('fail');
  });

  test('AI mówi unknown przy 50 → końcowo pass', () => {
    expect(buildIcpGates({ b2b: 'pass', company_size: 'unknown' }, 50).company_size).toBe('pass');
  });

  test('AI w ogóle nie zwróciło pola company_size → i tak wartość deterministyczna', () => {
    expect(buildIcpGates({ b2b: 'pass' }, 20).company_size).toBe('pass');
    expect(buildIcpGates({ b2b: 'pass' }, undefined).company_size).toBe('unknown');
  });

  test('AI w ogóle nie zwróciło obiektu gates (null/undefined/tablica/string) → deterministyczna wartość, b2b nieustawione', () => {
    for (const bad of [null, undefined, [], 'pass']) {
      const gates = buildIcpGates(bad, 30);
      expect(gates.company_size).toBe('pass');
      expect(gates.b2b).toBeUndefined();
    }
  });

  test('b2b zostaje dokładnie takie, jakie zwróciło AI (nietknięte) — każda z trzech wartości', () => {
    for (const b2b of ['pass', 'fail', 'unknown']) {
      expect(buildIcpGates({ b2b, company_size: 'pass' }, null).b2b).toBe(b2b);
    }
  });

  test('nie mutuje obiektu zwróconego przez AI', () => {
    const aiGates = { b2b: 'pass', company_size: 'pass' };
    buildIcpGates(aiGates, null);
    expect(aiGates).toEqual({ b2b: 'pass', company_size: 'pass' });
  });

  test('dodatkowe pola zwrócone przez AI nie znikają (tylko company_size jest nadpisywane)', () => {
    const gates = buildIcpGates({ b2b: 'pass', company_size: 'pass', extra: 'x' }, 100);
    expect(gates.extra).toBe('x');
  });
});

describe('przepływ: buildIcpGates → icpGateStatus / calcIcpGatePoints', () => {
  test('Alior: b2b=pass od AI, brak employment_count → needs_review, tylko 10 pkt za b2b (NIE qualified)', () => {
    const gates = buildIcpGates({ b2b: 'pass', company_size: 'pass' }, null);
    expect(icpGateStatus(gates)).toBe('needs_review');
    const points = calcIcpGatePoints(gates);
    expect(points.points).toBe(10);
    expect(points.breakdown.find(b => b.id === 'company_size').hit).toBe(false);
    expect(points.breakdown.find(b => b.id === 'b2b').hit).toBe(true);
  });

  test('b2b=pass, 100 pracowników → qualified, 20 pkt', () => {
    const gates = buildIcpGates({ b2b: 'pass', company_size: 'fail' }, 100);
    expect(icpGateStatus(gates)).toBe('qualified');
    expect(calcIcpGatePoints(gates).points).toBe(20);
  });

  test('b2b=pass, 14 pracowników → disqualified, 10 pkt, mimo że AI twierdziło pass', () => {
    const gates = buildIcpGates({ b2b: 'pass', company_size: 'pass' }, 14);
    expect(icpGateStatus(gates)).toBe('disqualified');
    expect(calcIcpGatePoints(gates).points).toBe(10);
  });

  test('b2b=fail, 100 pracowników → disqualified (b2b nadal działa jak wcześniej)', () => {
    const gates = buildIcpGates({ b2b: 'fail', company_size: 'pass' }, 100);
    expect(icpGateStatus(gates)).toBe('disqualified');
  });

  test('b2b=unknown, 100 pracowników → needs_review, 10 pkt tylko za rozmiar', () => {
    const gates = buildIcpGates({ b2b: 'unknown', company_size: 'pass' }, 100);
    expect(icpGateStatus(gates)).toBe('needs_review');
    expect(calcIcpGatePoints(gates).points).toBe(10);
  });
});
