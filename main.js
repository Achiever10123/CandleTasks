const { app, BrowserWindow, ipcMain, Notification, screen, dialog, Tray, Menu, nativeImage, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const NLP = require('./nlp.js');

// ── File paths ────────────────────────────────────────────────────
const userDataPath     = app.getPath('userData');
const legacyTasksMd    = path.join(userDataPath, 'tasks.md');   // v1 storage (migrated once)
const settingsFilePath = path.join(userDataPath, 'settings.json');
const streakFilePath   = path.join(userDataPath, 'streak.json');

let mainWindow = null;
let quickWin   = null;
let tray       = null;
let isQuitting = false;
let inMini = false;
let overdueCount = 0;

// ── Default settings ──────────────────────────────────────────────
const defaultSettings = {
  alwaysOnTop: true,
  snapPosition: 'none',
  darkMode: true,
  reminderEnabled: false,
  reminderTime: '09:00',
  themeColor: 'default',
  uiStyle: 'default',
  minimizeToTray: false,
  soundEnabled: true,
  notifyOverdue: true,
  globalQuickAdd: true,
  compactMode: false,
  customColor: '#c97b2a',
  launchAtLogin: false,
  weeklyReview: true,
  reviewTime: '18:00',
  miniMode: false,
  miniBounds: { width: 320, height: 320, x: null, y: null },
  windowOpacity: 1,
  syncFolder: '',
  windowBounds: { width: 320, height: 580, x: null, y: null }
};

function loadSettings() {
  try {
    if (fs.existsSync(settingsFilePath)) {
      return { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsFilePath, 'utf8')) };
    }
  } catch (e) {}
  return { ...defaultSettings };
}

function saveSettings(settings) {
  fs.writeFileSync(settingsFilePath, JSON.stringify(settings, null, 2));
}

function clampOpacity(v) {
  const n = Number(v);
  if (!isFinite(n)) return 1;
  return Math.min(1, Math.max(0.3, n));
}

// ── Streak: stored next to tasks.json so it syncs too ─────────────
// A local copy in userData is always kept as a fallback.
const localStreakPath = () => streakFilePath;
const streakPath = () => path.join(dataDir(), 'streak.json');
let lastStreakHash = '';

function emptyStreak() {
  return { count: 0, lastCompletedDate: null, completedDates: [], freezes: 0, frozenDates: [], best: 0, doneByDate: {}, journal: [] };
}

function readStreakFile(p) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {}
  return null;
}

// Union the history; the side with the most recent activity owns the count.
function mergeStreak(a, b) {
  a = a || emptyStreak();
  b = b || emptyStreak();
  const dates  = [...new Set([...(a.completedDates || []), ...(b.completedDates || [])])].sort();
  const frozen = [...new Set([...(a.frozenDates || []), ...(b.frozenDates || [])])].sort();
  const done = { ...(a.doneByDate || {}) };
  for (const [k, v] of Object.entries(b.doneByDate || {})) done[k] = Math.max(done[k] || 0, v || 0);
  const al = a.lastCompletedDate || '', bl = b.lastCompletedDate || '';
  const base = al > bl ? a : bl > al ? b : ((a.count || 0) >= (b.count || 0) ? a : b);
  return {
    count: base.count || 0,
    lastCompletedDate: base.lastCompletedDate || null,
    completedDates: dates,
    freezes: Math.max(0, Math.min(3, base.freezes || 0)),
    frozenDates: frozen,
    best: Math.max(a.best || 0, b.best || 0, base.count || 0),
    doneByDate: done,
    journal: Array.isArray(base.journal) ? base.journal : []
  };
}

