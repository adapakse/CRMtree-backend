'use strict';

// Monotonic identity resolution (21.09, po benchmarku 50 firm) — naprawia bug
// znaleziony w pełnym dryRun enrichOne(): identityCheck.verified===true
// ustawione przez strict fallback LUB V3 brand fallback było cicho gubione,
// gdy recompute na pełnym crawlu (computeIdentityCheck) nie widział TEGO
// SAMEGO dowodu (np. dowodowa podstrona odpadła przez global_12k_truncation —
// case PSE, albo dowód V3 w ogóle nie jest czymś co checkDomainIdentity umie
// wykryć — case Pepco/Kanał 6). Zasada: hard conflict > wcześniejsze verified
// > insufficient_evidence — sam brak dowodu nigdy nie cofa wcześniejszej
// weryfikacji, ale NOWY twardy dowód konfliktu zawsze wygrywa, niezależnie od
// tego co ustalił wcześniejszy etap.

const svc = require('../services/prospectEnrichmentService');

describe('resolveIdentityMonotonically — czysta funkcja', () => {
  test('wcześniejsze verified:true + recompute insufficient_evidence -> zostaje verified (nie downgrade)', () => {
    const previous = { verified: true, reason: 'brand_verified' };
    const next = { verified: false, reason: 'insufficient_evidence' };
    expect(svc.resolveIdentityMonotonically(previous, next)).toBe(previous);
  });

  test('wcześniejsze verified:true (strict fallback) + recompute insufficient_evidence -> zostaje verified (case PSE)', () => {
    const previous = { verified: true, reason: 'strong_registry_address' };
    const next = { verified: false, reason: 'insufficient_evidence' };
    expect(svc.resolveIdentityMonotonically(previous, next)).toBe(previous);
  });

  test('wcześniejsze verified:true + recompute znajduje foreign_address_conflict -> hard conflict wygrywa, downgrade', () => {
    const previous = { verified: true, reason: 'name_plus_registry_address' };
    const next = { verified: false, reason: 'foreign_address_conflict' };
    expect(svc.resolveIdentityMonotonically(previous, next)).toBe(next);
  });

  test.each(['foreign_address_conflict', 'legal_entity_conflict', 'foreign_entity_or_country_conflict', 'different_entity_brand'])(
    'każdy hard conflict reason (%s) wygrywa nad wcześniejszym verified:true', (reason) => {
      const previous = { verified: true, reason: 'brand_verified' };
      const next = { verified: false, reason };
      expect(svc.resolveIdentityMonotonically(previous, next)).toBe(next);
    }
  );

  test('wcześniejsze niezweryfikowane + recompute insufficient_evidence -> zostaje niezweryfikowane (bez zmian)', () => {
    const previous = { verified: false, reason: 'insufficient_evidence' };
    const next = { verified: false, reason: 'insufficient_evidence' };
    expect(svc.resolveIdentityMonotonically(previous, next)).toBe(next);
  });

  test('wcześniejsze niezweryfikowane + recompute znajduje mocny dowód pozytywny -> przyjmuje nowy pozytywny wynik', () => {
    const previous = { verified: false, reason: 'insufficient_evidence' };
    const next = { verified: true, reason: 'nip_match' };
    expect(svc.resolveIdentityMonotonically(previous, next)).toBe(next);
  });

  test('hard conflict wygrywa NAWET gdy previous też było niezweryfikowane (nie tylko przy downgrade z verified)', () => {
    const previous = { verified: false, reason: 'insufficient_evidence' };
    const next = { verified: false, reason: 'legal_entity_conflict' };
    expect(svc.resolveIdentityMonotonically(previous, next)).toBe(next);
  });

  test('nie ma drogi do utrzymania błędnego verified: hard conflict override działa niezależnie od reason poprzedniego verified', () => {
    // Sprawdzenie explicite proszone przez usera: żaden wariant "previous.reason"
    // (dowolny pozytywny powód weryfikacji) nie blokuje przejścia hard conflict.
    const positiveReasons = ['nip_match', 'krs_match', 'regon_match', 'strong_registry_address', 'name_plus_registry_address', 'brand_verified'];
    for (const reason of positiveReasons) {
      const previous = { verified: true, reason };
      const next = { verified: false, reason: 'foreign_address_conflict' };
      expect(svc.resolveIdentityMonotonically(previous, next)).toBe(next);
    }
  });
});

describe('HARD_IDENTITY_CONFLICT_REASONS', () => {
  test('zawiera dokładnie te 4 powody', () => {
    expect([...svc.HARD_IDENTITY_CONFLICT_REASONS].sort()).toEqual(
      ['different_entity_brand', 'foreign_address_conflict', 'foreign_entity_or_country_conflict', 'legal_entity_conflict'].sort()
    );
  });

  test('insufficient_evidence NIE jest hard conflict', () => {
    expect(svc.HARD_IDENTITY_CONFLICT_REASONS.has('insufficient_evidence')).toBe(false);
  });
});
