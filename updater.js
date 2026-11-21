'use strict';
// App updates.
//   Installed (NSIS) build : electron-updater downloads from GitHub Releases. Differential download is on, so only
//                            the changed blocks of the installer are fetched, then the app restarts into the new version.
//   Portable build         : a portable .exe can't replace itself, so we only *tell* the user a newer version exists
//                            and open the releases page.
// The GitHub owner/repo come from package.json -> build.publish (single source of truth).
const { app, net, Notification, shell } = require('electron');

const CHECK_DELAY_MS = 15 * 1000;              // first check shortly after launch
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;     // then every 6 hours while the app stays open

// ── pure helpers (unit-tested) ────────────────────────────────────
const VER_RE = /^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/;
const cleanVer = v => (typeof v === 'string' && VER_RE.test(v.trim().replace(/^v/i, '')) ? v.trim().replace(/^v/i, '') : null);

function isNewer(candidate, current) {          // true when candidate > current (pre-release suffixes ignored)
  const a = String(candidate).split(/[-+]/)[0].split('.').map(Number);
  const b = String(current).split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

function parseRepo(pkg) {
  try {
    const p = [].concat((pkg && pkg.build && pkg.build.publish) || [])[0];
    if (p && p.provider === 'github' && /^[\w.-]+$/.test(p.owner || '') && /^[\w.-]+$/.test(p.repo || '') && !/^YOUR_/i.test(p.owner)) {
      return { owner: p.owner, repo: p.repo };
    }
  } catch (e) {}
  return null;
}

// ── state ─────────────────────────────────────────────────────────
let deps = null;                 // { getWindow, getSettings, beforeInstall }
let repo = null;
let autoUpdater = null;
let phase = 'idle';              // idle | checking | available | downloading | ready
let manualPending = false;       // the user pressed "Check for updates" (so show "up to date" / errors)
let dismissedVersion = null;     // "Later" this session
let notifiedVersion = null;
let availableVersion = null;
let lastStatus = null;
let timer = null;

const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;
const releasesUrl = () => `https://github.com/${repo.owner}/${repo.repo}/releases/latest`;

function mode() {
  if (!repo) return 'disabled';
  if (!app.isPackaged) return 'dev';
  return isPortable() ? 'portable' : 'installer';
}

function send(status) {
  lastStatus = status;
  const win = deps && deps.getWindow && deps.getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('update-status', status);
}

function notifyIfHidden(version) {
  try {
    const win = deps.getWindow();
    if (notifiedVersion === version || (win && !win.isDestroyed() && win.isVisible())) return;
    notifiedVersion = version;
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: 'CandleTasks update', body: `Version ${version} is available. Open CandleTasks to update.` });
    n.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
    n.show();
  } catch (e) {}
}

// ── installed build (electron-updater) ────────────────────────────
function getUpdater() {
  if (autoUpdater) return autoUpdater;
  autoUpdater = require('electron-updater').autoUpdater;     // loaded lazily: the app still runs if it is missing
  autoUpdater.autoDownload = false;                            // ask first
  autoUpdater.autoInstallOnAppQuit = true;                     // a downloaded update installs when the user quits ("Later")
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('update-available', info => {
    const version = cleanVer(info && info.version);
    if (!version) { phase = 'idle'; return; }
    availableVersion = version;
    phase = 'available';
    if (!manualPending && dismissedVersion === version) return;          // user said "Later": don't nag again this session
    manualPending = false;
    send({ state: 'available', version, current: app.getVersion() });
    notifyIfHidden(version);
  });
  autoUpdater.on('update-not-available', () => {
    phase = 'idle';
    if (manualPending) { manualPending = false; send({ state: 'none', current: app.getVersion() }); }
  });
  autoUpdater.on('download-progress', p => {
    send({ state: 'downloading', version: availableVersion, percent: Math.max(0, Math.min(100, Number(p && p.percent) || 0)) });
  });
  autoUpdater.on('update-downloaded', info => {
    phase = 'ready';
    send({ state: 'ready', version: cleanVer(info && info.version) || availableVersion });
  });
  autoUpdater.on('error', err => {
    const wasDownloading = phase === 'downloading';
    if (wasDownloading) phase = 'available'; else if (phase === 'checking') phase = 'idle';
    if (wasDownloading) send({ state: 'error', showModal: true, message: 'The download failed. Check your internet connection and try again.' });
    else if (manualPending) { manualPending = false; send({ state: 'error', message: 'Couldn\u2019t check for updates. Check your internet connection and try again.' }); }
    // automatic background checks fail silently
    try { console.warn('[updater]', err && err.message); } catch (e) {}
  });
  return autoUpdater;
}