function localToday() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// If the clock was moved forward and back, progress dated "in the future" is not real: remove it
// and roll the count back. The journal (state before each new streak day) gives an exact rollback;
// older data without a journal falls back to subtracting one per future day.
function pruneFutureStreak(s) {
  const today = localToday();
  const fut = d => d > today;
  const futureKeys = Object.keys(s.doneByDate || {}).filter(fut);
  const hasFuture = (s.lastCompletedDate && fut(s.lastCompletedDate)) ||
    (s.completedDates || []).some(fut) || (s.frozenDates || []).some(fut) ||
    futureKeys.length || (s.journal || []).some(e => fut(e.date));
  if (!hasFuture) return { streak: s, changed: false };

  const out = { ...s };
  const futureDays = (s.completedDates || []).filter(fut).length;
  const futureEntries = (s.journal || []).filter(e => fut(e.date)).sort((a, b) => (a.date < b.date ? -1 : 1));
  out.completedDates = (s.completedDates || []).filter(d => !fut(d));
  out.frozenDates = (s.frozenDates || []).filter(d => !fut(d));
  out.doneByDate = Object.fromEntries(Object.entries(s.doneByDate || {}).filter(([d]) => !fut(d)));
  out.journal = (s.journal || []).filter(e => !fut(e.date));

  if (futureEntries.length) {                         // exact: go back to the state before the first future day
    const e = futureEntries[0];
    out.count = e.count; out.lastCompletedDate = e.last || null; out.freezes = e.freezes; out.best = e.best;
  } else {                                            // legacy data: best guess
    const oldCount = s.count || 0;
    const last = out.completedDates.length ? out.completedDates[out.completedDates.length - 1] : null;
    out.lastCompletedDate = last;
    out.count = last ? Math.max(1, oldCount - futureDays) : 0;
    out.best = (s.best || 0) > oldCount ? s.best : out.count;
  }
  out.count = Math.max(0, out.count || 0);
  return { streak: out, changed: true };
}

function loadStreak() {
  const main  = readStreakFile(streakPath());
  const local = readStreakFile(localStreakPath());
  if (main) { lastStreakHash = hash(JSON.stringify(main)); }
  // In a sync folder, never lose progress that only exists locally
  return main ? mergeStreak(main, streakPath() === localStreakPath() ? null : local) : (local || emptyStreak());
}

function saveStreak(data) {
  const json = JSON.stringify(data, null, 2);
  lastStreakHash = hash(json);
  try { fs.mkdirSync(path.dirname(streakPath()), { recursive: true }); fs.writeFileSync(streakPath(), json); } catch (e) {}
  if (streakPath() !== localStreakPath()) {
    try { fs.writeFileSync(localStreakPath(), json); } catch (e) {}
  }
}

// ══════════════════════════════════════════════════════════════════
//  TASK DATA  —  tasks.json is the source of truth.
//  tasks.md is a read-only, human-friendly mirror rewritten on save.
//  Both live in the sync folder if one is set, otherwise userData.
// ══════════════════════════════════════════════════════════════════
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function hash(str) { return crypto.createHash('sha1').update(str).digest('hex'); }

function dataDir() {
  const s = loadSettings();
  if (s.syncFolder && fs.existsSync(s.syncFolder)) return s.syncFolder;
  return userDataPath;
}
const dataPath   = () => path.join(dataDir(), 'tasks.json');
const mirrorPath = () => path.join(dataDir(), 'tasks.md');

let lastWrittenHash = '';

function defaultData() {
  const id = uid();
  return { version: 2, lists: [{ id, name: 'Tasks' }], activeListId: id, tasks: [], tagColors: {} };
}

