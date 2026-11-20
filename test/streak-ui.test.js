// Runs the real streak code from app.js (a browser script) in a VM with a stubbed page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const StreakRules = require('../streak-rules.js');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const slice = (a, b) => app.slice(app.indexOf(a), app.indexOf(b));

// ── flame tiers ─────────────────────────────────────────────────
const tierCode = slice('const TIERS = [', '// ── Apply flame colors');
function tiers() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(tierCode + ';this.TIERS = TIERS; this.getTier = getTier;', ctx);
  return ctx;
}
test('the flame changes colour at every milestone, including day 3', () => {
  const { getTier } = tiers();
  const at = n => getTier(n, true).outerTop;
  assert.notEqual(at(2), at(3), 'day 3 must look different from day 2');
  assert.notEqual(at(3), at(6 + 1), 'day 3 must look different from day 7');
  for (const [lo, hi] of [[1, 3], [3, 7], [7, 14], [14, 30], [30, 60], [60, 100], [100, 365]]) assert.notEqual(at(lo), at(hi), `${lo} vs ${hi}`);
  assert.equal(at(3), at(6)); assert.equal(at(7), at(13));            // a tier lasts until the next milestone
});
test('every tier is clearly distinct and the dead flame is grey', () => {
  const { TIERS, getTier } = tiers();
  assert.equal(new Set(TIERS.map(t => t.outerTop)).size, TIERS.length);
  assert.equal(new Set(TIERS.map(t => t.dayColor)).size, TIERS.length);
  assert.equal(getTier(50, false), TIERS[0]); assert.equal(getTier(0, true), TIERS[0]);
  const mins = Array.from(TIERS, t => t.min);
  assert.deepEqual(mins, [...mins].sort((a, b) => a - b));            // getTier relies on ascending order
});
test('the tiers line up with the milestones', () => {
  const { TIERS } = tiers();
  for (const m of [3, 7, 14, 30, 60, 100, 365]) assert.ok(TIERS.some(t => t.min === m), `no colour change at ${m}`);
});

// ── completing a task: the toast ────────────────────────────────
const checkCode = slice('const freezeLeft', '// Save the streak; the main process merges');
function complete(streakState, today) {
  const toasts = [], celebrated = [];
  const streak = { count: 0, lastCompletedDate: null, completedDates: [], freezes: 0, frozenDates: [], best: 0, doneByDate: {}, journal: [], ...streakState };
  const ctx = {
    streak, StreakRules, MILESTONES: [3, 7, 14, 30, 60, 100, 365],
    todayStr: () => today, normStreak: s => s, saveStreakState() {}, renderStreak() {}, igniteFlame() {}, $: () => ({}),
    getTier: () => ({}), showToast: m => toasts.push(m), celebrate: (...a) => celebrated.push(a)
  };
  vm.createContext(ctx);
  vm.runInContext(checkCode + ';this.checkStreak = checkStreak;', ctx);
  ctx.checkStreak();
  return { streak, toasts, celebrated };
}
const base = { count: 5, lastCompletedDate: '2026-11-16', freezes: 1, completedDates: ['2026-11-16'], best: 5 };

test('a freeze that saved the streak is announced with the freezes left', () => {
  const r = complete(base, '2026-11-19');                              // Mon -> Thu: Tue grace, Wed used 1 freeze
  assert.equal(r.streak.count, 6); assert.equal(r.streak.freezes, 0);
  assert.deepEqual(r.toasts, ['1 streak freeze used to save your streak. You have 0 left.']);
});
test('no "freeze used" toast when the streak had already run out and was reset', () => {
  const r = complete(base, '2026-11-30');                              // 13 missed days, 1 freeze
  assert.equal(r.streak.count, 1); assert.equal(r.streak.freezes, 0);
  assert.deepEqual(r.toasts, []); assert.deepEqual(r.celebrated, []);
  const none = complete({ ...base, freezes: 0 }, '2026-11-19');       // second missed day, no freezes
  assert.equal(none.streak.count, 1); assert.deepEqual(none.toasts, []);
});
test('no toast on a normal day or after only the grace day', () => {
  assert.deepEqual(complete(base, '2026-11-17').toasts, []);
  const grace = complete(base, '2026-11-18');
  assert.equal(grace.streak.count, 6); assert.equal(grace.streak.freezes, 1); assert.deepEqual(grace.toasts, []);
});
test('earning a freeze and using one are announced together; milestones celebrate', () => {
  const r = complete({ count: 6, lastCompletedDate: '2026-11-17', freezes: 2, completedDates: ['2026-11-17'], best: 6 }, '2026-11-20'); // Wed missed (grace), Thu missed (freeze), Fri
  assert.equal(r.streak.count, 7);
  assert.equal(r.celebrated.length, 1);                                // 7 is a milestone
  assert.deepEqual([r.celebrated[0][0], r.celebrated[0][2], r.celebrated[0][3]], [7, true, 1]);
  const r2 = complete({ count: 7, lastCompletedDate: '2026-11-17', freezes: 1, completedDates: ['2026-11-17'], best: 7 }, '2026-11-19');
  assert.equal(r2.streak.count, 8); assert.deepEqual(r2.toasts, []);
});

// ── CSS / markup regressions ────────────────────────────────────
test('embers use selectors that can match (they are not the first children of the svg)', () => {
  assert.ok(!/\.ember:nth-child/.test(css));
  for (let i = 1; i <= 5; i++) assert.ok(css.includes(`.ember:nth-of-type(${i})`), `ember ${i}`);
  assert.equal((html.match(/class="ember"/g) || []).length, 10);     // 5 per flame, 2 flames
});
test('both flames animate the outline and have tongues', () => {
  assert.equal((html.match(/<animate attributeName="d"/g) || []).length, 4);
  assert.equal((html.match(/class="f-tongue/g) || []).length, 4);
});
test('modals keep one size and scroll with the custom scrollbar', () => {
  assert.match(css, /\.modal-card\s*\{\s*box-sizing:border-box;/);
  assert.match(css, /\.help-card\s*\{[^}]*height:min\(/);
  assert.match(css, /\.modal-card::-webkit-scrollbar-thumb\s*\{[^}]*var\(--accent\)/);
  assert.ok(app.includes('function lockStreakCardSize'));
  assert.ok(app.includes("$('modal-card').scrollTop = 0"));
});
test('the help page describes the new rules', () => {
  assert.ok(!/2-day grace/.test(html));
  assert.match(html, /1 grace day/);
  assert.match(html, /resets to 0/);
  assert.match(html, /color at 3, 7, 14, 30, 60, 100 and 365/);
});
test('streak-rules.js is loaded before app.js and shipped in the build', () => {
  assert.ok(html.indexOf('streak-rules.js') > 0 && html.indexOf('streak-rules.js') < html.indexOf('src="app.js"'));
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build.files.includes('streak-rules.js'));
});