// ── portable build (GitHub API, tell only) ────────────────────────
async function checkPortable() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await net.fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CandleTasks' }, signal: ctrl.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const version = cleanVer(data && data.tag_name);
    if (version && isNewer(version, app.getVersion())) {
      availableVersion = version; phase = 'available';
      if (manualPending || dismissedVersion !== version) {
        send({ state: 'portable', version, current: app.getVersion() });
        notifyIfHidden(version);
      }
    } else {
      phase = 'idle';
      if (manualPending) send({ state: 'none', current: app.getVersion() });
    }
  } catch (e) {
    phase = 'idle';
    if (manualPending) send({ state: 'error', message: 'Couldn\u2019t check for updates. Check your internet connection and try again.' });
  } finally { clearTimeout(t); manualPending = false; }
}

// ── public actions ────────────────────────────────────────────────
async function check(manual) {
  const m = mode();
  if (m === 'disabled' || m === 'dev') {
    if (manual) send({ state: 'disabled', message: m === 'dev' ? 'Updates only work in the installed app.' : 'Updates aren\u2019t set up for this build.' });
    return;
  }
  if (!manual) {
    const s = deps.getSettings();
    if (s.autoUpdate === false) return;
  }
  if (phase === 'downloading' || phase === 'ready') return;               // already have one in progress
  if (!net.isOnline()) {
    if (manual) send({ state: 'error', message: 'You\u2019re offline. Connect to the internet and try again.' });
    return;
  }
  manualPending = !!manual;
  phase = 'checking';
  if (manual) send({ state: 'checking' });
  if (m === 'portable') return checkPortable();
  try { await getUpdater().checkForUpdates(); } catch (e) { /* reported by the 'error' event */ }
}

function download() {
  if (mode() !== 'installer' || phase !== 'available') return;
  phase = 'downloading';
  send({ state: 'downloading', version: availableVersion, percent: 0 });
  getUpdater().downloadUpdate().catch(() => { /* reported by the 'error' event */ });
}

function install() {
  if (mode() !== 'installer' || phase !== 'ready') return;
  try { deps.beforeInstall(); } catch (e) {}
  getUpdater().quitAndInstall(true, true);                                // silent install, relaunch afterwards
}

function later() { if (availableVersion) dismissedVersion = availableVersion; }

function openReleasePage() { if (repo) shell.openExternal(releasesUrl()); }

// ── wiring ────────────────────────────────────────────────────────
function registerIpc(handle) {
  handle('update-state', () => ({ current: app.getVersion(), mode: mode(), last: lastStatus }));
  handle('update-check', () => { check(true); return true; });
  handle('update-download', () => { download(); return true; });
  handle('update-install', () => { install(); return true; });
  handle('update-later', () => { later(); return true; });
  handle('update-open-page', () => { openReleasePage(); return true; });
}

function start(d) {
  deps = d;
  try { repo = parseRepo(require('./package.json')); } catch (e) { repo = null; }
  if (mode() === 'disabled' || mode() === 'dev') return;
  setTimeout(() => check(false), CHECK_DELAY_MS).unref();
  timer = setInterval(() => check(false), CHECK_EVERY_MS);
  timer.unref();
}

module.exports = { registerIpc, start, _internal: { cleanVer, isNewer, parseRepo } };