function normalizeTask(t, fallbackListId) {
  return {
    id: t.id ? String(t.id) : uid(),
    listId: t.listId || fallbackListId,
    text: String(t.text || '').slice(0, 120),
    done: !!t.done,
    due: t.due || null,
    dueTime: t.due && /^\d{2}:\d{2}$/.test(String(t.dueTime || '')) ? t.dueTime : null,
    addedDate: t.addedDate || null,
    completedDate: t.completedDate || null,
    archived: !!t.archived,
    pinned: !!t.pinned,
    tags: Array.isArray(t.tags) ? t.tags.map(String).map(s => s.trim()).filter(Boolean) : [],
    notes: typeof t.notes === 'string' ? t.notes : '',
    subtasks: Array.isArray(t.subtasks)
      ? t.subtasks.map(s => ({ id: s && s.id ? String(s.id) : uid(), text: String((s && s.text) || ''), done: !!(s && s.done) }))
      : [],
    priority: [0, 1, 2, 3].includes(Number(t.priority)) ? Number(t.priority) : 0,
    recur: ['daily', 'weekly', 'days', 'every', 'after', 'monthday'].includes(t.recur) ? t.recur : null,
    recurEvery: Math.max(1, Math.min(365, Math.floor(Number(t.recurEvery)) || 1)),
    recurUnit: ['day', 'week', 'month'].includes(t.recurUnit) ? t.recurUnit : 'week',
    recurMonthDay: Math.max(1, Math.min(31, Math.floor(Number(t.recurMonthDay)) || 1)),
    recurDays: Array.isArray(t.recurDays)
      ? [...new Set(t.recurDays.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
      : []
  };
}

function normalizeRecur(t) {
  if (t.recur === 'days' && !t.recurDays.length) t.recur = null;   // custom days need at least one day
  return t;
}

function normalizeData(d) {
  d = d && typeof d === 'object' ? d : {};
  let lists = Array.isArray(d.lists)
    ? d.lists.filter(l => l && l.id).map(l => ({ id: String(l.id), name: String(l.name || 'List') }))
    : [];
  if (!lists.length) lists = [{ id: uid(), name: 'Tasks' }];
  const ids = new Set(lists.map(l => l.id));
  const tasks = (Array.isArray(d.tasks) ? d.tasks : [])
    .map(t => normalizeRecur(normalizeTask(t, lists[0].id)))
    .map(t => (ids.has(t.listId) ? t : { ...t, listId: lists[0].id }));
  const activeListId = ids.has(d.activeListId) ? d.activeListId : lists[0].id;
  const tagColors = {};
  if (d.tagColors && typeof d.tagColors === 'object') {
    for (const [k, v] of Object.entries(d.tagColors)) {
      if (/^#[0-9a-f]{6}$/i.test(String(v)) && String(k).length <= 24) tagColors[String(k).toLowerCase()] = String(v).toLowerCase();
    }
  }
  return { version: 2, lists, activeListId, tasks, tagColors };
}

// Legacy markdown table → tasks (migration only)
function parseMd(raw) {
  const tasks = [];
  for (const line of raw.split('\n')) {
    const match = line.match(/^\|\s*(\[x\]|\[ \])\s*\|\s*(.+?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|(?:\s*(.*?)\s*\|)?\s*$/);
    if (match) {
      tasks.push({
        done: match[1] === '[x]',
        text: match[2].trim(),
        due: match[3].trim() || null,
        addedDate: match[4].trim() || null,
        completedDate: match[5].trim() || null,
        archived: (match[6] || '').trim().toLowerCase() === 'yes'
      });
    }
  }
  return tasks;
}

function buildMirror(data) {
  let md = '# CandleTasks\n\n> Auto-generated mirror. Edits here are overwritten. The real data lives in tasks.json.\n';
  for (const list of data.lists) {
    const items = data.tasks.filter(t => t.listId === list.id);
    md += `\n## ${list.name}\n\n`;
    const line = t => {
      const bits = [];
      if (t.due) bits.push(`due ${t.due}${t.dueTime ? ' ' + t.dueTime : ''}`);
      if (t.recur) bits.push(`repeats ${NLP.recurLabel(t)}`);
      if (t.priority) bits.push(`${['', 'low', 'medium', 'high'][t.priority]} priority`);
      if (t.pinned) bits.push('pinned');
      if (t.tags.length) bits.push(t.tags.map(x => '#' + x.replace(/\s+/g, '-')).join(' '));
      if (t.completedDate) bits.push(`done ${t.completedDate}`);
      let out = `- [${t.done ? 'x' : ' '}] ${t.text}${bits.length ? '  ·  ' + bits.join(' · ') : ''}\n`;
      if (t.notes.trim()) out += t.notes.trim().split('\n').map(l => `  > ${l}`).join('\n') + '\n';
      for (const s of t.subtasks) out += `  - [${s.done ? 'x' : ' '}] ${s.text}\n`;
      return out;
    };
    const open = items.filter(t => !t.archived);
    const arch = items.filter(t => t.archived);
    md += open.length ? open.map(line).join('') : '_No tasks._\n';
    if (arch.length) md += `\n### Archived\n\n` + arch.map(line).join('');
  }
  return md;
}

function saveData(data) {
  const clean = normalizeData(data);
  const json = JSON.stringify(clean, null, 2);
  lastWrittenHash = hash(json);
  const p = dataPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, p);
  } catch (e) {
    fs.writeFileSync(p, json);
  }
  try { fs.writeFileSync(mirrorPath(), buildMirror(clean)); } catch (e) {}
}

function loadData() {
  const p = dataPath();
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      lastWrittenHash = hash(raw);
      return normalizeData(JSON.parse(raw));
    }
  } catch (e) {
    // Unreadable file: keep a copy before anything can overwrite it
    try { fs.copyFileSync(p, p.replace(/\.json$/, `.corrupt-${Date.now()}.json`)); } catch (_) {}
    return defaultData();
  }

  // First run on v2: migrate the old tasks.md table
  try {
    if (fs.existsSync(legacyTasksMd)) {
      const listId = uid();
      const parsed = parseMd(fs.readFileSync(legacyTasksMd, 'utf8'));
      const data = normalizeData({ lists: [{ id: listId, name: 'Tasks' }], activeListId: listId, tasks: parsed.map(t => ({ ...t, listId })) });
      try { fs.copyFileSync(legacyTasksMd, legacyTasksMd + '.bak'); } catch (_) {}
      saveData(data);
      return data;
    }
  } catch (e) {}

  const d = defaultData();
  saveData(d);
  return d;
}

