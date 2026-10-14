'use strict';

// pushCrmScopeCondition — trzy stany zakresu CRM managera.
//
// Incydent, który to wywołał: na produkcji manager sprzedaży z włączonym
// `crm_global_read` nie widział ANI JEDNEGO leada. loadCrmScope ustawia wtedy
// scope = null („bez ograniczeń"), a każde miejsce w trasach sprawdzało
// `if (scope && scope.length > 0)` — null nie spełniał warunku i wpadał w gałąź
// „pusty zakres", czyli `1=0`. Globalny odczyt, zamiast dać dostęp do
// wszystkiego, odbierał wszystko.
//
// Bez bazy — to czysta funkcja budująca fragment WHERE.

const { pushCrmScopeCondition } = require('../middleware/crm-rbac');

const run = (scope, column = 'l.assigned_to', startParams = []) => {
  const params = [...startParams];
  const conds = [];
  pushCrmScopeCondition(scope, column, params, conds);
  return { params, conds };
};

describe('null = brak ograniczeń', () => {
  test('nie dokłada żadnego warunku ani parametru', () => {
    expect(run(null)).toEqual({ params: [], conds: [] });
  });

  test('undefined traktujemy tak samo — trasa bez loadCrmScope nie może nagle wszystkiego zablokować', () => {
    expect(run(undefined)).toEqual({ params: [], conds: [] });
  });

  test('NIE generuje 1=0 — to był właśnie błąd', () => {
    expect(run(null).conds).not.toContain('1=0');
  });
});

describe('niepusta tablica = widzi tych userów', () => {
  test('dokłada warunek ANY z poprawnym numerem parametru', () => {
    const { params, conds } = run(['u1', 'u2']);
    expect(params).toEqual([['u1', 'u2']]);
    expect(conds).toEqual(['l.assigned_to = ANY($1::uuid[])']);
  });

  test('numeruje parametr po tych, które już są w zapytaniu', () => {
    const { params, conds } = run(['u1'], 'p.manager_id', ['tenant', 'foo']);
    expect(params).toHaveLength(3);
    expect(conds).toEqual(['p.manager_id = ANY($3::uuid[])']);
  });

  test('działa z wyrażeniem COALESCE jako kolumną', () => {
    const { conds } = run(['u1'], 'COALESCE(a.assigned_to, l.assigned_to)');
    expect(conds).toEqual(['COALESCE(a.assigned_to, l.assigned_to) = ANY($1::uuid[])']);
  });
});

describe('pusta tablica = nie widzi nikogo', () => {
  test('dokłada 1=0 i nie dodaje parametru', () => {
    expect(run([])).toEqual({ params: [], conds: ['1=0'] });
  });
});
