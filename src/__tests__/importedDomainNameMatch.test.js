'use strict';

// Rule (2026-11-23): a website address given in the import file is confirmed when
// the company name appears in the page title, the page has real content and no
// conflict was found. Guessed domains keep the two-signal rule.

const { evaluateImportedDomainNameMatch } = require('../services/prospectEnrichmentService');

const LONG_TEXT = 'Producent okien dachowych i schodów strychowych. '.repeat(20);

function insufficientEvidence(overrides = {}) {
  return {
    verified: false,
    reason: 'insufficient_evidence',
    evidence: { name_hit: true, company_name: 'Fakro- Wdf sp. z o.o.', ...overrides },
  };
}

function page(overrides = {}) {
  return { text: LONG_TEXT, identity: { title: 'Okna dachowe i schody strychowe | FAKRO', h1: '' }, ...overrides };
}

function evaluate({ identityCheck = insufficientEvidence(), websiteSource = 'csv_import', scraped = page() } = {}) {
  return evaluateImportedDomainNameMatch({ identityCheck, websiteSource, scraped });
}

describe('evaluateImportedDomainNameMatch', () => {
  test('confirms an imported address when the company name is in the title', () => {
    expect(evaluate()).toEqual({ verified: true, reason: 'imported_domain_name_match' });
  });

  test.each(['resolver', 'manual_correction', null])('does not apply to a %s address', (websiteSource) => {
    expect(evaluate({ websiteSource }).verified).toBe(false);
  });

  test('does not apply without a name match', () => {
    expect(evaluate({ identityCheck: insufficientEvidence({ name_hit: false }) }).verified).toBe(false);
  });

  test.each([
    'legal_entity_conflict', 'foreign_address_conflict', 'foreign_entity_or_country_conflict', 'different_entity_brand',
  ])('never overrides %s', (reason) => {
    expect(evaluate({ identityCheck: { ...insufficientEvidence(), reason } }).verified).toBe(false);
  });

  test('requires a distinctive name, not a three-letter one', () => {
    expect(evaluate({ identityCheck: insufficientEvidence({ company_name: 'Its. sp. z o.o.' }) }).verified).toBe(false);
  });

  test('requires real page content', () => {
    expect(evaluate({ scraped: page({ text: 'Witamy na stronie' }) }).verified).toBe(false);
  });

  test('rejects a page that failed deterministically', () => {
    expect(evaluate({ scraped: page({ deterministicFailure: { type: 'domain_parking' } }) }).verified).toBe(false);
  });

  test.each([
    'fakro.pl | 520: Web server is returning an unknown error',
    'FAKRO – Nothing Found',
    'Strona w budowie – Fakro',
    'Oferta domeny fakro.pl',
  ])('rejects a title that is not a company page: %s', (title) => {
    expect(evaluate({ scraped: page({ identity: { title, h1: '' } }) }).verified).toBe(false);
  });
});