// Union merge used when first pointing at a sync folder that already has data
function mergeData(remote, local) {
  const out = JSON.parse(JSON.stringify(remote));
  const have = new Set(out.tasks.map(t => t.id));
  const incoming = local.tasks.filter(t => !have.has(t.id));
  const listIds = new Set(out.lists.map(l => l.id));
  for (const t of incoming) {
    if (!listIds.has(t.listId)) {
      const l = local.lists.find(x => x.id === t.listId);
      if (l) { out.lists.push(l); listIds.add(l.id); }
    }
    out.tasks.push(t);
  }
  out.tagColors = { ...(local.tagColors || {}), ...(remote.tagColors || {}) };
  return normalizeData(out);
}

// ── Watch the data file for changes made by other devices ─────────
let watcher = null;
let watchTimer = null;
let streakTimer = null;

function startWatching() {
  stopWatching();
  try {
    watcher = fs.watch(dataDir(), (evt, fname) => {
      if (fname === 'streak.json') {
        clearTimeout(streakTimer);
        streakTimer = setTimeout(onExternalStreak, 400);
        return;
      }
      if (fname && fname !== 'tasks.json') return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(onExternalChange, 400);
    });
    watcher.on('error', () => {});
  } catch (e) {}
}
function onExternalStreak() {
  try {
    const raw = fs.readFileSync(streakPath(), 'utf8');
    const h = hash(raw);
    if (h === lastStreakHash) return;            // our own write
    JSON.parse(raw);                              // throws if mid-sync/partial
    lastStreakHash = h;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('streak-changed');
  } catch (e) {}
}
function stopWatching() {
  clearTimeout(watchTimer);
  clearTimeout(streakTimer);
  if (watcher) { try { watcher.close(); } catch (e) {} watcher = null; }
}
function onExternalChange() {
  try {
    const raw = fs.readFileSync(dataPath(), 'utf8');
    const h = hash(raw);
    if (h === lastWrittenHash) return;          // our own write
    const data = normalizeData(JSON.parse(raw)); // throws if mid-sync/partial
    lastWrittenHash = h;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('data-changed', data);
  } catch (e) {}
}

// ══════════════════════════════════════════════════════════════════
//  TRAY + BADGES
// ══════════════════════════════════════════════════════════════════
function baseIcon() {
  const p = path.join(__dirname, 'icon.ico');
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
}

// The renderer draws the red circle + number as a PNG (reliable, anti-aliased).
let badgeImage = null;

function composeTrayIcon() {
  const SIZE = 32, B = 20;
  const base = baseIcon();
  let bmp;
  if (base.isEmpty()) {
    bmp = Buffer.alloc(SIZE * SIZE * 4);
  } else {
    bmp = Buffer.from(base.resize({ width: SIZE, height: SIZE }).toBitmap());
    if (bmp.length !== SIZE * SIZE * 4) return base;
  }
  const badge = Buffer.from(badgeImage.resize({ width: B, height: B }).toBitmap());
  if (badge.length !== B * B * 4) return base;
  const ox = SIZE - B, oy = SIZE - B;
  for (let y = 0; y < B; y++) {
    for (let x = 0; x < B; x++) {
      const si = (y * B + x) * 4, di = ((oy + y) * SIZE + ox + x) * 4;
      const sa = badge[si + 3] / 255;
      if (sa === 0) continue;
      for (let c = 0; c < 4; c++) bmp[di + c] = Math.min(255, Math.round(badge[si + c] + bmp[di + c] * (1 - sa)));
    }
  }
  return nativeImage.createFromBitmap(bmp, { width: SIZE, height: SIZE, scaleFactor: 2 });
}

