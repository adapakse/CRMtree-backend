'use strict';

// calcIcpScore() i getIcpScoringRules() — po podniesieniu wagi dzial_handlowy
// z 10 do 15 pkt (decyzja 18.09), żeby maksymalny możliwy icp_score wynosił
// równo 100 (65+20+10=95 -> 70+20+10=100). Nie testuje blacklisty/wag innych
// sygnałów/bramek/bonusów — te celowo zostały bez zmian.

const svc = require('../services/prospectEnrichmentService');

describe('calcIcpScore — waga dzial_handlowy podniesiona do 15 pkt', () => {
  test('field_sales_team=true samodzielnie daje 15 pkt', () => {
    const result = svc.calcIcpScore({ field_sales_team: true });
    expect(result.raw).toBe(15);
  });

  test('maxPossible (suma wag sygnałów) wynosi 70, nie 65', () => {
    const result = svc.calcIcpScore({});
    expect(result.maxPossible).toBe(70);
  });

  test('wszystkie 8 sygnałów true daje raw=70 (15+10+10+10+10+5+5+5)', () => {
    const result = svc.calcIcpScore({
      field_sales_team: true,
      custom_quote_process: true,
      consultation_demo_needs_analysis: true,
      dedicated_customer_care_b2b: true,
      tender_bidding_department: true,
      distributed_sales_structure: true,
      partner_dealer_network: true,
      ecommerce_b2b: true, // requiresAnyOf spełnione przez field_sales_team
    });
    expect(result.raw).toBe(70);
  });
});

describe('getIcpScoringRules — max_possible_score == 100', () => {
  // tenant_id nieistniejący celowo — loadIcpBlacklistSettings() dla braku
  // wiersza w app_settings wraca do domyślnych wartości, nie wymaga realnego
  // tenanta ani nie dotyka danych żadnego prawdziwego klienta.
  const FAKE_TENANT_ID = '00000000-0000-0000-0000-000000000000';

  test('field_sales_team ma wagę 15 w definicjach sygnałów', async () => {
    const rules = await svc.getIcpScoringRules(FAKE_TENANT_ID);
    const def = rules.signals.definitions.find(d => d.id === 'dzial_handlowy');
    expect(def.points).toBe(15);
  });

  test('max_possible_score wynosi dokładnie 100', async () => {
    const rules = await svc.getIcpScoringRules(FAKE_TENANT_ID);
    expect(rules.max_possible_score).toBe(100);
  });
});
