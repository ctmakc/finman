// test/dates.test.js — lib/dates: дата в часовом поясе и перекат повторяющихся дат.
const dates = require('../lib/dates');

describe('lib/dates', () => {
  test('todayISO учитывает часовой пояс (вечер Торонто = завтра по UTC)', () => {
    // 2026-10-10T02:30Z = 2026-10-09 22:30 в Торонто (EDT, UTC-4).
    const now = new Date('2026-10-10T02:30:00Z');
    expect(dates.todayISO('UTC', now)).toBe('2026-10-10');
    expect(dates.todayISO('America/Toronto', now)).toBe('2026-10-09');
    expect(dates.todayISO('Europe/Kyiv', now)).toBe('2026-10-10');
  });

  test('невалидная зона -> дефолт, userTz читает users.timezone', () => {
    expect(dates.isValidTz('Mars/Olympus')).toBe(false);
    expect(dates.userTz({ timezone: 'Mars/Olympus' })).toBe(dates.DEFAULT_TZ);
    expect(dates.userTz({ timezone: 'Europe/Warsaw' })).toBe('Europe/Warsaw');
    expect(dates.userTz(null)).toBe(dates.DEFAULT_TZ);
    expect(typeof dates.todayISO('Mars/Olympus')).toBe('string');
  });

  test('rollForward: месячная серия из 2024 докатывается до первой даты >= today', () => {
    expect(dates.rollForward('2024-02-15', 'monthly', '2026-10-10')).toBe('2026-10-15');
    expect(dates.rollForward('2024-02-15', 'monthly', '2026-10-15')).toBe('2026-10-15');
    expect(dates.rollForward('2024-02-15', 'monthly', '2026-10-16')).toBe('2026-11-15');
  });

  test('rollForward: конец месяца прищепляется, anchorDay восстанавливает 31-е', () => {
    expect(dates.rollForward('2024-01-31', 'monthly', '2026-02-10')).toBe('2026-02-28');
    expect(dates.rollForward('2024-01-31', 'monthly', '2026-03-10', 31)).toBe('2026-03-31');
  });

  test('rollForward: недельная/двухнедельная/годовая/дневная', () => {
    // 2024-02-15 — четверг; 2026-10-15 — четверг.
    expect(dates.rollForward('2024-02-15', 'weekly', '2026-10-10')).toBe('2026-10-15');
    expect(dates.rollForward('2026-10-01', 'biweekly', '2026-10-10')).toBe('2026-10-15');
    expect(dates.rollForward('2023-12-01', 'yearly', '2026-10-10')).toBe('2026-12-01');
    expect(dates.rollForward('2026-10-01', 'daily', '2026-10-10')).toBe('2026-10-10');
    expect(dates.rollForward('2026-10-01', 'quarterly', '2026-10-10')).toBe('2027-01-01');
  });

  test('rollForward: будущая дата старта остаётся как есть', () => {
    expect(dates.rollForward('2026-10-12', 'weekly', '2026-10-10')).toBe('2026-10-12');
    expect(dates.rollForward(null, 'weekly', '2026-10-10')).toBeNull();
  });

  test('addDaysISO / addMonthsISO / diffDays / start|endOfMonth', () => {
    expect(dates.addDaysISO('2026-10-30', 3)).toBe('2026-11-02');
    expect(dates.addMonthsISO('2026-01-31', 1)).toBe('2026-02-28');
    expect(dates.diffDays('2026-10-10', '2026-10-15')).toBe(5);
    expect(dates.startOfMonthISO('2026-10-10')).toBe('2026-10-01');
    expect(dates.endOfMonthISO('2026-02-10')).toBe('2026-02-28');
  });
});