function refreshBadges() {
  const n = overdueCount;
  const hasBadge = n > 0 && badgeImage && !badgeImage.isEmpty();
  if (tray) {
    try { tray.setImage(hasBadge ? composeTrayIcon() : baseIcon()); } catch (e) {}
    tray.setToolTip(n > 0 ? `CandleTasks — ${n} overdue` : 'CandleTasks');
  }
  if (process.platform === 'win32') {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.setOverlayIcon(hasBadge ? badgeImage.resize({ width: 32, height: 32 }) : null, n > 0 ? `${n} overdue` : '');
      } catch (e) {}
    }
  } else {
    try { app.setBadgeCount(n); } catch (e) {}
  }
}

function createTray() {
  if (tray) return;
  tray = new Tray(baseIcon());
  tray.setToolTip('CandleTasks');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Quick add task…', click: () => openQuickAdd() },
    {
      label: 'Open CandleTasks',
      click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { tray?.destroy(); app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  });
  refreshBadges();
}

function destroyTray() {
  if (tray) { tray.destroy(); tray = null; }
}

// ── Quick-add popup ───────────────────────────────────────────────
function openQuickAdd(fromShortcut) {
  if (quickWin && !quickWin.isDestroyed()) { quickWin.show(); quickWin.focus(); return; }
  const s = loadSettings();
  const W = 340, H = 122;

  let x, y;
  const wa = screen.getPrimaryDisplay().workArea;
  x = wa.x + wa.width - W - 12;
  y = wa.y + wa.height - H - 12;
  if (fromShortcut) {
    // Launcher-style: upper-middle of whichever screen the cursor is on
    try {
      const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      x = Math.round(d.x + (d.width - W) / 2);
      y = Math.round(d.y + d.height * 0.22);
    } catch (e) {}
  }
  try {
    const b = !fromShortcut && tray ? tray.getBounds() : null;
    if (b && b.width > 0) {
      const d = screen.getDisplayMatching(b).workArea;
      x = Math.min(Math.max(Math.round(b.x + b.width / 2 - W / 2), d.x + 8), d.x + d.width - W - 8);
      y = b.y > d.y + d.height / 2 ? b.y - H - 8 : b.y + b.height + 8;
    }
  } catch (e) {}

  quickWin = new BrowserWindow({
    width: W, height: H, x, y,
    frame: false, resizable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false,
    backgroundColor: s.darkMode ? '#1a1510' : '#fdf6ec',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  quickWin.loadFile('quick.html');
  quickWin.once('ready-to-show', () => {
    quickWin.show();
    quickWin.focus();
    setTimeout(() => {
      if (quickWin && !quickWin.isDestroyed()) {
        quickWin.on('blur', () => { if (quickWin && !quickWin.isDestroyed()) quickWin.close(); });
      }
    }, 300);
  });
  quickWin.on('closed', () => { quickWin = null; });
}

// ── Window creation ───────────────────────────────────────────────
function createWindow() {
  const settings = loadSettings();
  inMini = !!settings.miniMode;
  const { width, height, x, y } = inMini ? { ...settings.miniBounds, x: settings.windowBounds.x, y: settings.windowBounds.y } : settings.windowBounds;
  const startHidden = process.argv.includes('--autostart') && !!settings.minimizeToTray;

  mainWindow = new BrowserWindow({
    width, height,
    x: x ?? undefined,
    y: y ?? undefined,
    minWidth: 240,
    minHeight: inMini ? 140 : 300,
    maxWidth: 600,
    maxHeight: 900,
    frame: false,
    transparent: false,
    resizable: true,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: false,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false     // keep timers exact while the window is hidden in the tray
    },
    backgroundColor: settings.darkMode ? '#1a1510' : '#fdf6ec'
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    applySnap(settings.snapPosition);
    mainWindow.setOpacity(clampOpacity(settings.windowOpacity));
    if (!startHidden) mainWindow.show();       // opened at login with the tray on: stay in the tray
    refreshBadges();
  });

  mainWindow.on('resize', saveBounds);
  mainWindow.on('moved', saveBounds);

  mainWindow.on('close', (e) => {
    const s = loadSettings();
    if (s.minimizeToTray && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function saveBounds() {
  if (!mainWindow) return;
  const settings = loadSettings();
  const [width, height] = mainWindow.getSize();
  const [x, y] = mainWindow.getPosition();
  // full-size and mini mode each remember their own size; position is shared
  if (inMini) settings.miniBounds = { ...settings.miniBounds, width, height };
  else settings.windowBounds = { ...settings.windowBounds, width, height };
  settings.windowBounds = { ...settings.windowBounds, x, y };
  settings.miniBounds = { ...settings.miniBounds, x, y };
  saveSettings(settings);
}

function applySnap(position) {
  if (!mainWindow || position === 'none') return;
  const wa = screen.getPrimaryDisplay().workArea;          // excludes the taskbar
  const [ww, wh] = mainWindow.getSize();
  const cx = Math.round(wa.x + (wa.width - ww) / 2);
  const cy = Math.max(wa.y, Math.round(wa.y + (wa.height - wh) / 2));
  const spots = {
    top:    [cx, wa.y],
    bottom: [cx, Math.max(wa.y, wa.y + wa.height - wh)],
    left:   [wa.x, cy],
    right:  [wa.x + wa.width - ww, cy]
  };
  const p = spots[position];
  if (p) mainWindow.setPosition(p[0], p[1]);
}

let loginOk = true;
function applyLoginItem(enabled) {
  if (!app.isPackaged) return !enabled;     // `npm start` would register a bare electron.exe, so only installed builds can
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,   // portable builds run from a temp folder
      args: ['--autostart']
    });
    return true;
  } catch (e) { return false; }
}

const QUICK_ADD_KEY = 'CommandOrControl+Alt+N';
let shortcutOk = false;
function registerGlobalShortcut(enabled) {
  try { globalShortcut.unregister(QUICK_ADD_KEY); } catch (e) {}
  shortcutOk = false;
  if (!enabled) return true;
  try { shortcutOk = globalShortcut.register(QUICK_ADD_KEY, () => openQuickAdd(true)); } catch (e) { shortcutOk = false; }
  return shortcutOk;
}

function applySettingsEffects(settings, opts = {}) {
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(settings.alwaysOnTop);
    mainWindow.setOpacity(clampOpacity(settings.windowOpacity));
    if (!opts.keepPosition) applySnap(settings.snapPosition);
  }
  if (settings.minimizeToTray) createTray();
  else destroyTray();
  registerGlobalShortcut(settings.globalQuickAdd !== false);
  loginOk = applyLoginItem(settings.launchAtLogin);
}

// ── Backup & restore ──────────────────────────────────────────────
const backupDir = () => path.join(app.getPath('documents'), 'CandleTasks Backups');
const PORTABLE_KEYS = ['alwaysOnTop', 'snapPosition', 'darkMode', 'reminderEnabled', 'reminderTime',
  'themeColor', 'customColor', 'uiStyle', 'compactMode', 'minimizeToTray', 'soundEnabled', 'notifyOverdue',
  'globalQuickAdd', 'weeklyReview', 'reviewTime', 'windowOpacity'];

function portableSettings(s) {
  const o = {};
  for (const k of PORTABLE_KEYS) if (s && k in s) o[k] = s[k];
  return o;
}
function stampNow() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
function buildBackup() {
  return {
    app: 'CandleTasks', backupVersion: 1, createdAt: new Date().toISOString(),
    data: loadData(), streak: loadStreak(), settings: portableSettings(loadSettings())
  };
}
function cleanStreak(s) {
  s = s && typeof s === 'object' ? s : {};
  const dates = Array.isArray(s.completedDates)
    ? [...new Set(s.completedDates.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(String(x))))].sort() : [];
  const isDate = x => /^\d{4}-\d{2}-\d{2}$/.test(String(x));
  const done = {};
  for (const [k, v] of Object.entries(s.doneByDate && typeof s.doneByDate === 'object' ? s.doneByDate : {})) {
    if (isDate(k) && Number(v) > 0) done[k] = Math.floor(Number(v));
  }
  return {
    count: Math.max(0, Number(s.count) || 0),
    lastCompletedDate: isDate(s.lastCompletedDate || '') ? s.lastCompletedDate : null,
    completedDates: dates,
    freezes: Math.max(0, Math.min(3, Math.floor(Number(s.freezes) || 0))),
    frozenDates: Array.isArray(s.frozenDates) ? [...new Set(s.frozenDates.filter(isDate))].sort() : [],
    best: Math.max(0, Math.floor(Number(s.best) || 0), Math.floor(Number(s.count) || 0)),
    doneByDate: done,
    journal: (Array.isArray(s.journal) ? s.journal : []).filter(e => e && isDate(e.date)).slice(-30).map(e => ({
      date: e.date, count: Math.max(0, Number(e.count) || 0), last: isDate(e.last || '') ? e.last : null,
      freezes: Math.max(0, Math.min(3, Number(e.freezes) || 0)), best: Math.max(0, Number(e.best) || 0)
    }))
  };
}

