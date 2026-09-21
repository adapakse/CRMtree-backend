'use strict';

// Fallback company_size z LinkedIn JSON-LD (21.09) — DETERMINISTYCZNE
// parsowanie schema.org Organization.numberOfEmployees, z danych już i tak
// pobranych w istniejącym flow (opts.processLinkedin, tylko ręczny re-process,
// nigdy w batchu) — zero dodatkowego requestu wyłącznie po zatrudnienie.
// Priorytet: import (employment_count/employment_range) zawsze pierwszy,
// LinkedIn tylko gdy import nie dał NIC. Próg pozostaje bez zmian —
// parseNumberOfEmployees() tylko DOSTARCZA wejście do istniejącego,
// niezmienionego calcCompanySizeGate()/buildIcpGates().

const svc = require('../services/prospectEnrichmentService');

describe('parseNumberOfEmployees — schema.org QuantitativeValue', () => {
  test('dokładna liczba (.value) -> {count, range:null}', () => {
    expect(svc.parseNumberOfEmployees({ value: 500 })).toEqual({ count: 500, range: null });
  });

  test('.value jako string liczbowy również działa', () => {
    expect(svc.parseNumberOfEmployees({ value: '250' })).toEqual({ count: 250, range: null });
  });

  test('przedział (.minValue/.maxValue) -> {count:null, range}', () => {
    expect(svc.parseNumberOfEmployees({ minValue: 501, maxValue: 1000 })).toEqual({ count: null, range: '501-1000' });
  });

  test('tylko .minValue (otwarty górny koniec) -> range z "?"', () => {
    expect(svc.parseNumberOfEmployees({ minValue: 1000 })).toEqual({ count: null, range: '1000-?' });
  });

  test('tylko .maxValue -> range z "?" na dole', () => {
    expect(svc.parseNumberOfEmployees({ maxValue: 49 })).toEqual({ count: null, range: '?-49' });
  });

  test('.value ma pierwszeństwo nad .minValue/.maxValue, jeśli oba obecne (nietypowe, ale bezpieczne)', () => {
    expect(svc.parseNumberOfEmployees({ value: 30, minValue: 20, maxValue: 49 })).toEqual({ count: 30, range: null });
  });

  test('brak pola / puste / nieliczbowe -> {count:null, range:null}, nie zgaduje', () => {
    expect(svc.parseNumberOfEmployees(null)).toEqual({ count: null, range: null });
    expect(svc.parseNumberOfEmployees(undefined)).toEqual({ count: null, range: null });
    expect(svc.parseNumberOfEmployees({})).toEqual({ count: null, range: null });
    expect(svc.parseNumberOfEmployees({ value: 'kilkuset' })).toEqual({ count: null, range: null });
    expect(svc.parseNumberOfEmployees('500')).toEqual({ count: null, range: null }); // nie obiekt QuantitativeValue
  });
});

describe('Priorytet źródeł employment — import zawsze pierwszy przed LinkedIn (przez buildIcpGates)', () => {
  // Testuje samą regułę priorytetu tak, jak jest zaimplementowana w enrichOne:
  // hasImportEmployment ? import : linkedin. Bo buildIcpGates/calcCompanySizeGate
  // same w sobie są niezmienione (już przetestowane w companySizeGate.test.js) —
  // tu sprawdzamy tylko, że WEJŚCIE do bramki jest poprawnie wybierane.
  function pickEmploymentInput(company, linkedinEmploymentCount, linkedinEmploymentRange) {
    const hasImport = company.employment_count != null || company.employment_range != null;
    const hasLinkedin = linkedinEmploymentCount != null || linkedinEmploymentRange != null;
    return {
      count: hasImport ? company.employment_count : linkedinEmploymentCount,
      range: hasImport ? company.employment_range : linkedinEmploymentRange,
      source: hasImport ? 'import' : (hasLinkedin ? 'linkedin_jsonld' : 'none'),
    };
  }

  test('import ma dane -> LinkedIn ignorowany, nawet jeśli też ma dane', () => {
    const result = pickEmploymentInput({ employment_count: 20, employment_range: null }, 500, null);
    expect(result).toEqual({ count: 20, range: null, source: 'import' });
  });

  test('import pusty, LinkedIn ma dokładną liczbę -> LinkedIn użyty jako fallback', () => {
    const result = pickEmploymentInput({ employment_count: null, employment_range: null }, 250, null);
    expect(result).toEqual({ count: 250, range: null, source: 'linkedin_jsonld' });
  });

  test('import pusty, LinkedIn ma przedział -> przedział użyty', () => {
    const result = pickEmploymentInput({ employment_count: null, employment_range: null }, null, '501-1000');
    expect(result).toEqual({ count: null, range: '501-1000', source: 'linkedin_jsonld' });
  });

  test('oba puste -> source "none", gate i tak da unknown (bez zmian w calcCompanySizeGate)', () => {
    const result = pickEmploymentInput({ employment_count: null, employment_range: null }, null, null);
    expect(result).toEqual({ count: null, range: null, source: 'none' });
    expect(svc.calcCompanySizeGate(result.count, result.range)).toBe('unknown');
  });

  test('import ma TYLKO employment_range (bez count) -> nadal liczy się jako "ma import", LinkedIn nie użyty', () => {
    const result = pickEmploymentInput({ employment_count: null, employment_range: '20-49 osób' }, 999, null);
    expect(result).toEqual({ count: null, range: '20-49 osób', source: 'import' });
  });

  test('end-to-end: fallback LinkedIn faktycznie daje inny werdykt bramki niż "unknown"', () => {
    const noImport = { employment_count: null, employment_range: null };
    const withoutFallback = pickEmploymentInput(noImport, null, null);
    const withFallback = pickEmploymentInput(noImport, 500, null);
    expect(svc.calcCompanySizeGate(withoutFallback.count, withoutFallback.range)).toBe('unknown');
    expect(svc.calcCompanySizeGate(withFallback.count, withFallback.range)).toBe('pass');
  });
});
