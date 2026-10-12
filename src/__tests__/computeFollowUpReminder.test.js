'use strict';
//
// computeFollowUpReminder — reguła przypomnienia dla zadania follow-up
// z Analizatora rozmów (Adam, 12.10.2026):
//   termin za ≤3 dni  → przypomnienie w dniu terminu ('at_due')
//   termin za >3 dni  → przypomnienie dzień wcześniej ('1d_before')
//
// Punkt odniesienia: poniedziałek 2026-10-12.

const { computeFollowUpReminder } = require('../services/callAnalysisService');

const TODAY = new Date(2026, 9, 12); // 2026-10-12, poniedziałek
const r = (date) => computeFollowUpReminder(date, TODAY);

describe('computeFollowUpReminder — próg 3 dni', () => {
  test('termin dziś → at_due', () => {
    expect(r('2026-10-12')).toMatchObject({ reminderType: 'at_due', reminderAt: '2026-10-12T07:00:00Z' });
  });

  test('termin za 3 dni (granica włącznie) → at_due', () => {
    expect(r('2026-10-15')).toMatchObject({ reminderType: 'at_due', reminderAt: '2026-10-15T07:00:00Z' });
  });

  test('termin za 4 dni → 1d_before', () => {
    expect(r('2026-10-16')).toMatchObject({ reminderType: '1d_before', reminderAt: '2026-10-15T07:00:00Z' });
  });

  test('termin odległy → 1d_before', () => {
    expect(r('2026-11-16')).toMatchObject({ reminderType: '1d_before', reminderAt: '2026-11-15T07:00:00Z' });
  });

  test('termin w przeszłości → at_due (przypomnienie pójdzie przy najbliższym przebiegu joba)', () => {
    expect(r('2026-10-05')).toMatchObject({ reminderType: 'at_due', reminderAt: '2026-10-05T07:00:00Z' });
  });
});

describe('computeFollowUpReminder — termin zadania', () => {
  test('activity_at zawsze stoi na dacie follow-upu, 07:00 UTC', () => {
    expect(r('2026-10-16').activityAt).toBe('2026-10-16T07:00:00Z');
    expect(r('2026-10-13').activityAt).toBe('2026-10-13T07:00:00Z');
  });

  test('przypomnienie dzień wcześniej przeskakuje granicę miesiąca', () => {
    expect(r('2026-11-01')).toMatchObject({ reminderType: '1d_before', reminderAt: '2026-10-31T07:00:00Z' });
  });
});