// ── IPC handlers ──────────────────────────────────────────────────
ipcMain.handle('get-data', () => loadData());
ipcMain.handle('save-data', (_, data) => { saveData(data); return true; });
ipcMain.handle('get-data-path', () => dataPath());

ipcMain.handle('choose-sync-folder', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a sync folder (e.g. inside Dropbox)',
    properties: ['openDirectory', 'createDirectory']
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

ipcMain.handle('set-sync-folder', (_, folder) => {
  const current = loadData();                 // read from the OLD location first
  const currentStreak = loadStreak();
  const settings = loadSettings();
  settings.syncFolder = folder || '';
  saveSettings(settings);
  stopWatching();

  let data;
  if (!folder) {
    data = current;                           // back to local: keep the working copy
    saveData(data);
  } else if (fs.existsSync(dataPath())) {
    data = mergeData(loadData(), current);    // folder already has data: merge, nothing lost
    saveData(data);
  } else {
    data = current;
    saveData(data);
  }
  // Streak: union with whatever the new location already has
  const remoteStreak = folder ? readStreakFile(streakPath()) : null;
  const streak = mergeStreak(remoteStreak, currentStreak);
  saveStreak(streak);

  startWatching();
  return { data, syncFolder: settings.syncFolder, streak };
});

ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_, incoming, opts) => {
  const cur = loadSettings();
  // Renderer copies of bounds / syncFolder can be stale — main owns them
  const settings = { ...cur, ...incoming, windowBounds: cur.windowBounds, syncFolder: cur.syncFolder };
  saveSettings(settings);
  applySettingsEffects(settings, { keepPosition: !!(opts && opts.keepPosition) });
  return { ok: true, shortcutOk: settings.globalQuickAdd === false ? true : shortcutOk, loginOk: settings.launchAtLogin ? loginOk : true };
});
ipcMain.handle('set-mini', (_, on) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  on = !!on;
  if (on === inMini) return true;
  const s = loadSettings();
  if (on) {                                            // remember the full-size window before shrinking
    const [w, h] = mainWindow.getSize();
    s.windowBounds = { ...s.windowBounds, width: w, height: h };
  }
  inMini = on;                                         // set first so the resize below is saved to the right place
  s.miniMode = on;
  saveSettings(s);
  if (on) {
    mainWindow.setMinimumSize(240, 140);
    mainWindow.setSize(Math.max(240, s.miniBounds.width || 320), Math.max(140, s.miniBounds.height || 320));
  } else {
    mainWindow.setMinimumSize(240, 300);
    mainWindow.setSize(s.windowBounds.width || 320, s.windowBounds.height || 520);
  }
  return true;
});
ipcMain.handle('set-opacity', (_, v) => { mainWindow?.setOpacity(clampOpacity(v)); return true; });

