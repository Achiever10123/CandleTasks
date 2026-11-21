// Streak-freeze display in the streak modal (app.js is a browser script, so the helper is extracted and run in a VM).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const chunk = src.slice(src.indexOf('const MAX_FREEZES'), src.indexOf('function closeStreakModal'));
const el = () => ({ className: '', textContent: '', children: [], title: '', appendChild(c) { this.children.push(c); }, append(...c) { this.children.push(...c); } });
function load(streak) {
  const box = el();
  const ctx = { streak, $: () => box, document: { createElement: el } };
  vm.createContext(ctx);
  vm.runInContext(chunk + ';this.freezeInfo = freezeInfo; this.renderFreezeInfo = renderFreezeInfo;', ctx);
  return { ctx, box };
}

test('freezeInfo wording and next-freeze day', () => {
  const { ctx } = load({ count: 0, freezes: 0 });
  assert.deepEqual({ ...ctx.freezeInfo(0, 0) }, { n: 0, main: 'No streak freezes left', sub: 'Next freeze at day 7' });
  assert.equal(ctx.freezeInfo(6, 1).main, '1 of 3 streak freezes left');
  assert.equal(ctx.freezeInfo(14, 2).sub, 'Next freeze at day 21');
  assert.equal(ctx.freezeInfo(7, 1).sub, 'Next freeze at day 14');
  assert.equal(ctx.freezeInfo(20, 3).sub, 'Freezes are full');
});
test('freezeInfo clamps bad values to 0..3', () => {
  const { ctx } = load({ count: 0, freezes: 0 });
  assert.equal(ctx.freezeInfo(5, 99).n, 3);
  assert.equal(ctx.freezeInfo(5, -2).n, 0);
  assert.equal(ctx.freezeInfo(5, 'x').n, 0);
  assert.equal(ctx.freezeInfo('<img>', 1).sub, 'Next freeze at day 7');
});
test('renderFreezeInfo lights one snowflake per freeze held', () => {
  const { ctx, box } = load({ count: 15, freezes: 2 });
  ctx.renderFreezeInfo();
  const [row, main, sub] = box.children;
  assert.deepEqual(row.children.map(c => c.className), ['fz on', 'fz on', 'fz']);
  assert.equal(main.textContent, '2 of 3 streak freezes left');
  assert.equal(sub.textContent, 'Next freeze at day 21');
});
