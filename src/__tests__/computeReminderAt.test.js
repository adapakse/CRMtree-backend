'use strict';
//
// computeReminderAt — wyliczenie momentu przypomnienia z terminu zadania
// (activity_at) i typu przypomnienia. Ta sama logika w crm-leads.js i
// crm-partners.js (kopia, jak w worktrips).

// Kopia funkcji pod test (route'y jej nie eksportują).
function computeReminderAt(activity_at, reminder_type, reminder_at_custom) {
  if (!activity_at || !reminder_type || reminder_type === 'none') return null;
  const due = new Date(activity_at);
  if (isNaN(due.getTime())) return null;
  if (reminder_type === 'custom') {
    if (!reminder_at_custom) return null;
    const c = new Date(reminder_at_custom);
    return isNaN(c.getTime()) ? null : c.toISOString();
  }
  const d = new Date(due);
  if      (reminder_type === 'at_due')     { /* w terminie */ }
  else if (reminder_type === '30m_before') d.setMinutes(d.getMinutes() - 30);
  else if (reminder_type === '1h_before')  d.setHours(d.getHours() - 1);
  else if (reminder_type === '1d_before')  d.setDate(d.getDate() - 1);
  else if (reminder_type === '2d_before')  d.setDate(d.getDate() - 2);
  else if (reminder_type === '3d_before')  d.setDate(d.getDate() - 3);
  else return null;
  return d.toISOString();
}

const DUE = '2026-09-10T14:00:00.000Z';

describe('computeReminderAt', () => {
  test('brak terminu → null', () => {
    expect(computeReminderAt(null, '1d_before')).toBeNull();
    expect(computeReminderAt('', '1d_before')).toBeNull();
  });
  test('brak / pusty / "none" typ → null', () => {
    expect(computeReminderAt(DUE, null)).toBeNull();
    expect(computeReminderAt(DUE, '')).toBeNull();
    expect(computeReminderAt(DUE, 'none')).toBeNull();
  });
  test('nieznany typ → null', () => {
    expect(computeReminderAt(DUE, 'garbage')).toBeNull();
  });
  test('at_due → dokładnie termin', () => {
    expect(computeReminderAt(DUE, 'at_due')).toBe('2026-09-10T14:00:00.000Z');
  });
  test('30m_before', () => {
    expect(computeReminderAt(DUE, '30m_before')).toBe('2026-09-10T13:30:00.000Z');
  });
  test('1h_before', () => {
    expect(computeReminderAt(DUE, '1h_before')).toBe('2026-09-10T13:00:00.000Z');
  });
  test('1d_before', () => {
    expect(computeReminderAt(DUE, '1d_before')).toBe('2026-09-09T14:00:00.000Z');
  });
  test('2d_before', () => {
    expect(computeReminderAt(DUE, '2d_before')).toBe('2026-09-08T14:00:00.000Z');
  });
  test('3d_before', () => {
    expect(computeReminderAt(DUE, '3d_before')).toBe('2026-09-07T14:00:00.000Z');
  });
  test('custom → podana data', () => {
    expect(computeReminderAt(DUE, 'custom', '2026-09-05T09:00:00.000Z'))
      .toBe('2026-09-05T09:00:00.000Z');
  });
  test('custom bez daty → null', () => {
    expect(computeReminderAt(DUE, 'custom', null)).toBeNull();
  });
  test('niepoprawny activity_at → null', () => {
    expect(computeReminderAt('nie-data', '1d_before')).toBeNull();
  });
});