ipcMain.handle('get-streak', () => {
  const r = pruneFutureStreak(loadStreak());
  if (r.changed) saveStreak(r.streak);
  return r.streak;
});
ipcMain.handle('update-streak', (_, data) => {
  // Merge with disk so a stale device can never overwrite another device's progress.
  // Future-dated entries (clock changes) are dropped on both sides first so they can't come back.
  const disk = pruneFutureStreak(readStreakFile(streakPath()) || emptyStreak()).streak;
  const merged = mergeStreak(disk, pruneFutureStreak(data).streak);
  saveStreak(merged);
  return merged;
});
ipcMain.handle('prune-streak', (_, incoming) => {
  const r = pruneFutureStreak(incoming && typeof incoming === 'object' ? incoming : emptyStreak());
  if (r.changed) saveStreak(r.streak);
  return r;
});

ipcMain.handle('set-overdue', (_, n, dataUrl) => {
  const v = Math.max(0, Number(n) || 0);
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png')) {
    try { badgeImage = nativeImage.createFromDataURL(dataUrl); } catch (e) { badgeImage = null; }
  }
  if (v !== overdueCount || dataUrl) { overdueCount = v; refreshBadges(); }
  return true;
});

ipcMain.handle('quick-add', (_, { text, listId }) => {
  const raw = String(text || '').trim().slice(0, 140);
  if (!raw) return false;
  const data = loadData();
  const p = NLP.parse(raw, new Date());                // plain-word dates, repeats, #tags, !priority
  const targetList = data.lists.some(l => l.id === listId) ? listId : data.activeListId;
  const today = new Date();
  const ds = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  data.tasks.push(normalizeRecur(normalizeTask({
    id: uid(), listId: targetList, text: p.text.slice(0, 120), tags: p.tags, priority: p.priority,
    due: p.due, dueTime: p.dueTime, recur: p.recur, recurDays: p.recurDays, recurEvery: p.recurEvery,
    recurUnit: p.recurUnit, recurMonthDay: p.recurMonthDay, addedDate: ds
  }, targetList)));
  saveData(data);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('data-changed', data);
  return true;
});
ipcMain.handle('close-quick', () => { if (quickWin && !quickWin.isDestroyed()) quickWin.close(); return true; });

