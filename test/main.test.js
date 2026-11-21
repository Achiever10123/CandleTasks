// Tests the pure data helpers in main.js. 'electron' is stubbed so main.js can be required outside Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const noop = () => {};
const proxyStub = new Proxy(function () {}, { get: () => proxyStub, apply: () => proxyStub, construct: () => proxyStub });
const electronStub = {
  app: { getPath: () => os.tmpdir(), requestSingleInstanceLock: () => true, on: noop, whenReady: () => ({ then: noop }), isReady: () => false, quit: noop },
  ipcMain: { handle: noop, on: noop },
  Notification: Object.assign(function () {}, { isSupported: () => false }),
  screen: proxyStub, dialog: proxyStub, Tray: proxyStub, Menu: proxyStub, nativeImage: proxyStub,
  shell: proxyStub, globalShortcut: proxyStub, session: proxyStub, BrowserWindow: proxyStub
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? electronStub : origLoad.call(this, req, ...rest); };
const main = require(path.join(__dirname, '..', 'main.js'));
Module._load = origLoad;

const XSS = '<img src=x onerror=alert(1)>';

test('normalizeData rejects non-date strings in date fields', () => {
  const d = main.normalizeData({
    lists: [{ id: 'a', name: 'Inbox' }], activeListId: 'a',
    tasks: [{ id: '1', listId: 'a', text: 'x', due: `2026-01-01-${XSS}`, addedDate: XSS, completedDate: '2026-02-30', dueTime: '99:99' }]
  });
  const t = d.tasks[0];
  assert.equal(t.due, null); assert.equal(t.addedDate, null); assert.equal(t.completedDate, null); assert.equal(t.dueTime, null);
});
test('normalizeData keeps valid dates and times', () => {
  const t = main.normalizeData({ lists: [{ id: 'a', name: 'L' }], tasks: [{ id: '1', listId: 'a', text: 'x', due: '2026-12-25', dueTime: '09:30', addedDate: '2026-11-01' }] }).tasks[0];
  assert.equal(t.due, '2026-12-25'); assert.equal(t.dueTime, '09:30'); assert.equal(t.addedDate, '2026-11-01');
});
test('normalizeData enforces size limits and strips newlines from list names', () => {
  const d = main.normalizeData({
    lists: [{ id: 'a', name: 'Line1\nLine2' + 'x'.repeat(200) }],
    tasks: [{ id: '1', listId: 'a', text: 'y'.repeat(500), notes: 'n'.repeat(10000), tags: Array.from({ length: 50 }, (_, i) => 't' + i),
      subtasks: Array.from({ length: 300 }, (_, i) => ({ id: 's' + i, text: 'z'.repeat(500) })) }]
  });
  assert.ok(!/[\r\n]/.test(d.lists[0].name)); assert.ok(d.lists[0].name.length <= 60);
  const t = d.tasks[0];
  assert.equal(t.text.length, 120); assert.equal(t.notes.length, 2000); assert.equal(t.tags.length, 20);
  assert.equal(t.subtasks.length, 100); assert.equal(t.subtasks[0].text.length, 120);
});
test('normalizeData survives junk input', () => {
  for (const junk of [null, undefined, 5, 'str', [], { tasks: 'no' }, { tasks: [null, 1, 'a'] }]) {
    const d = main.normalizeData(junk);
    assert.ok(Array.isArray(d.lists) && d.lists.length >= 1); assert.ok(Array.isArray(d.tasks));
  }
});
test('cleanStreak turns hostile values into plain numbers and dates', () => {
  const s = main.cleanStreak({
    count: XSS, best: '9e999', lastCompletedDate: XSS, completedDates: ['2026-11-01', XSS, 5],
    doneByDate: { '2026-11-01': XSS, '2026-11-02': 3, [XSS]: 4 }, freezes: 99,
    journal: [{ date: '2026-11-01', count: XSS }, { date: XSS }]
  });
  assert.equal(s.count, 0); assert.equal(s.lastCompletedDate, null);
  assert.deepEqual(s.completedDates, ['2026-11-01']);
  assert.deepEqual(s.doneByDate, { '2026-11-02': 3 });
  assert.equal(s.freezes, 3); assert.ok(Number.isFinite(s.best) && s.best <= 100000);
  assert.equal(s.journal.length, 1); assert.equal(s.journal[0].count, 0);
});
test('cleanStreak handles non-objects', () => {
  for (const junk of [null, undefined, 3, 'x', []]) assert.equal(main.cleanStreak(junk).count, 0);
});
test('sanitizeSettings keeps only known, well-typed keys', () => {
  const s = main.sanitizeSettings({
    darkMode: true, alwaysOnTop: 'yes', syncFolder: 'C:\\evil', themeColor: 'purple', uiStyle: 'bento', snapPosition: '../x',
    customColor: '#c97b2a', reminderTime: '09:00', reviewTime: '25:99', windowOpacity: 5, __proto__x: 1, evil: { a: 1 }
  });
  assert.deepEqual(Object.keys(s).sort(), ['customColor', 'darkMode', 'reminderTime', 'uiStyle', 'windowOpacity']);
  assert.ok(s.windowOpacity <= 1);
  assert.deepEqual(main.sanitizeSettings(null), {});
});
