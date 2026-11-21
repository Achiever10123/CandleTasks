// Drives updater.js through its states with a fake electron-updater (no network, no Electron).
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

function load({ portable = false, online = true, packaged = true, fetchImpl } = {}) {
  const calls = { check: 0, download: 0, install: 0, beforeInstall: 0, opened: [] };
  const fake = new EventEmitter();
  fake.checkForUpdates = async () => { calls.check++; };
  fake.downloadUpdate = async () => { calls.download++; };
  fake.quitAndInstall = (...a) => { calls.install++; calls.installArgs = a; };
  const stub = {
    app: { getVersion: () => '1.1.0', isPackaged: packaged },
    net: { isOnline: () => online, fetch: fetchImpl },
    Notification: Object.assign(function () { this.on = () => {}; this.show = () => {}; }, { isSupported: () => false }),
    shell: { openExternal: url => calls.opened.push(url) }
  };
  const pkg = { build: { publish: [{ provider: 'github', owner: 'jane', repo: 'candletasks' }] } };
  // The hook stays installed for this file: updater.js loads electron-updater and package.json lazily.
  // (node --test runs every test file in its own process, so this does not leak into other tests.)
  const orig = Module._load.__orig || Module._load;
  const hook = function (req, ...rest) {
    if (req === 'electron') return stub;
    if (req === 'electron-updater') return { autoUpdater: fake };
    if (req === './package.json') return pkg;
    return orig.call(this, req, ...rest);
  };
  hook.__orig = orig;
  Module._load = hook;
  if (portable) process.env.PORTABLE_EXECUTABLE_FILE = 'C:\\x\\CandleTasks-portable.exe'; else delete process.env.PORTABLE_EXECUTABLE_FILE;
  delete require.cache[require.resolve('../updater.js')];
  const updater = require('../updater.js');

  const sent = [];
  const handlers = {};
  updater.registerIpc((ch, fn) => { handlers[ch] = fn; });
  const win = { isDestroyed: () => false, isVisible: () => true, webContents: { send: (ch, st) => sent.push(st) } };
  // start() schedules timers (unref'd); we call the IPC handlers directly instead
  updater.start({ getWindow: () => win, getSettings: () => ({ autoUpdate: true }), beforeInstall: () => { calls.beforeInstall++; } });
  return { fake, handlers, sent, calls };
}
const tick = () => new Promise(r => setImmediate(r));

test('manual check -> available -> download -> ready -> install', async () => {
  const { fake, handlers, sent, calls } = load();
  await handlers['update-check'](); await tick();
  assert.equal(calls.check, 1); assert.equal(sent[0].state, 'checking');
  fake.emit('update-available', { version: '1.2.0' });
  assert.deepEqual(sent.at(-1), { state: 'available', version: '1.2.0', current: '1.1.0' });
  await handlers['update-download'](); await tick();
  assert.equal(calls.download, 1);
  fake.emit('download-progress', { percent: 42.4 });
  assert.equal(sent.at(-1).state, 'downloading'); assert.equal(sent.at(-1).percent, 42.4);
  fake.emit('update-downloaded', { version: '1.2.0' });
  assert.deepEqual(sent.at(-1), { state: 'ready', version: '1.2.0' });
  await handlers['update-install']();
  assert.equal(calls.install, 1); assert.equal(calls.beforeInstall, 1); assert.deepEqual(calls.installArgs, [true, true]);
});
test('install and download do nothing out of order', async () => {
  const { handlers, calls } = load();
  await handlers['update-install'](); await handlers['update-download']();
  assert.equal(calls.install, 0); assert.equal(calls.download, 0);
});
test('manual check with nothing new says "none"; errors are reported', async () => {
  const a = load();
  await a.handlers['update-check'](); await tick();
  a.fake.emit('update-not-available', {});
  assert.equal(a.sent.at(-1).state, 'none');
  const b = load();
  await b.handlers['update-check'](); await tick();
  b.fake.emit('error', new Error('ENOTFOUND github.com'));
  assert.equal(b.sent.at(-1).state, 'error');
  assert.ok(!/ENOTFOUND/.test(b.sent.at(-1).message));          // raw error text is not shown to the user
});
test('a failed download returns to "available" and shows the problem', async () => {
  const { fake, handlers, sent } = load();
  await handlers['update-check'](); await tick();
  fake.emit('update-available', { version: '1.2.0' });
  await handlers['update-download'](); await tick();
  fake.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  assert.equal(sent.at(-1).state, 'error'); assert.equal(sent.at(-1).showModal, true);
  await handlers['update-download'](); await tick();            // can retry
  assert.equal(sent.at(-1).state, 'downloading');
});
test('"Later" silences the same version for the rest of the session, not a manual check', async () => {
  const { fake, handlers, sent } = load();
  await handlers['update-check'](); await tick();
  fake.emit('update-available', { version: '1.2.0' });
  await handlers['update-later']();
  const n = sent.length;
  fake.emit('update-available', { version: '1.2.0' });          // e.g. the 6-hourly background check
  assert.equal(sent.length, n);
  await handlers['update-check'](); await tick();               // user asks again
  fake.emit('update-available', { version: '1.2.0' });
  assert.equal(sent.at(-1).state, 'available');
});
test('a hostile version string from the feed is ignored', async () => {
  const { fake, handlers, sent } = load();
  await handlers['update-check'](); await tick();
  const n = sent.length;
  fake.emit('update-available', { version: '<img src=x onerror=alert(1)>' });
  assert.equal(sent.length, n);
});
test('offline manual check explains itself and does not call the updater', async () => {
  const { handlers, sent, calls } = load({ online: false });
  await handlers['update-check'](); await tick();
  assert.equal(calls.check, 0); assert.equal(sent.at(-1).state, 'error');
});
test('dev (unpackaged) builds never hit the network', async () => {
  const { handlers, sent, calls } = load({ packaged: false });
  await handlers['update-check'](); await tick();
  assert.equal(calls.check, 0); assert.equal(sent.at(-1).state, 'disabled');
});
test('portable build: tells the user about a newer release and opens only the fixed releases URL', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ tag_name: 'v1.3.0' }) });
  const { handlers, sent, calls } = load({ portable: true, fetchImpl });
  await handlers['update-check'](); await tick(); await tick();
  assert.deepEqual(sent.at(-1), { state: 'portable', version: '1.3.0', current: '1.1.0' });
  await handlers['update-open-page']();
  assert.deepEqual(calls.opened, ['https://github.com/jane/candletasks/releases/latest']);
  assert.equal(calls.check, 0);                                   // electron-updater is not used for portable
  delete process.env.PORTABLE_EXECUTABLE_FILE;
});
test('portable build: same or older release -> "none"; network failure -> error', async () => {
  const same = load({ portable: true, fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.1.0' }) }) });
  await same.handlers['update-check'](); await tick(); await tick();
  assert.equal(same.sent.at(-1).state, 'none');
  const bad = load({ portable: true, fetchImpl: async () => { throw new Error('offline'); } });
  await bad.handlers['update-check'](); await tick(); await tick();
  assert.equal(bad.sent.at(-1).state, 'error');
  delete process.env.PORTABLE_EXECUTABLE_FILE;
});
