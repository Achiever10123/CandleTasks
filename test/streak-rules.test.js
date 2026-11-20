const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../streak-rules.js');

const MON = '2026-11-16', TUE = '2026-11-17', WED = '2026-11-18', THU = '2026-11-19', FRI = '2026-11-20';
const mk = (o = {}) => ({ count: 5, lastCompletedDate: MON, freezes: 1, frozenDates: [], best: 5, ...o });

test('grace is 1 free missed day, then each further missed day costs a freeze', () => {
  assert.equal(R.GRACE_DAYS, 1);
  const s = mk();
  let e = R.evaluate(s, MON); assert.deepEqual([e.alive, e.missed, e.freezes, e.graceUsed], [true, 0, 1, false]);
  e = R.evaluate(s, TUE);     assert.deepEqual([e.alive, e.missed, e.freezes, e.graceUsed], [true, 0, 1, false]);  // today is not missed yet
  e = R.evaluate(s, WED);     assert.deepEqual([e.alive, e.missed, e.freezes, e.graceUsed, e.used], [true, 1, 1, true, 0]);  // Tue = grace day
  e = R.evaluate(s, THU);     assert.deepEqual([e.alive, e.missed, e.freezes, e.used], [true, 2, 0, 1]);        // Wed cost a freeze, shown straight away
  assert.deepEqual(e.frozenDays, [WED]);
  e = R.evaluate(s, FRI);     assert.deepEqual([e.alive, e.broken, e.count, e.freezes], [false, true, 0, 0]);   // out of freezes: reset
});
test('with no freezes the second missed day ends the streak', () => {
  const s = mk({ freezes: 0 });
  assert.equal(R.evaluate(s, WED).alive, true);
  const e = R.evaluate(s, THU);
  assert.deepEqual([e.alive, e.broken, e.count], [false, true, 0]);
});
test('several freezes cover several days in a row, the one after that breaks it', () => {
  const s = mk({ freezes: 3 });
  assert.deepEqual([R.evaluate(s, '2026-11-19').freezes, R.evaluate(s, '2026-11-20').freezes, R.evaluate(s, '2026-11-21').freezes], [2, 1, 0]);
  assert.equal(R.evaluate(s, '2026-11-21').alive, true);
  assert.equal(R.evaluate(s, '2026-11-22').broken, true);
});
test('completing after a freeze was used keeps the streak and records the frozen day', () => {
  const s = mk();
  const r = R.applyCompletion(s, THU);
  assert.deepEqual(r, { used: 1, reset: false, earned: false });
  assert.equal(s.count, 6); assert.equal(s.freezes, 0); assert.equal(s.lastCompletedDate, THU);
  assert.deepEqual(s.frozenDates, [WED]); assert.equal(s.best, 6);
});
test('completing after the streak ran out restarts at 1 with no freezes, and reports a reset (so no "freeze used" toast)', () => {
  const s = mk();
  const r = R.applyCompletion(s, FRI);
  assert.deepEqual(r, { used: 0, reset: true, earned: false });
  assert.equal(s.count, 1); assert.equal(s.freezes, 0); assert.deepEqual(s.frozenDates, []); assert.equal(s.best, 5);
});
test('the number of missed days beyond the freezes never leaks into "used"', () => {
  const s = mk({ freezes: 2 });
  const r = R.applyCompletion(s, '2026-11-30');           // 13 missed days
  assert.equal(r.used, 0); assert.equal(r.reset, true);
});
test('a freeze is earned on every 7th day, up to 3', () => {
  let s = mk({ count: 6, lastCompletedDate: WED, freezes: 1 });
  let r = R.applyCompletion(s, THU);
  assert.equal(s.count, 7); assert.equal(r.earned, true); assert.equal(s.freezes, 2);
  s = mk({ count: 13, lastCompletedDate: WED, freezes: 3 });
  r = R.applyCompletion(s, THU);
  assert.equal(s.count, 14); assert.equal(r.earned, false); assert.equal(s.freezes, 3);
});
test('a fresh start, no streak, and bad data are safe', () => {
  assert.deepEqual(R.evaluate({ count: 0, freezes: 2 }, FRI).alive, false);
  assert.equal(R.evaluate({ count: 0, freezes: 2 }, FRI).freezes, 2);
  const s = { count: 0, lastCompletedDate: null, freezes: 0, best: 0 };
  assert.deepEqual(R.applyCompletion(s, FRI), { used: 0, reset: false, earned: false });
  assert.equal(s.count, 1);
  for (const bad of [null, undefined, 5, 'x', {}, { count: '<img>', freezes: 99, lastCompletedDate: 5 }]) {
    const e = R.evaluate(bad, FRI); assert.equal(e.alive, false); assert.ok(e.freezes >= 0 && e.freezes <= 3);
  }
});
test('works across month/year boundaries, DST and a clock moved back', () => {
  assert.equal(R.dayDiff('2026-12-31', '2027-01-02'), 2);
  assert.equal(R.dayDiff('2026-03-28', '2026-03-30'), 2);               // DST change in many zones
  assert.equal(R.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(R.addDays('2026-03-01', -1), '2026-02-28');
  assert.deepEqual(R.evaluate({ count: 3, lastCompletedDate: '2026-12-31', freezes: 0 }, '2027-01-02').alive, true);
  const back = R.evaluate(mk(), '2026-11-10');                          // today is before the last completed day
  assert.deepEqual([back.alive, back.missed], [true, 0]);
});
test('nextFreezeDay', () => {
  assert.deepEqual([0, 6, 7, 13, 14].map(R.nextFreezeDay), [7, 7, 14, 14, 21]);
});
