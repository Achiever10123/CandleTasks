const test = require('node:test');
const assert = require('node:assert/strict');
const NLP = require('../nlp.js');

const NOW = new Date(2026, 10, 18, 10, 0);          // Wed 18 Nov 2026, 10:00
const p = (s, now = NOW, o) => NLP.parse(s, now, o);

test('basic date + time', () => {
  const r = p('call mom tomorrow at 5pm');
  assert.equal(r.text, 'call mom'); assert.equal(r.due, '2026-11-19'); assert.equal(r.dueTime, '17:00');
});
test('tags and priority', () => {
  const r = p('buy milk #home !high');
  assert.deepEqual(r.tags, ['home']); assert.equal(r.priority, 3); assert.equal(r.text, 'buy milk');
});
test('"#1" is not a tag', () => {
  const r = p('Call customer #1');
  assert.deepEqual(r.tags, []); assert.equal(r.text, 'Call customer #1');
});
test('trailing preposition kept when nothing was parsed', () => {
  assert.equal(p('Buy a present for').text, 'Buy a present for');
  assert.equal(p('Call mom on tomorrow').text, 'Call mom');            // still tidied when a date was removed
});
test('"tonight" is 8 PM, but not in the past', () => {
  assert.equal(p('dentist tonight').dueTime, '20:00');
  const late = p('dentist tonight', new Date(2026, 10, 18, 21, 0));
  assert.equal(late.due, '2026-11-18'); assert.equal(late.dueTime, null);
});
test('a rejected weekday word does not block a real one later', () => {
  const r = p('sat around then on friday');
  assert.equal(r.due, '2026-11-20'); assert.equal(r.text, 'sat around then');
});
test('next / this weekday', () => {
  assert.equal(p('report this friday').due, '2026-11-20');
  assert.equal(p('report next friday').due, '2026-11-27');
});
test('numeric date order', () => {
  assert.equal(p('report on 3/4').due, '2027-04-03');                  // day/month by default
  assert.equal(p('report on 3/4', NOW, { dmy: false }).due, '2027-03-04');
});
test('repeats', () => {
  const m = p('pay rent every month on the 1st');
  assert.equal(m.recur, 'monthday'); assert.equal(m.recurMonthDay, 1); assert.equal(m.due, '2026-12-01');
  const d = p('gym every mon and wed');
  assert.equal(d.recur, 'days'); assert.deepEqual(d.recurDays, [1, 3]); assert.equal(d.due, '2026-11-18');
  assert.equal(p('water plants every 3 days').recurEvery, 3);
});
test('input that is only a date keeps the original text', () => {
  const r = p('tomorrow');
  assert.equal(r.text, 'tomorrow'); assert.equal(r.due, null);
});