ipcMain.handle('send-notification', (_, { title, body, action }) => {
  if (Notification.isSupported()) {
    const n = new Notification({ title, body });
    n.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show(); mainWindow.focus();
        if (action) mainWindow.webContents.send('open-view', action);
      }
    });
    n.show();
  }
  return true;
});

ipcMain.handle('minimize-window', () => mainWindow?.minimize());
ipcMain.handle('close-window', () => {
  const settings = loadSettings();
  if (settings.minimizeToTray) mainWindow?.hide();
  else mainWindow?.close();
});

// ── Backup / restore IPC ──────────────────────────────────────────
ipcMain.handle('backup-data', () => {
  try {
    fs.mkdirSync(backupDir(), { recursive: true });
    const filePath = path.join(backupDir(), `candletasks-backup-${stampNow()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(buildBackup(), null, 2));
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('show-in-folder', (_, p) => { try { shell.showItemInFolder(p); } catch (e) {} return true; });

ipcMain.handle('restore-data', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: 'Restore from backup',
    defaultPath: backupDir(),
    properties: ['openFile'],
    filters: [{ name: 'CandleTasks backup', extensions: ['json'] }]
  });
  if (canceled || !filePaths || !filePaths.length) return { canceled: true };

  let payload;
  try { payload = JSON.parse(fs.readFileSync(filePaths[0], 'utf8')); }
  catch (e) { return { ok: false, error: 'That file is not a valid backup.' }; }
  if (!payload || payload.app !== 'CandleTasks' || !payload.data || !Array.isArray(payload.data.tasks)) {
    return { ok: false, error: 'That file is not a CandleTasks backup.' };
  }

  const when = payload.createdAt ? new Date(payload.createdAt).toLocaleString() : 'unknown date';
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning', buttons: ['Restore', 'Cancel'], defaultId: 1, cancelId: 1,
    title: 'Restore backup',
    message: 'Replace your current tasks and streak with this backup?',
    detail: `Backup made ${when}. A safety copy of your current data is saved first.`
  });
  if (response !== 0) return { canceled: true };

  let safetyCopy = null;
  try {
    fs.mkdirSync(backupDir(), { recursive: true });
    safetyCopy = path.join(backupDir(), `candletasks-before-restore-${stampNow()}.json`);
    fs.writeFileSync(safetyCopy, JSON.stringify(buildBackup(), null, 2));
  } catch (e) { safetyCopy = null; }

  const data = normalizeData(payload.data);
  saveData(data);
  const streak = cleanStreak(payload.streak);
  saveStreak(streak);
  const settings = { ...loadSettings(), ...portableSettings(payload.settings || {}) };
  saveSettings(settings);
  applySettingsEffects(settings);
  return { ok: true, data, streak, settings, safetyCopy };
});

app.on('before-quit', () => { isQuitting = true; stopWatching(); });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) {} });

app.whenReady().then(() => {
  loadData();            // runs the v1 → v2 migration early if needed
  createWindow();
  startWatching();
  const settings = loadSettings();
  if (settings.minimizeToTray) createTray();
  registerGlobalShortcut(settings.globalQuickAdd !== false);
  if (settings.launchAtLogin) applyLoginItem(true);       // keep the saved path current (e.g. portable builds)
});

app.on('window-all-closed', () => {
  const settings = loadSettings();
  if (!settings.minimizeToTray) app.quit();
});
