// ══════════════════════════════════════════════════════════════════
//  CandleTasks renderer
// ══════════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const MAX_LEN = 120;
const MILESTONES = [3, 7, 14, 30, 60, 100, 365];

// ── State ─────────────────────────────────────────────────────────
let tasks    = [];
let lists    = [];
let activeListId = null;
let settings = {};
let streak   = { count: 0, lastCompletedDate: null, completedDates: [], freezes: 0, frozenDates: [], best: 0, doneByDate: {} };
let lastReminderKey = '';

let selectedId = null;            // keyboard-selected task
let smartView = null;             // null | 'today' | 'overdue' | 'week'  (gathers tasks from every list)
let miniMode = false;
let tagColors = {};               // tag (lower-case) -> #hex
let sortMode = 'manual';          // 'manual' | 'priority' | 'due'
try { const sm = localStorage.getItem('ct_sort'); if (['manual', 'priority', 'due'].includes(sm)) sortMode = sm; } catch (e) {}
let archiveView = false;
let searchQuery = '';
let tagFilter   = null;
const expanded  = new Set();      // task ids whose detail panel is open
let renamingListId = null;
let pendingFocus   = null;        // { id, sel } re-focus after a re-render
let pendingExternal = null;       // sync update held back while the user is typing
let dragId = null;
let lastOverdue = -1;
const undoStack = [];

// ── Audio engine (Web Audio API — no files needed) ────────────────
let audioCtx = null;
function soundOn() { return settings.soundEnabled !== false; }

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
  return audioCtx;
}

function playTone(type, freqs, duration, volume = 0.18) {
  if (!soundOn()) return;
  try {
    const ctx    = getAudioCtx();
    const master = ctx.createGain();
    master.gain.setValueAtTime(volume, ctx.currentTime);
    master.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    master.connect(ctx.destination);

    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.06);
      osc.connect(master);
      osc.start(ctx.currentTime + i * 0.06);
      osc.stop(ctx.currentTime + duration + i * 0.06);
    });
  } catch (e) { /* audio not available */ }
}

function sfxAdd()       { playTone('sine',     [520, 660],            0.18, 0.15); }
function sfxComplete()  { playTone('sine',     [440, 550, 660],       0.28, 0.14); }
function sfxUncomplete(){ playTone('sine',     [440, 350],            0.18, 0.10); }
function sfxDelete()    { playTone('triangle', [180, 120],            0.22, 0.14); }
// Celebration: rising fanfare, a held major chord, sparkles and confetti pops (all synthesised)
function sfxCelebrate() {
  if (!soundOn()) return;
  try {
    const ctx = getAudioCtx();
    const t0 = ctx.currentTime + 0.03;
    const master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);

    const note = (freq, start, dur, type, vol) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0 + start);
      g.gain.setValueAtTime(0.0001, t0 + start);
      g.gain.exponentialRampToValueAtTime(vol, t0 + start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      o.connect(g); g.connect(master);
      o.start(t0 + start);
      o.stop(t0 + start + dur + 0.05);
    };

    const chord = [523.25, 659.25, 783.99, 1046.5];                 // C5 E5 G5 C6
    chord.forEach((f, i) => note(f, i * 0.09, 0.35, 'triangle', 0.2));         // fanfare run
    chord.forEach(f => { note(f, 0.42, 1.1, 'sine', 0.14); note(f * 2, 0.42, 0.8, 'sine', 0.05); });   // held chord
    for (let i = 0; i < 8; i++) note(1800 + Math.random() * 1800, 0.48 + i * 0.09, 0.18, 'sine', 0.06); // sparkles

    // confetti pops: short bursts of band-passed noise
    const len = Math.floor(ctx.sampleRate * 0.06);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    for (let i = 0; i < 7; i++) {
      const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      src.buffer = buf;
      f.type = 'bandpass'; f.frequency.value = 2500 + Math.random() * 2500; f.Q.value = 0.8;
      g.gain.value = 0.25;
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t0 + 0.05 + i * 0.07 + Math.random() * 0.03);
    }
  } catch (e) { /* audio not available */ }
}

// ── Flame tier config ─────────────────────────────────────────────
const TIERS = [
  { min:-1,  outerTop:'#4B4847', outerBot:'#4B4847', innerTop:'#666463', innerBot:'#666463', spark:'#7A7877', glow:'rgba(100,100,100,0.3)', dayColor:'#555'    },
  { min:1,   outerTop:'#FF9500', outerBot:'#FF7700', innerTop:'#FFD000', innerBot:'#FFB800', spark:'#FFF3B8', glow:'rgba(255,140,0,0.55)',  dayColor:'#FF7700'  },
  { min:7,   outerTop:'#FF6500', outerBot:'#FF3D00', innerTop:'#FFB000', innerBot:'#FF8C00', spark:'#FFE57F', glow:'rgba(255,80,0,0.6)',    dayColor:'#FF3D00'  },
  { min:14,  outerTop:'#D81B60', outerBot:'#B71C1C', innerTop:'#FF6090', innerBot:'#FF4081', spark:'#FFD1DC', glow:'rgba(200,20,80,0.65)',  dayColor:'#C2185B'  },
  { min:30,  outerTop:'#AA00FF', outerBot:'#8E24AA', innerTop:'#F080FF', innerBot:'#E040FB', spark:'#F8BBD0', glow:'rgba(160,0,255,0.6)',   dayColor:'#8E24AA'  },
  { min:60,  outerTop:'#FF1E8E', outerBot:'#F50057', innerTop:'#FFB0D0', innerBot:'#FF80AB', spark:'#FFF0F5', glow:'rgba(245,0,87,0.65)',   dayColor:'#F50057'  },
  { min:100, outerTop:'#FF4DB8', outerBot:'#FF1493', innerTop:'#FFD6E0', innerBot:'#FFB6C1', spark:'#FFFFFF', glow:'rgba(255,20,147,0.7)',  dayColor:'#FF1493'  },
  { min:365, outerTop:'#5CE1E6', outerBot:'#0095FF', innerTop:'#E0F7FA', innerBot:'#5CE1E6', spark:'#E0F7FA', glow:'rgba(0,149,255,0.7)',   dayColor:'#0095FF'  },
];

function getTier(count, active) {
  if (!active || count === 0) return TIERS[0];
  let tier = TIERS[1];
  for (const t of TIERS) { if (count >= t.min) tier = t; }
  return tier;
}

// ── Apply flame colors ────────────────────────────────────────────
function applyFlameColors(svgEl, tier, active, ids) {
  $(ids.ogTop).setAttribute('stop-color', tier.outerTop);
  $(ids.ogBot).setAttribute('stop-color', tier.outerBot);
  $(ids.igTop).setAttribute('stop-color', tier.innerTop);
  $(ids.igBot).setAttribute('stop-color', tier.innerBot);
  $(ids.spark).setAttribute('fill', tier.spark);

  const isLit = active && streak.count > 0;
  svgEl.classList.toggle('active', isLit);
  svgEl.classList.toggle('dead',  !isLit);
  svgEl.style.filter = isLit ? `drop-shadow(0 0 5px ${tier.glow})` : 'none';
}

// Ignition pop fires on the wrapper div so the child path animations keep running.
function igniteFlame(wrapEl) {
  wrapEl.classList.remove('igniting');
  void wrapEl.offsetWidth;
  wrapEl.classList.add('igniting');
  setTimeout(() => wrapEl.classList.remove('igniting'), 600);
}

// ── Helpers: dates / text ─────────────────────────────────────────
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function todayStr() { return dateKey(new Date()); }
function offsetDate(days) {
  const d = new Date(); d.setDate(d.getDate() + days);
  return dateKey(d);
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return dateKey(new Date(y, m - 1, d + n));
}
function dayDiff(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}
function formatDate(iso) {
  // Output is interpolated into innerHTML elsewhere, so only ever return digits and a slash
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}
function shortText(s, n = 28) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
const sameTag = (a, b) => a.toLowerCase() === b.toLowerCase();


const TAG_PALETTE = ['#e5484d', '#e5832d', '#2f9e6a', '#14a3a3', '#3b82f6', '#8b5cf6', '#e0489a', '#7a8594'];

function styleTagChip(chip, tag) {
  chip.dataset.tag = tag;
  const c = tagColors[tag.toLowerCase()];
  if (c) { chip.classList.add('has-color'); chip.style.setProperty('--tag', c); }
}
function setTagColor(tag, color) {
  mutate('Tag color', () => {
    const k = tag.toLowerCase();
    if (color) tagColors[k] = color; else delete tagColors[k];
  });
}
function openTagPop(tag, x, y) {
  const pop = $('tag-pop');
  pop.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'tp-title';
  title.textContent = `Color for #${tag}`;
  pop.appendChild(title);
  const row = document.createElement('div');
  row.className = 'tp-row';
  const cur = tagColors[tag.toLowerCase()];
  TAG_PALETTE.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tp-swatch' + (cur === c ? ' on' : '');
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => { closeTagPop(); setTagColor(tag, c); });
    row.appendChild(b);
  });
  pop.appendChild(row);
  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'tp-reset';
  none.textContent = 'Use theme color';
  none.addEventListener('click', () => { closeTagPop(); setTagColor(tag, null); });
  pop.appendChild(none);
  pop.classList.remove('hidden');
  pop.style.left = Math.max(6, Math.min(x, window.innerWidth - pop.offsetWidth - 6)) + 'px';
  pop.style.top  = Math.max(6, Math.min(y, window.innerHeight - pop.offsetHeight - 6)) + 'px';
}
function closeTagPop() { $('tag-pop').classList.add('hidden'); }

function addTagTo(task, raw) {
  const tag = raw.trim().replace(/^#+/, '').replace(/\s+/g, '-').slice(0, 24);
  if (!tag || task.tags.some(t => sameTag(t, tag))) return false;
  task.tags.push(tag);
  return true;
}

// ── Init ──────────────────────────────────────────────────────────
async function init() {
  settings = await window.api.getSettings();
  streak   = normStreak(await window.api.getStreak());
  applyLoadedData(await window.api.getData());
  migrateStreak();

  if (settings.uiStyle === 'minimal') settings.uiStyle = 'glass';   // legacy value
  miniMode = !!settings.miniMode;
  applyAppearance();
  renderAll();
  renderStreak();
  renderSoundBtn();
  renderMiniBtn();
  $('sort-select').value = sortMode;
  loadSettingsUI();
  runTick();
  startMinuteTicker();
  window.addEventListener('focus', runTick);

  $('tasks-path-label').textContent = await window.api.getDataPath();
  refreshSyncLabel();

  // App updates: show the version, pick up anything found before the window was ready, listen for more
  try {
    const u = await window.api.getUpdateState();
    updInfo.current = String((u && u.current) || '');
    $('upd-status').textContent = updInfo.current ? `Version ${updInfo.current}` : '';
    if (u && u.last) onUpdateStatus(u.last);
  } catch (e) {}
  window.api.onUpdateStatus(onUpdateStatus);

  // A notification asked to open a screen (the weekly review opens Stats)
  window.api.onOpenView(v => { if (v === 'stats') { calView = 'stats'; openStreakModal(); } });

  // Another device updated the streak
  window.api.onStreakChanged(async () => { adoptStreak(await window.api.getStreak()); });

  // Another device (or the quick-add popup) changed tasks.json
  window.api.onDataChanged(d => {
    if (isEditingActive()) { pendingExternal = d; return; }
    applyLoadedData(d);
    renderAll();
    checkOverdueNotifications();
  });
}

function applyLoadedData(d) {
  lists = d.lists;
  tasks = d.tasks;
  tagColors = d.tagColors || {};
  activeListId = activeListId && lists.some(l => l.id === activeListId) ? activeListId : d.activeListId;
}

function persist() {
  window.api.saveData({ version: 2, lists, activeListId, tasks, tagColors });
}

function isEditingActive() {
  const a = document.activeElement;
  if (renamingListId) return true;
  return !!(a && a.closest && a.closest('#task-list') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
}
function flushExternal() {
  if (pendingExternal && !isEditingActive()) {
    applyLoadedData(pendingExternal);
    pendingExternal = null;
    renderAll();
  }
}

// ── Appearance ────────────────────────────────────────────────────
const CUSTOM_VARS = ['--accent', '--accent-2', '--accent-bg', '--accent-border', '--accent-glow', '--bg', '--bg-2', '--bg-3', '--border'];

// Accent colour → full set of theme variables (lightness is clamped so white text stays readable)
function customAccentVars(hex, dark, plain) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0, l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  s = Math.min(.9, Math.max(.4, s));
  l = Math.min(.58, Math.max(.36, l));
  const H = Math.round(h), S = Math.round(s * 100), L = Math.round(l * 100);
  const v = {
    '--accent': `hsl(${H} ${S}% ${L}%)`,
    '--accent-2': `hsl(${H} ${S}% ${Math.min(72, L + 12)}%)`,
    '--accent-bg': `hsla(${H} ${S}% ${L}% / .14)`,
    '--accent-border': `hsla(${H} ${S}% ${L}% / .36)`,
    '--accent-glow': `hsla(${H} ${S}% ${L}% / .32)`
  };
  // Plain UI style tints its backgrounds like the built-in colour themes do
  if (plain) Object.assign(v, dark
    ? { '--bg': `hsl(${H} 22% 8%)`, '--bg-2': `hsl(${H} 22% 11%)`, '--bg-3': `hsl(${H} 22% 14%)`, '--border': `hsl(${H} 20% 21%)` }
    : { '--bg': `hsl(${H} 60% 96%)`, '--bg-2': `hsl(${H} 55% 92%)`, '--bg-3': `hsl(${H} 50% 88%)`, '--border': `hsl(${H} 40% 76%)` });
  return v;
}

// overrides lets Settings preview a change before it is saved
function applyAppearance(overrides) {
  const body = $('app-body');
  const s = { ...settings, ...(overrides || {}) };
  if (s.themeColor === 'yellow') s.themeColor = 'default';          // option was removed
  const dark  = s.darkMode ? 'dark' : 'light';
  const colorMap = { default:'', custom:'', green:'theme-green', blue:'theme-blue', red:'theme-red' };
  const styleMap = { default:'', glass:'ui-glass', minimal:'ui-glass', brutalism:'ui-brutalism', bento:'ui-bento' };
  body.className = [dark, colorMap[s.themeColor] || '', styleMap[s.uiStyle] || '', (s.compactMode || s.miniMode) ? 'compact' : '', s.miniMode ? 'mini' : '']
    .filter(Boolean).join(' ');
  CUSTOM_VARS.forEach(k => body.style.removeProperty(k));
  if (s.themeColor === 'custom' && /^#[0-9a-f]{6}$/i.test(s.customColor || '')) {
    const vars = customAccentVars(s.customColor, !!s.darkMode, (s.uiStyle || 'default') === 'default');
    for (const [k, v] of Object.entries(vars)) body.style.setProperty(k, v);
  }
}

// ── Streak helpers ────────────────────────────────────────────────
function normStreak(s) {
  // Defence in depth: main sanitises streak data too, but several values below go into innerHTML,
  // so make sure they are plain numbers / valid dates no matter where the object came from.
  s = s && typeof s === 'object' ? s : {};
  const isDate = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
  const num = v => { v = Math.floor(Number(v)); return Number.isFinite(v) && v > 0 ? Math.min(v, 100000) : 0; };
  s.count             = num(s.count);
  s.lastCompletedDate = isDate(s.lastCompletedDate) ? s.lastCompletedDate : null;
  s.completedDates    = Array.isArray(s.completedDates) ? s.completedDates.filter(isDate) : [];
  s.frozenDates       = Array.isArray(s.frozenDates) ? s.frozenDates.filter(isDate) : [];
  s.freezes           = Math.max(0, Math.min(3, num(s.freezes)));
  const done = {};
  for (const [k, v] of Object.entries(s.doneByDate && typeof s.doneByDate === 'object' ? s.doneByDate : {})) {
    if (isDate(k) && num(v) > 0) done[k] = num(v);
  }
  s.doneByDate        = done;
  s.best              = Math.max(num(s.best), s.count);
  s.journal           = (Array.isArray(s.journal) ? s.journal : []).filter(e => e && isDate(e.date)).map(e => ({
    date: e.date, count: num(e.count), last: isDate(e.last) ? e.last : null, freezes: Math.min(3, num(e.freezes)), best: num(e.best)
  }));
  return s;
}

// A streak survives a gap of up to 2 days for free, plus one extra day per freeze held
function isActive() {
  if (!streak.count || !streak.lastCompletedDate) return false;
  const gap = dayDiff(streak.lastCompletedDate, todayStr());
  return gap <= 2 + (streak.freezes || 0);
}

function renderStreak() {
  const label  = $('streak-label');
  const svg    = $('flame-svg');
  const active = isActive();
  const tier   = getTier(streak.count, active);

  label.textContent = !active || streak.count === 0
    ? (streak.count > 0 ? `${streak.count}d (paused)` : '0 day streak')
    : `${streak.count} day streak`;

  applyFlameColors(svg, tier, active, {
    ogTop:'og-top', ogBot:'og-bottom',
    igTop:'ig-top', igBot:'ig-bottom',
    spark:'f-spark'
  });
}

// Seeds completedDates once for streak files created before it existed.
function migrateStreak() {
  let changed = false;
  if (!Array.isArray(streak.completedDates)) {
    const set = new Set(tasks.filter(t => t.completedDate).map(t => t.completedDate));
    if (streak.lastCompletedDate) set.add(streak.lastCompletedDate);
    streak.completedDates = [...set].sort();
    changed = true;
  }
  if (!streak.doneByDate || typeof streak.doneByDate !== 'object') {
    streak.doneByDate = {};
    tasks.forEach(t => { if (t.done && t.completedDate) streak.doneByDate[t.completedDate] = (streak.doneByDate[t.completedDate] || 0) + 1; });
    streak.completedDates.forEach(d => { if (!streak.doneByDate[d]) streak.doneByDate[d] = 1; });
    changed = true;
  }
  normStreak(streak);
  if (changed) saveStreakState();
}

// Called only when a task is COMPLETED. Unchecking, archiving, deleting or
// undoing never touches the streak.
const freezeLeft = n => `You have ${n} left.`;

function checkStreak() {
  const today = todayStr();
  normStreak(streak);

  streak.doneByDate[today] = (streak.doneByDate[today] || 0) + 1;
  if (!streak.completedDates.includes(today)) streak.completedDates.push(today);

  if (streak.lastCompletedDate && streak.lastCompletedDate >= today) {
    saveStreakState();
    return;
  }

  // remember the state before this new streak day so it can be rolled back if the clock was wrong
  streak.journal.push({ date: today, count: streak.count, last: streak.lastCompletedDate, freezes: streak.freezes, best: streak.best });
  if (streak.journal.length > 30) streak.journal.shift();

  // gap 1 = yesterday, 2 = one missed day (free), 3+ = extra missed days that need freezes
  let wasActive = false, needed = 0;
  if (streak.count > 0 && streak.lastCompletedDate) {
    const gap = dayDiff(streak.lastCompletedDate, today);
    needed = Math.max(0, gap - 2);
    wasActive = needed <= streak.freezes;
  }

  if (wasActive) {
    if (needed > 0) {
      streak.freezes -= needed;
      for (let k = 0; k < needed; k++) streak.frozenDates.push(addDays(streak.lastCompletedDate, 2 + k));
      streak.frozenDates.sort();
    }
    streak.count += 1;
  } else {
    streak.count = 1;
  }
  streak.lastCompletedDate = today;
  streak.best = Math.max(streak.best, streak.count);

  let earned = false;
  if (wasActive && streak.count % 7 === 0 && streak.freezes < 3) { streak.freezes += 1; earned = true; }

  saveStreakState();
  renderStreak();
  igniteFlame($('flame-icon'));

  if (MILESTONES.includes(streak.count)) celebrate(streak.count, getTier(streak.count, true), earned);
  else if (earned) showToast(`You earned a streak freeze. ${freezeLeft(streak.freezes)}`, null, null, 5500);
  else if (needed > 0) showToast(`${needed} streak freeze${needed !== 1 ? 's' : ''} used to save your streak. ${freezeLeft(streak.freezes)}`, null, null, 5500);
}

// Save the streak; the main process merges it with the synced copy and returns the result.
function adoptStreak(m) {
  if (!m || typeof m !== 'object') return;
  const sum = o => Object.values(o || {}).reduce((a, b) => a + b, 0);
  const newer =
    (m.completedDates || []).length > (streak.completedDates || []).length ||
    (m.lastCompletedDate || '') > (streak.lastCompletedDate || '') ||
    (m.frozenDates || []).length > (streak.frozenDates || []).length ||
    sum(m.doneByDate) > sum(streak.doneByDate) ||
    (m.best || 0) > (streak.best || 0);
  if (newer) {
    streak = normStreak(JSON.parse(JSON.stringify(m)));
    renderStreak();
  }
}
function saveStreakState() {
  window.api.updateStreak(streak).then(adoptStreak).catch(() => {});
}

// ── Toast ─────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, actionLabel, action, ms = 5500) {
  const t = $('toast'), b = $('toast-action');
  $('toast-msg').textContent = msg;
  if (actionLabel) {
    b.textContent = actionLabel;
    b.classList.remove('hidden');
    b.onclick = () => { hideToast(); if (action) action(); };
  } else {
    b.classList.add('hidden');
    b.onclick = null;
  }
  t.classList.remove('hidden', 'show');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('toast').classList.add('hidden'); }

// ── Milestone celebration ─────────────────────────────────────────
let confettiRaf = null;
function celebrate(days, tier, earnedFreeze) {
  showToast(`${days}-day streak! ${earnedFreeze ? `You earned a streak freeze. ${freezeLeft(streak.freezes)}` : 'Keep the fire going.'}`, null, null, 5500);
  sfxCelebrate();
  fireConfetti(tier);
}

function fireConfetti(tier) {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c   = $('confetti-canvas');
  const dpr = window.devicePixelRatio || 1;
  const W = window.innerWidth, H = window.innerHeight;
  c.width = W * dpr; c.height = H * dpr;
  c.style.display = 'block';
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (confettiRaf) cancelAnimationFrame(confettiRaf);

  const colors = [tier.outerTop, tier.outerBot, tier.innerTop, tier.innerBot, tier.spark, '#ffffff'];
  const parts = [];
  const origins = [[W * 0.5, H * 0.30, 70], [W * 0.15, H * 0.55, 20], [W * 0.85, H * 0.55, 20]];
  for (const [ox, oy, n] of origins) {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.25;
      const s = 4 + Math.random() * 8;
      parts.push({
        x: ox, y: oy, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        w: 5 + Math.random() * 5, h: 3 + Math.random() * 5,
        rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
        color: colors[(Math.random() * colors.length) | 0],
        round: Math.random() < 0.3
      });
    }
  }

  const DURATION = 2600;
  const t0 = performance.now();
  (function frame(now) {
    const t = now - t0;
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += 0.22; p.vx *= 0.99;
      p.x += p.vx;  p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, (DURATION - t) / 900));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, 6.28); ctx.fill(); }
      else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t < DURATION) confettiRaf = requestAnimationFrame(frame);
    else { ctx.clearRect(0, 0, W, H); c.style.display = 'none'; confettiRaf = null; }
  })(t0);
}

// ── Streak modal ──────────────────────────────────────────────────
let calView = 'week';     // 'week' | 'month'
let calOffset = 0;        // 0 = current week/month, -1 = previous, ...

function currentTier() { return getTier(streak.count, isActive()); }

function openStreakModal() {
  const modal   = $('streak-modal');
  const msgEl   = $('modal-msg');
  const msvg    = $('modal-flame-svg');
  const mwrap   = $('modal-flame-wrap');
  const active  = isActive();
  const tier    = getTier(streak.count, active);

  applyFlameColors(msvg, tier, active, {
    ogTop:'mog-top', ogBot:'mog-bottom',
    igTop:'mig-top', igBot:'mig-bottom',
    spark:'mf-spark'
  });
  mwrap.style.filter = active && streak.count > 0 ? `drop-shadow(0 0 24px ${tier.glow})` : 'none';
  $('modal-count').textContent = streak.count;

  const doneToday = streak.completedDates.includes(todayStr());
  if (!active || streak.count === 0) {
    msgEl.textContent = 'Complete a task today to start your streak.';
  } else if (doneToday) {
    msgEl.textContent = "You're on a roll! Today was added to your streak.";
  } else {
    msgEl.textContent = 'Complete a task today to keep your streak going!';
  }

  renderFreezeInfo();

  calOffset = 0;
  renderCalendar();
  modal.classList.remove('hidden');
  $('modal-card').scrollTop = 0;

  if (active && streak.count > 0) setTimeout(() => igniteFlame(mwrap), 150);
}

// Streak freezes left, shown under the streak count. A freeze is earned on every 7th day of the streak (max 3).
const MAX_FREEZES = 3;
function freezeInfo(count, held) {
  const n = Math.max(0, Math.min(MAX_FREEZES, Math.floor(Number(held) || 0)));
  const c = Math.max(0, Math.floor(Number(count) || 0));
  const main = n === 0 ? 'No streak freezes left' : `${n} of ${MAX_FREEZES} streak freezes left`;
  const sub = n >= MAX_FREEZES ? 'Freezes are full'
    : `Next freeze at day ${(Math.floor(c / 7) + 1) * 7}`;
  return { n, main, sub };
}
function renderFreezeInfo() {
  const box = $('modal-freeze');
  const info = freezeInfo(streak.count, streak.freezes);
  box.textContent = '';
  const row = document.createElement('div');
  row.className = 'fz-row';
  for (let i = 0; i < MAX_FREEZES; i++) {
    const s = document.createElement('span');
    s.className = 'fz' + (i < info.n ? ' on' : '');
    s.textContent = '\u2744';
    row.appendChild(s);
  }
  const main = document.createElement('div'); main.className = 'fz-text'; main.textContent = info.main;
  const sub  = document.createElement('div'); sub.className  = 'fz-sub';  sub.textContent  = info.sub;
  box.append(row, main, sub);
  box.title = 'A freeze covers one extra missed day so your streak survives. You earn one every 7 days, up to 3.';
}

function closeStreakModal() { $('streak-modal').classList.add('hidden'); }

const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function renderStats() {
  const el = $('stats-view');
  const done = streak.doneByDate || {};
  const total = Object.values(done).reduce((a, b) => a + b, 0);

  // last 8 weeks (Sunday-start), oldest first
  const start = new Date();
  start.setDate(start.getDate() - start.getDay() - 7 * 7);
  const weeks = [];
  for (let i = 0; i < 8; i++) {
    const ws = new Date(start); ws.setDate(start.getDate() + i * 7);
    let n = 0;
    for (let k = 0; k < 7; k++) { const d = new Date(ws); d.setDate(ws.getDate() + k); n += done[dateKey(d)] || 0; }
    weeks.push({ label: `${ws.getDate()}/${ws.getMonth() + 1}`, n });
  }
  const maxW = Math.max(1, ...weeks.map(w => w.n));

  const perDay = Array(7).fill(0);
  for (const [d, n] of Object.entries(done)) perDay[weekdayOf(d)] += n;
  const maxD = Math.max(...perDay);
  const busiest = maxD > 0 ? perDay.indexOf(maxD) : -1;

  const bars = (arr, max, peak) => arr.map((x, i) =>
    `<div class="bar-col"><span class="bar-n">${x.n || ''}</span><div class="bar-wrap"><div class="bar${peak === i ? ' peak' : ''}" style="height:${x.n ? Math.max(6, Math.round(x.n / max * 100)) : 0}%"></div></div><span class="bar-l">${x.label}</span></div>`).join('');

  el.innerHTML = `
    <div class="stat-tiles">
      <div class="stat-tile"><b>${streak.count}</b><span>Current streak</span></div>
      <div class="stat-tile"><b>${streak.best}</b><span>Best streak</span></div>
      <div class="stat-tile"><b>${total}</b><span>Tasks completed</span></div>
      <div class="stat-tile"><b>${streak.completedDates.length}</b><span>Active days</span></div>
    </div>
    <div class="stat-h">Completed per week</div>
    <div class="bars">${bars(weeks, maxW, -1)}</div>
    <div class="stat-h">By day of week</div>
    <div class="bars">${bars(perDay.map((n, i) => ({ n, label: DAY_FULL[i].slice(0, 2) })), Math.max(1, maxD), busiest)}</div>
    <div class="stat-note">${busiest >= 0 ? `Busiest day: ${DAY_FULL[busiest]} (${maxD} task${maxD !== 1 ? 's' : ''})` : 'Complete tasks to see your patterns.'}</div>`;
}

function renderCalendar() {
  const tier  = currentTier();
  const grid  = $('modal-week');
  const today = todayStr();
  const done  = new Set(streak.completedDates);
  const sorted = [...streak.completedDates].sort();
  const earliest = sorted.length ? sorted[0] : today;
  const dows = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  grid.innerHTML = '';
  grid.style.setProperty('--day-color', tier.dayColor);
  const statsView = calView === 'stats';
  $('modal-card').classList.toggle('compact', calView !== 'week');
  $('stats-view').classList.toggle('hidden', !statsView);
  ['cal-nav', 'modal-week', 'cal-caption'].forEach(id => $(id).classList.toggle('hidden', statsView));
  if (statsView) {
    document.querySelectorAll('#modal-tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === calView));
    renderStats();
    return;
  }
  document.querySelectorAll('#modal-tabs button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === calView));

  dows.forEach(d => {
    const h = document.createElement('div');
    h.className = 'cal-dow';
    h.textContent = d;
    grid.appendChild(h);
  });

  let cells = [], title = '', caption = '', prevDisabled = false;

  if (calView === 'week') {
    const start = new Date();
    start.setDate(start.getDate() - start.getDay() + calOffset * 7);
    for (let i = 0; i < 7; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      cells.push(dateKey(d));
    }
    const fmt = s => { const [, m, d] = s.split('-'); return `${d}/${m}`; };
    title = calOffset === 0 ? 'This week' : calOffset === -1 ? 'Last week' : `${fmt(cells[0])} – ${fmt(cells[6])}`;
    const n = cells.filter(c => done.has(c)).length;
    caption = `${n} of 7 days completed`;
    prevDisabled = cells[0] <= earliest;
  } else {
    const first = new Date();
    first.setDate(1);
    first.setMonth(first.getMonth() + calOffset);
    const y = first.getFullYear(), m = first.getMonth();
    const days = new Date(y, m + 1, 0).getDate();
    cells = Array(first.getDay()).fill(null);
    for (let d = 1; d <= days; d++) cells.push(dateKey(new Date(y, m, d)));
    title = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const prefix = dateKey(first).slice(0, 7);
    const n = streak.completedDates.filter(c => c.startsWith(prefix)).length;
    caption = `${n} active day${n !== 1 ? 's' : ''} this month`;
    prevDisabled = dateKey(first).slice(0, 7) <= earliest.slice(0, 7);
  }

  for (const dateStr of cells) {
    if (!dateStr) {
      const e = document.createElement('div');
      e.className = 'cal-empty';
      grid.appendChild(e);
      continue;
    }
    const box = document.createElement('div');
    const dayNum = Number(dateStr.slice(8));
    const hadTask = done.has(dateStr);
    box.className = 'week-day-box cal-cell';
    box.title = dateStr;
    if (hadTask) {
      box.classList.add('done');
      box.textContent = calView === 'week' ? '✓' : dayNum;
      box.style.color = '#fff';
    } else if ((streak.frozenDates || []).includes(dateStr)) {
      box.classList.add('frozen');
      box.textContent = '❄';
      box.title = dateStr + ' (streak freeze)';
    } else {
      box.textContent = dayNum;
      if (dateStr === today) box.classList.add('today-empty');
      else if (dateStr > today) box.classList.add('future');
    }
    grid.appendChild(box);
  }

  $('cal-title').textContent = title;
  $('cal-caption').textContent = caption;
  $('cal-prev').disabled = prevDisabled;
  $('cal-next').disabled = calOffset >= 0;
}

// ── App updates ───────────────────────────────────────────────────
// Everything here is rendered with textContent only; the values come from the main process.
const updInfo = { current: '', phase: '' };
function setUpdLabel(text) { $('upd-status').textContent = text; }
function closeUpdModal() { $('update-modal').classList.add('hidden'); }
function showUpdModal(title, msg, opts = {}) {
  const { percent = null, buttons = [] } = opts;
  $('upd-title').textContent = title;
  $('upd-msg').textContent = msg;
  $('upd-bar').classList.toggle('hidden', percent === null);
  $('upd-fill').style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
  const box = $('upd-actions');
  box.textContent = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.className = 'upd-btn' + (b.primary ? ' primary' : '');
    el.textContent = b.label;
    el.addEventListener('click', b.onClick);
    box.appendChild(el);
  }
  $('update-modal').classList.remove('hidden');
}
function onUpdateStatus(st) {
  if (!st || typeof st !== 'object') return;
  const v = typeof st.version === 'string' ? st.version : '';
  const later = () => { window.api.updateLater(); closeUpdModal(); };
  const prev = updInfo.phase;
  updInfo.phase = st.state;
  switch (st.state) {
    case 'checking': setUpdLabel('Checking for updates...'); break;
    case 'none':     setUpdLabel(`You\u2019re up to date (v${updInfo.current}).`); break;
    case 'disabled': setUpdLabel(String(st.message || '')); break;
    case 'available':
      setUpdLabel(`v${v} is available.`);
      showUpdModal('Update available', `CandleTasks v${v} is ready (you have v${updInfo.current}). Only the changed parts are downloaded where possible, and your tasks are not touched.`, {
        buttons: [{ label: 'Download now', primary: true, onClick: () => window.api.downloadUpdate() }, { label: 'Later', onClick: later }]
      });
      break;
    case 'downloading': {
      const pct = Math.round(Number(st.percent) || 0);
      setUpdLabel(`Downloading v${v}... ${pct}%`);
      if (prev === 'downloading') { $('upd-msg').textContent = `${pct}%`; $('upd-fill').style.width = `${pct}%`; }   // keep the buttons, update the bar
      else showUpdModal('Downloading update', `${pct}%`, { percent: pct, buttons: [{ label: 'Hide', onClick: closeUpdModal }] });
      break;
    }
    case 'ready':
      setUpdLabel(`v${v} is ready to install.`);
      showUpdModal('Ready to install', 'Restart CandleTasks to finish updating. If you choose Later, it installs the next time you quit.', {
        buttons: [{ label: 'Restart now', primary: true, onClick: () => window.api.installUpdate() }, { label: 'Later', onClick: closeUpdModal }]
      });
      break;
    case 'portable':
      setUpdLabel(`v${v} is available.`);
      showUpdModal('New version available', `CandleTasks v${v} is out (you have v${updInfo.current}). The portable version can't update itself, so download the new portable file from the releases page.`, {
        buttons: [{ label: 'Open download page', primary: true, onClick: () => { window.api.openReleasePage(); closeUpdModal(); } }, { label: 'Later', onClick: later }]
      });
      break;
    case 'error':
      setUpdLabel(String(st.message || 'Update problem.'));
      if (st.showModal) showUpdModal('Update problem', String(st.message || ''), { buttons: [{ label: 'Close', onClick: closeUpdModal }] });
      break;
  }
}

// ── Help modal ────────────────────────────────────────────────────
function openHelp()  { $('help-modal').classList.remove('hidden'); $('help-card').scrollTop = 0; }
function closeHelp() { $('help-modal').classList.add('hidden'); }

// ── Sound toggle (titlebar) ───────────────────────────────────────
function renderSoundBtn() {
  const on = soundOn();
  const b = $('sound-btn');
  b.classList.toggle('muted', !on);
  b.setAttribute('aria-pressed', String(on));
  b.title = on ? 'Sound on (click to mute)' : 'Sound off (click to unmute)';
}
function renderMiniBtn() {
  const b = $('mini-btn');
  b.classList.toggle('on', miniMode);
  b.setAttribute('aria-pressed', String(miniMode));
  b.title = miniMode ? 'Full view (Ctrl+M)' : 'Mini mode (Ctrl+M)';
}
function toggleMini() {
  closeStreakModal();
  closeHelp();
  closeTagPop();
  if (settingsOpen()) showMain();
  miniMode = !miniMode;
  settings.miniMode = miniMode;
  archiveView = false;
  window.api.setMini(miniMode);          // main process resizes the window
  applyAppearance();
  renderMiniBtn();
  renderAll();
}

function toggleSound() {
  settings.soundEnabled = !soundOn();
  window.api.saveSettings(settings, { keepPosition: true });   // don't re-snap the window
  renderSoundBtn();
  if (soundOn()) sfxAdd();
}

// ══════════════════════════════════════════════════════════════════
//  TASKS
// ══════════════════════════════════════════════════════════════════
const ICON_ARCHIVE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>';
const ICON_RESTORE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>';
const ICON_CHECK   = '<svg class="check-icon" viewBox="0 0 12 10" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1.5,5.5 4.5,8.5 10.5,1.5"/></svg>';
const ICON_PIN     = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 3h6l-1 7 3 3v2H7v-2l3-3-1-7z"/></svg>';
const ICON_CHEV    = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
const ICON_EDIT    = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

// ── Undo ──────────────────────────────────────────────────────────
// Every mutation goes through mutate(): snapshot → change → save → render.
function mutate(label, fn, toastMsg) {
  undoStack.push({ label, snap: JSON.stringify({ lists, activeListId, tasks, tagColors }) });
  if (undoStack.length > 40) undoStack.shift();
  fn();
  persist();
  renderAll();
  if (toastMsg) showToast(toastMsg, 'Undo', undo);
}

function undo() {
  const e = undoStack.pop();
  if (!e) { showToast('Nothing to undo'); return; }
  const s = JSON.parse(e.snap);
  lists = s.lists;
  tasks = s.tasks;
  tagColors = s.tagColors || {};
  if (!lists.some(l => l.id === activeListId)) activeListId = s.activeListId;
  persist();
  renderAll();
  showToast(`Undid: ${e.label}`);
}

function newTask(partial) {
  return {
    id: uid(), listId: activeListId, text: '', done: false, due: null,
    dueTime: null, addedDate: todayStr(), completedDate: null, archived: false, pinned: false,
    tags: [], notes: '', subtasks: [], priority: 0, recur: null, recurDays: [], recurEvery: 1, recurUnit: 'week', recurMonthDay: 1, ...partial
  };
}

// ── Lists ─────────────────────────────────────────────────────────
function renderListTabs() {
  const el = $('list-tabs');
  el.innerHTML = '';

  for (const l of lists) {
    if (renamingListId === l.id) {
      const inp = document.createElement('input');
      inp.className = 'list-rename';
      inp.value = l.name;
      inp.maxLength = 24;
      let finished = false;
      const finish = save => {
        if (finished) return;
        finished = true;
        renamingListId = null;
        const v = inp.value.trim();
        if (save && v && v !== l.name) mutate('Rename list', () => { l.name = v; });
        else renderListTabs();
        flushExternal();
      };
      inp.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      inp.addEventListener('blur', () => finish(true));
      el.appendChild(inp);
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
      continue;
    }

    const isActiveTab = l.id === activeListId && !smartView;
    const openCount = tasks.filter(t => t.listId === l.id && !t.archived && !t.done).length;
    const tab = document.createElement('div');
    tab.className = 'list-tab' + (isActiveTab ? ' active' : '');
    tab.setAttribute('role', 'tab');

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'list-name';
    name.textContent = l.name;
    name.title = isActiveTab ? 'Double-click to rename' : `Switch to ${l.name}`;
    name.addEventListener('click', () => switchList(l.id));
    name.addEventListener('dblclick', () => { renamingListId = l.id; renderListTabs(); });
    tab.appendChild(name);

    // drop a dragged task here to move it to this list
    tab.addEventListener('dragover', e => {
      if (!dragId) return;
      const dragged = tasks.find(x => x.id === dragId);
      if (!dragged || dragged.listId === l.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tab.classList.add('drop-target');
    });
    tab.addEventListener('dragleave', () => tab.classList.remove('drop-target'));
    tab.addEventListener('drop', e => {
      if (!dragId) return;
      e.preventDefault();
      tab.classList.remove('drop-target');
      const t = tasks.find(x => x.id === dragId);
      dragId = null;
      if (t && t.listId !== l.id) mutate('Move task', () => { t.listId = l.id; }, `Moved to "${l.name}"`);
    });

    if (openCount > 0) {
      const c = document.createElement('span');
      c.className = 'list-count';
      c.textContent = openCount;
      tab.appendChild(c);
    }
    if (isActiveTab) {
      const ren = document.createElement('button');
      ren.type = 'button'; ren.className = 'list-mini'; ren.title = 'Rename list';
      ren.innerHTML = ICON_EDIT;
      ren.addEventListener('click', () => { renamingListId = l.id; renderListTabs(); });
      tab.appendChild(ren);
      if (lists.length > 1) {
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'list-mini danger'; del.title = 'Delete list';
        del.innerHTML = '&#10005;';
        del.addEventListener('click', () => deleteList(l));
        tab.appendChild(del);
      }
    }
    el.appendChild(tab);
  }
  const act = el.querySelector('.list-tab.active');
  if (act && act.scrollIntoView) act.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function switchList(id) {
  if (id === activeListId && !smartView) return;
  smartView = null;
  activeListId = id;
  archiveView = false;
  tagFilter = null;
  persist();
  renderAll();
}

function addList() {
  const l = { id: uid(), name: 'New list' };
  mutate('Add list', () => {
    lists.push(l);
    activeListId = l.id;
    smartView = null;
    archiveView = false;
    tagFilter = null;
  });
  renamingListId = l.id;
  renderListTabs();
  sfxAdd();
}

function deleteList(l) {
  if (lists.length < 2) return;
  const n = tasks.filter(t => t.listId === l.id).length;
  mutate('Delete list', () => {
    lists = lists.filter(x => x.id !== l.id);
    tasks = tasks.filter(t => t.listId !== l.id);
    activeListId = lists[0].id;
    archiveView = false;
    tagFilter = null;
  }, `Deleted list "${l.name}"${n ? ` and ${n} task${n !== 1 ? 's' : ''}` : ''}`);
  sfxDelete();
}

// ── Filtering ─────────────────────────────────────────────────────
function matchesSearch(t, q) {
  const tagQ = q.replace(/^#/, '');
  return t.text.toLowerCase().includes(q) ||
         t.notes.toLowerCase().includes(q) ||
         t.tags.some(x => x.toLowerCase().includes(tagQ)) ||
         t.subtasks.some(s => s.text.toLowerCase().includes(q));
}

function isFiltering() { return !!searchQuery.trim() || !!tagFilter; }

function smartMatch(t, view) {
  const today = todayStr();
  if (view === 'today') return t.due === today;
  if (view === 'overdue') return isOverdue(t);
  if (view === 'week') return !!t.due && t.due > today && t.due <= addDays(today, 7);
  return false;
}

// every task the current view is built from, before search / tag filters
function baseTasks() {
  const today = todayStr();
  if (miniMode) return tasks.filter(t => !t.archived && t.due && (t.due === today || isOverdue(t)));
  if (smartView) return tasks.filter(t => !t.archived && !t.done && smartMatch(t, smartView));
  return tasks.filter(t => t.listId === activeListId && !!t.archived === archiveView);
}

const dueKey = t => (t.due ? `${t.due} ${t.dueTime || '99:99'}` : '9999-99-99');
const cmpDue = (a, b) => { const x = dueKey(a), y = dueKey(b); return x < y ? -1 : x > y ? 1 : 0; };
function sortedBy(arr, mode) {
  if (mode === 'priority') return [...arr].sort((a, b) => (b.priority || 0) - (a.priority || 0));        // stable: manual order breaks ties
  if (mode === 'due') return [...arr].sort((a, b) => cmpDue(a, b) || (b.priority || 0) - (a.priority || 0));
  return arr;
}

function visibleTasks() {
  if (miniMode) {
    return [...baseTasks()].sort((a, b) => ((a.done ? 1 : 0) - (b.done ? 1 : 0)) || cmpDue(a, b) || (b.priority || 0) - (a.priority || 0));
  }
  const q = searchQuery.trim().toLowerCase();
  let arr = baseTasks();
  if (tagFilter) arr = arr.filter(t => t.tags.some(x => sameTag(x, tagFilter)));
  if (q) arr = arr.filter(t => matchesSearch(t, q));
  if (archiveView && !smartView) return arr;
  const mode = smartView && sortMode === 'manual' ? 'due' : sortMode;               // smart views read best by date
  return [...sortedBy(arr.filter(t => t.pinned), mode), ...sortedBy(arr.filter(t => !t.pinned), mode)];   // pinned first
}

function smartCounts() {
  const today = todayStr(), end = addDays(today, 7);
  let t = 0, o = 0, w = 0;
  for (const x of tasks) {
    if (x.archived || x.done) continue;
    if (x.due === today) t++;
    if (isOverdue(x)) o++;
    if (x.due && x.due > today && x.due <= end) w++;
  }
  return { today: t, overdue: o, week: w };
}
function renderViewBar() {
  const c = smartCounts();
  for (const k of ['today', 'overdue', 'week']) $('vc-' + k).textContent = c[k];
  $('vc-overdue').classList.toggle('alert', c.overdue > 0);
  document.querySelectorAll('.view-chip').forEach(b => b.classList.toggle('on', b.dataset.view === smartView));
}
function setSmartView(v) {
  smartView = smartView === v ? null : v;
  archiveView = false;
  tagFilter = null;
  renderAll();
}

function renderTagFilter() {
  const el = $('tag-filter');
  const pool = baseTasks();
  const map = new Map();
  pool.forEach(t => t.tags.forEach(tag => {
    const k = tag.toLowerCase();
    if (!map.has(k)) map.set(k, { tag, n: 0 });
    map.get(k).n++;
  }));
  if (tagFilter && !map.has(tagFilter.toLowerCase())) tagFilter = null;

  el.innerHTML = '';
  el.classList.toggle('hidden', map.size === 0);
  [...map.values()].sort((a, b) => a.tag.localeCompare(b.tag)).forEach(({ tag, n }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tag-chip filter' + (tagFilter && sameTag(tagFilter, tag) ? ' on' : '');
    b.textContent = `#${tag}`;
    b.title = `${n} task${n !== 1 ? 's' : ''}. Right-click to change its color`;
    styleTagChip(b, tag);
    b.addEventListener('click', () => setTagFilter(tag));
    el.appendChild(b);
  });
}

function setTagFilter(tag) {
  tagFilter = tagFilter && sameTag(tagFilter, tag) ? null : tag;
  renderTagFilter();
  renderTasks();
}

// ── Rendering ─────────────────────────────────────────────────────
function renderAll() {
  renderListTabs();
  renderTagFilter();
  renderTasks();
}

function backText(task) {
  const next = nextDue(task);
  const days = dayDiff(todayStr(), next);
  if (days <= 0) return 'resetting';
  if (days === 1) return 'back tomorrow';
  if (task.recur === 'days' && days < 7) return `back ${DAY_NAMES[weekdayOf(next)]}`;
  return `back in ${days} days`;
}

function renderTasks() {
  const list       = $('task-list');
  const empty      = $('empty-hint');
  const count      = $('footer-count');
  const archiveBtn = $('archive-btn');
  const clearBtn   = $('clear-done-btn');
  const mainView   = $('main-view');

  const special = miniMode || !!smartView;
  const mine = tasks.filter(t => t.listId === activeListId);
  const archivedCount = mine.filter(t => t.archived).length;
  if (special || (archiveView && archivedCount === 0)) archiveView = false;
  renderViewBar();

  const activeTasks = mine.filter(t => !t.archived);
  const doneCount   = activeTasks.filter(t => t.done).length;
  const filtering   = isFiltering();
  const visible     = visibleTasks();

  mainView.classList.toggle('archive-mode', archiveView);
  archiveBtn.classList.toggle('hidden', archivedCount === 0 || special);
  archiveBtn.textContent = archiveView ? '\u2190 Back' : `Archive (${archivedCount})`;
  clearBtn.classList.toggle('hidden', archiveView || special);
  $('delete-all-btn').classList.toggle('hidden', !archiveView);
  if (!archiveView) resetDeleteAll();
  $('delete-all-btn').title = `Permanently delete all ${archivedCount} archived task${archivedCount !== 1 ? 's' : ''} in this list`;

  if (miniMode) {
    const d = visible.filter(t => t.done).length;
    count.textContent = visible.length ? `${d}/${visible.length} done today` : '';
  } else if (smartView) count.textContent = `${visible.length} task${visible.length !== 1 ? 's' : ''}`;
  else if (archiveView) count.textContent = `${visible.length} archived`;
  else if (!activeTasks.length) count.textContent = '';
  else count.textContent = filtering
    ? `${visible.length} shown · ${doneCount}/${activeTasks.length} done`
    : `${doneCount}/${activeTasks.length} done`;

  empty.textContent = miniMode ? 'Nothing due today. Type a task above.'
    : smartView ? { today: 'Nothing due today.', overdue: 'Nothing overdue. Nice.', week: 'Nothing due in the next 7 days.' }[smartView]
    : filtering ? 'No tasks match.'
    : archiveView ? 'No archived tasks.' : 'No tasks yet. Add one above.';
  empty.style.display = visible.length ? 'none' : 'block';

  list.innerHTML = '';
  const canDrag = !archiveView && !miniMode;   // dragging to another list works while filtering too
  const canReorder = !archiveView && !filtering && !special && sortMode === 'manual';
  for (const task of visible) list.appendChild(buildTaskRow(task, canDrag, canReorder));

  if (pendingFocus) {
    const target = list.querySelector(`[data-id="${pendingFocus.id}"] ${pendingFocus.sel}`);
    if (target) target.focus();
    pendingFocus = null;
  }
  updateOverdueBadge();
}

const pad2 = n => String(n).padStart(2, '0');
function nowHM() { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function formatTime(hm) {
  if (typeof hm !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hm)) return '';
  const [h, m] = hm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
// A task with a time is overdue once that time has passed today
function isOverdue(t) {
  if (!t.due || t.done || t.archived) return false;
  const today = todayStr();
  if (t.due < today) return true;
  return t.due === today && !!t.dueTime && nowHM() > t.dueTime;
}
function isDueNow(t) {
  return !t.done && !t.archived && !!t.due && t.due === todayStr() && !!t.dueTime && nowHM() >= t.dueTime;
}
function overdueTasks() { return tasks.filter(isOverdue); }

// Red circle + number, drawn here and composited onto the tray/taskbar icon by the main process
function makeBadgeDataUrl(n) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fillStyle = '#E53935'; g.fill();
  g.lineWidth = 3; g.strokeStyle = '#ffffff'; g.stroke();
  const label = n > 9 ? '9+' : String(n);
  g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `bold ${label.length > 1 ? 30 : 38}px "Segoe UI", Arial, sans-serif`;
  g.fillText(label, 32, 35);
  return c.toDataURL('image/png');
}

function updateOverdueBadge() {
  const n = overdueTasks().length;
  const pill = $('overdue-pill');
  pill.textContent = `${n} overdue`;
  pill.title = `${n} overdue task${n !== 1 ? 's' : ''} across all lists`;
  pill.classList.toggle('hidden', n === 0);
  const changed = n !== lastOverdue;
  if (changed) {
    lastOverdue = n;
    window.api.setOverdue(n, n > 0 ? makeBadgeDataUrl(n) : '');
  }
  return changed;
}

// Desktop alert once per task when it becomes overdue (remembered per due date on this device)
function loadNotified() {
  try { return JSON.parse(localStorage.getItem('ct_overdue_notified') || '{}'); } catch (e) { return {}; }
}
function checkOverdueNotifications() {
  if (settings.notifyOverdue === false) return;
  const due = tasks.filter(t => isOverdue(t) || isDueNow(t));
  const notified = loadNotified();
  const keyOf = t => `${t.due}|${t.dueTime || ''}`;
  const keep = {};
  due.forEach(t => { if (notified[t.id] === keyOf(t)) keep[t.id] = keyOf(t); });
  const fresh = due.filter(t => notified[t.id] !== keyOf(t));
  if (fresh.length) {
    let title, body;
    if (fresh.length === 1) {
      const t = fresh[0];
      const now = isDueNow(t) && !isOverdue(t);
      title = now ? 'Task due now' : 'Task overdue';
      body = now ? `"${shortText(t.text, 60)}" is due (${formatTime(t.dueTime)})`
                 : `"${shortText(t.text, 60)}" was due ${formatDate(t.due)}${t.dueTime ? ' ' + formatTime(t.dueTime) : ''}`;
    } else {
      title = `${fresh.length} tasks need attention`;
      body = fresh.slice(0, 3).map(t => `• ${shortText(t.text, 40)}`).join('\n') + (fresh.length > 3 ? `\n+${fresh.length - 3} more` : '');
    }
    window.api.sendNotification({ title, body });
    fresh.forEach(t => { keep[t.id] = keyOf(t); });
  }
  try { localStorage.setItem('ct_overdue_notified', JSON.stringify(keep)); } catch (e) {}
}

function buildTaskRow(task, canDrag, canReorder) {
  const li = document.createElement('li');
  const isOpen = expanded.has(task.id) && !archiveView;
  li.className = 'task-item' + (task.done ? ' done' : '') + (task.pinned ? ' pinned' : '') + (isOpen ? ' expanded' : '');
  li.dataset.id = task.id;
  if (task.id === selectedId) li.classList.add('selected');

  const today   = todayStr();
  const overdue = isOverdue(task);

  const bits = [];
  if (smartView && !miniMode) bits.push('<span class="list-badge"></span>');     // which list this came from
  if (task.due) bits.push(`<span class="task-due ${overdue ? 'overdue' : ''}">Due: ${formatDate(task.due)}${task.dueTime ? ' ' + formatTime(task.dueTime) : ''}${overdue ? ' · overdue' : ''}</span>`);
  if (overdue && !archiveView) bits.push('<span class="snooze"><button type="button" class="snooze-chip" data-snooze="1">Tomorrow</button><button type="button" class="snooze-chip" data-snooze="7">Next week</button></span>');
  if (task.recur) bits.push(`<span class="task-info" title="Repeats ${recurLabel(task)}">↻ ${recurLabel(task)}${task.done && task.completedDate ? ' · ' + backText(task) : ''}</span>`);
  if (task.subtasks.length) {
    const d = task.subtasks.filter(s => s.done).length;
    bits.push(`<span class="task-info" title="Steps">${d}/${task.subtasks.length} steps</span>`);
  }
  if (task.notes.trim()) bits.push('<span class="task-info" title="Has notes">Notes</span>');
  if (task.addedDate) bits.push(`<span class="task-added">Added: ${formatDate(task.addedDate)}</span>`);

  const actions = archiveView
    ? `<button type="button" class="task-act" data-act="restore" title="Restore">${ICON_RESTORE}</button>
       <button type="button" class="task-act danger" data-act="delete" title="Delete permanently">&#10005;</button>`
    : `<button type="button" class="task-act pin${task.pinned ? ' on' : ''}" data-act="pin" title="${task.pinned ? 'Unpin' : 'Pin to top'}">${ICON_PIN}</button>
       <button type="button" class="task-act exp${isOpen ? ' on' : ''}" data-act="expand" title="Details">${ICON_CHEV}</button>
       <button type="button" class="task-act" data-act="archive" title="Archive">${ICON_ARCHIVE}</button>`;

  const main = document.createElement('div');
  main.className = 'task-main';
  main.addEventListener('mousedown', () => setSelected(task.id, false));
  main.innerHTML = `
    <button type="button" class="task-check${task.done ? ' checked' : ''}${task.priority ? ' p' + task.priority : ''}" role="checkbox"
            title="${['', 'Low priority', 'Medium priority', 'High priority'][task.priority || 0]}"
            aria-checked="${task.done}" ${archiveView ? 'disabled' : ''}>${ICON_CHECK}</button>
    <div class="task-content">
      <span class="task-text"></span>
      <div class="task-meta">${bits.join('')}</div>
      ${task.tags.length ? '<div class="task-tags"></div>' : ''}
    </div>
    <div class="task-actions">${actions}</div>`;

  const textEl = main.querySelector('.task-text');
  textEl.textContent = task.text;
  const badge = main.querySelector('.list-badge');
  if (badge) badge.textContent = (lists.find(l => l.id === task.listId) || {}).name || '';

  const tagsEl = main.querySelector('.task-tags');
  if (tagsEl) task.tags.forEach(tag => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-chip' + (tagFilter && sameTag(tagFilter, tag) ? ' on' : '');
    chip.textContent = `#${tag}`;
    chip.title = 'Filter by this tag (right-click for color)';
    styleTagChip(chip, tag);
    chip.addEventListener('click', () => setTagFilter(tag));
    tagsEl.appendChild(chip);
  });

  if (!archiveView) {
    main.querySelector('.task-check').addEventListener('click', () => toggleTask(task));
    textEl.classList.add('editable');
    textEl.title = 'Click to edit';
    textEl.addEventListener('click', () => startEdit(task, li, main, textEl));
    main.querySelectorAll('.task-info').forEach(el =>
      el.addEventListener('click', () => toggleExpand(task.id)));
    main.querySelectorAll('.snooze-chip').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); snoozeTask(task, Number(b.dataset.snooze)); }));
  }

  main.querySelectorAll('.task-act').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if (act === 'archive') archiveTask(task);
      else if (act === 'restore') restoreTask(task);
      else if (act === 'delete') deleteForever(task);
      else if (act === 'pin') togglePin(task);
      else if (act === 'expand') toggleExpand(task.id);
    });
  });

  // ── drag & drop reorder (only unfiltered, active view) ──
  if (canDrag) {
    main.draggable = true;
    main.addEventListener('dragstart', e => {
      dragId = task.id;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', task.id);
    });
    main.addEventListener('dragend', () => { dragId = null; clearDropMarks(); li.classList.remove('dragging'); });
    li.addEventListener('dragover', e => {
      if (!canReorder || !dragId || dragId === task.id) return;
      const src = tasks.find(t => t.id === dragId);
      if (!src || !!src.pinned !== !!task.pinned) return;       // pinned and unpinned stay in their own groups
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = li.getBoundingClientRect();
      clearDropMarks();
      li.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
    });
    li.addEventListener('dragleave', e => {
      if (!li.contains(e.relatedTarget)) li.classList.remove('drop-before', 'drop-after');
    });
    li.addEventListener('drop', e => {
      if (!canReorder || !dragId || dragId === task.id) return;
      e.preventDefault();
      const after = li.classList.contains('drop-after');
      const from = dragId;
      dragId = null;
      clearDropMarks();
      reorderTask(from, task.id, after);
    });
  }

  li.appendChild(main);
  if (isOpen) li.appendChild(buildDetail(task));
  return li;
}

function setSelected(id, scroll) {
  selectedId = id;
  document.querySelectorAll('#task-list .task-item').forEach(li => li.classList.toggle('selected', li.dataset.id === id));
  if (scroll && id) {
    const li = document.querySelector(`#task-list [data-id="${id}"]`);
    if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
  }
}

function clearDropMarks() {
  document.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
}

function reorderTask(srcId, targetId, after) {
  const src = tasks.find(t => t.id === srcId);
  if (!src || srcId === targetId) return;
  mutate('Reorder tasks', () => {
    tasks.splice(tasks.indexOf(src), 1);
    let ti = tasks.findIndex(t => t.id === targetId);
    if (after) ti++;
    tasks.splice(ti, 0, src);
  });
}

// ── Detail panel: notes, steps, tags, repeat, due, list ───────────
function buildDetail(task) {
  const d = document.createElement('div');
  d.className = 'task-detail';
  d.innerHTML = `
    <label class="d-label">Notes</label>
    <textarea class="d-notes" rows="3" maxlength="2000" placeholder="Add a note..."></textarea>
    <label class="d-label">Steps</label>
    <ul class="d-subs"></ul>
    <input type="text" class="d-input d-sub-add" maxlength="120" placeholder="Add a step, press Enter" />
    <label class="d-label">Tags</label>
    <div class="d-tags"></div>
    <div class="d-grid">
      <label>Repeat
        <select class="d-recur">
          <option value="">None</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="days">Custom days</option>
          <option value="every">Every N...</option>
          <option value="after">N after done...</option>
          <option value="monthday">Monthly on day...</option>
        </select>
      </label>
      <label>Due <input type="date" class="d-due" /></label>
      <label>Time <input type="time" class="d-time" /></label>
      <label>Priority
        <select class="d-prio">
          <option value="0">None</option>
          <option value="1">Low</option>
          <option value="2">Medium</option>
          <option value="3">High</option>
        </select>
      </label>
      <label class="d-wide">List <select class="d-list"></select></label>
    </div>
    <div class="d-days"></div>
    <div class="d-recur-extra"></div>`;

  // notes: save quietly, no re-render (so typing never loses focus)
  const notes = d.querySelector('.d-notes');
  notes.value = task.notes;
  let notesTimer = null;
  notes.addEventListener('input', () => {
    task.notes = notes.value;
    clearTimeout(notesTimer);
    notesTimer = setTimeout(persist, 500);
  });
  notes.addEventListener('blur', () => { clearTimeout(notesTimer); persist(); flushExternal(); });

  // steps
  const subs = d.querySelector('.d-subs');
  task.subtasks.forEach(s => {
    const row = document.createElement('li');
    row.className = 'd-sub' + (s.done ? ' done' : '');
    row.innerHTML = `<button type="button" class="task-check sm${s.done ? ' checked' : ''}" role="checkbox" aria-checked="${s.done}">${ICON_CHECK}</button>
      <span class="d-sub-text"></span>
      <button type="button" class="task-act danger" title="Remove step">&#10005;</button>`;
    row.querySelector('.d-sub-text').textContent = s.text;
    row.querySelector('.task-check').addEventListener('click', () =>
      mutate('Toggle step', () => { s.done = !s.done; }));
    row.querySelector('.task-act').addEventListener('click', () =>
      mutate('Remove step', () => { task.subtasks = task.subtasks.filter(x => x !== s); }));
    subs.appendChild(row);
  });
  const subAdd = d.querySelector('.d-sub-add');
  subAdd.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = subAdd.value.trim();
      if (!v) return;
      pendingFocus = { id: task.id, sel: '.d-sub-add' };
      mutate('Add step', () => { task.subtasks.push({ id: uid(), text: v, done: false }); });
    }
  });

  // tags
  const tagBox = d.querySelector('.d-tags');
  task.tags.forEach(tag => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip removable';
    chip.innerHTML = '<span class="tag-name"></span><button type="button" title="Remove tag">&#10005;</button>';
    chip.querySelector('.tag-name').textContent = `#${tag}`;
    styleTagChip(chip, tag);
    chip.querySelector('button').addEventListener('click', () =>
      mutate('Remove tag', () => { task.tags = task.tags.filter(t => t !== tag); }));
    tagBox.appendChild(chip);
  });
  const tagAdd = document.createElement('input');
  tagAdd.type = 'text'; tagAdd.className = 'd-input d-tag-add'; tagAdd.maxLength = 24;
  tagAdd.placeholder = 'Add tag';
  tagAdd.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = tagAdd.value;
      if (!v.trim()) return;
      pendingFocus = { id: task.id, sel: '.d-tag-add' };
      mutate('Add tag', () => { addTagTo(task, v); });
    }
  });
  tagBox.appendChild(tagAdd);

  // repeat / due / list
  const recur = d.querySelector('.d-recur');
  recur.value = task.recur || '';
  recur.addEventListener('change', () => mutate('Change repeat', () => {
    const prev = task.recur;
    task.recur = recur.value || null;
    if (task.recur === 'days' && !(task.recurDays || []).length) task.recurDays = [...DEFAULT_DAYS];
    if (task.recur === 'every' && prev !== 'every') { task.recurEvery = 1; task.recurUnit = 'week'; }
    if (task.recur === 'after' && prev !== 'after') { task.recurEvery = 3; task.recurUnit = 'day'; }
    if (task.recur === 'monthday' && prev !== 'monthday') task.recurMonthDay = task.due ? Number(task.due.slice(8)) : 1;
  }));
  const extra = d.querySelector('.d-recur-extra');
  if (['every', 'after', 'monthday'].includes(task.recur)) {
    buildRecurExtra(extra, task, patch => mutate('Change repeat', () => { Object.assign(task, patch); }));
  } else {
    extra.remove();
  }
  const prio = d.querySelector('.d-prio');
  prio.value = String(task.priority || 0);
  prio.addEventListener('change', () => mutate('Change priority', () => { task.priority = Number(prio.value) || 0; }));
  const daysBox = d.querySelector('.d-days');
  if (task.recur === 'days') {
    buildDayChips(daysBox, task.recurDays, i => {
      const next = toggleDay(task.recurDays, i);
      if (next !== task.recurDays) mutate('Change repeat days', () => { task.recurDays = next; });
    });
  } else {
    daysBox.remove();
  }

  const due = d.querySelector('.d-due');
  due.value = task.due || '';
  due.addEventListener('change', () => mutate('Change due date', () => { task.due = due.value || null; if (!task.due) task.dueTime = null; }));
  const dueTime = d.querySelector('.d-time');
  dueTime.value = task.dueTime || '';
  dueTime.disabled = !task.due;
  dueTime.addEventListener('change', () => mutate('Change due time', () => { task.dueTime = task.due ? (dueTime.value || null) : null; }));

  const listSel = d.querySelector('.d-list');
  lists.forEach(l => {
    const o = document.createElement('option');
    o.value = l.id; o.textContent = l.name;
    if (l.id === task.listId) o.selected = true;
    listSel.appendChild(o);
  });
  listSel.addEventListener('change', () => {
    const target = lists.find(l => l.id === listSel.value);
    if (!target || target.id === task.listId) return;
    mutate('Move task', () => { task.listId = target.id; }, `Moved to "${target.name}"`);
  });

  return d;
}

function snoozeTask(task, days) {
  const nd = offsetDate(days);
  mutate('Snooze task', () => { task.due = nd; }, `Snoozed to ${DAY_NAMES[weekdayOf(nd)]} ${formatDate(nd)}`);
}

function toggleExpand(id) {
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  renderTasks();
}

// ── Inline edit ───────────────────────────────────────────────────
function startEdit(task, li, main, textEl) {
  if (li.querySelector('.task-edit')) return;
  main.draggable = false;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'task-edit';
  input.value = task.text;
  input.maxLength = MAX_LEN;
  textEl.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = save => {
    if (finished) return;
    finished = true;
    const v = input.value.trim();
    if (save && v && v !== task.text) mutate('Edit task', () => { task.text = v; });
    else renderTasks();
    flushExternal();
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// ── Task actions ──────────────────────────────────────────────────
function updateCharCount() {
  const n = $('task-input').value.length;
  const c = $('char-count');
  c.textContent = `${n}/${MAX_LEN}`;
  c.classList.toggle('has-text', n > 0);
  c.classList.toggle('warn', n >= 100 && n < MAX_LEN);
  c.classList.toggle('max', n >= MAX_LEN);
}

function buildRecurExtra(container, spec, onChange) {
  container.innerHTML = '';
  const num = (cls, min, max, val, label) => {
    const wrap = document.createElement('label');
    wrap.className = 'rx-field';
    wrap.append(label + ' ');
    const i = document.createElement('input');
    i.type = 'number'; i.className = cls; i.min = min; i.max = max; i.value = val;
    wrap.appendChild(i);
    container.appendChild(wrap);
    return i;
  };
  const read = () => {
    const patch = {};
    const n = container.querySelector('.rx-n'), u = container.querySelector('.rx-unit'), md = container.querySelector('.rx-md');
    if (n) patch.recurEvery = Math.max(1, Math.min(365, parseInt(n.value, 10) || 1));
    if (u) patch.recurUnit = u.value;
    if (md) patch.recurMonthDay = Math.max(1, Math.min(31, parseInt(md.value, 10) || 1));
    return patch;
  };
  if (spec.recur === 'monthday') {
    num('rx-md', 1, 31, spec.recurMonthDay || 1, 'Day of month');
  } else {
    num('rx-n', 1, 365, spec.recurEvery || 1, spec.recur === 'after' ? 'After done:' : 'Every');
    const u = document.createElement('select');
    u.className = 'rx-unit';
    [['day', 'days'], ['week', 'weeks'], ['month', 'months']].forEach(([v, t]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = t; u.appendChild(o);
    });
    u.value = spec.recurUnit || 'week';
    container.appendChild(u);
  }
  container.querySelectorAll('input, select').forEach(el => el.addEventListener('change', () => onChange(read())));
}

// the repeat chosen in the add row (null when none)
function newRecurSpec() {
  const v = $('recur-input').value;
  if (!v) return null;
  const spec = { recur: v };
  if (v === 'days') spec.recurDays = [...newRecurDays];
  if (v === 'every' || v === 'after' || v === 'monthday') {
    const box = $('recur-extra');
    const n = box.querySelector('.rx-n'), u = box.querySelector('.rx-unit'), md = box.querySelector('.rx-md');
    if (n) spec.recurEvery = Math.max(1, Math.min(365, parseInt(n.value, 10) || 1));
    if (u) spec.recurUnit = u.value;
    if (md) spec.recurMonthDay = Math.max(1, Math.min(31, parseInt(md.value, 10) || 1));
  }
  return spec;
}
function renderNewRecurExtra() {
  const box = $('recur-extra');
  const v = $('recur-input').value;
  const on = ['every', 'after', 'monthday'].includes(v);
  box.classList.toggle('hidden', !on);
  if (!on) { box.innerHTML = ''; return; }
  const dueDay = $('due-input').value ? Number($('due-input').value.slice(8)) : 1;
  const spec = { every: { recur: v, recurEvery: 1, recurUnit: 'week' }, after: { recur: v, recurEvery: 3, recurUnit: 'day' }, monthday: { recur: v, recurMonthDay: dueDay } }[v];
  buildRecurExtra(box, spec, () => updateParseHint());
}

// which parts of the sentence may be interpreted (anything already picked by hand wins)
function parseOpts() {
  return { dates: !$('due-input').value, repeats: !$('recur-input').value, priority: !$('prio-input').value };
}
function updateParseHint() {
  const el = $('parse-hint');
  const raw = $('task-input').value.trim();
  const labels = raw ? NLP.parse(raw, new Date(), parseOpts()).found.map(f => f.label) : [];
  el.textContent = labels.length ? '→ ' + labels.join(' · ') : '';
  el.classList.toggle('hidden', !labels.length);
}

function addTask() {
  const input = $('task-input');
  const raw = input.value.trim();
  if (!raw) return;
  const p = NLP.parse(raw, new Date(), parseOpts());

  const pickerDue = $('due-input').value || null;
  let due = pickerDue || p.due;
  let dueTime = pickerDue ? ($('due-time-input').value || null) : p.dueTime;
  if (!due && (miniMode || smartView === 'today')) { due = todayStr(); dueTime = null; }     // "today's tasks" views add for today

  const picked = newRecurSpec();
  const rec = picked || (p.recur ? { recur: p.recur, recurDays: p.recurDays, recurEvery: p.recurEvery, recurUnit: p.recurUnit, recurMonthDay: p.recurMonthDay } : { recur: null });
  const t = newTask({
    text: p.text.slice(0, MAX_LEN), tags: p.tags, due, dueTime,
    priority: Number($('prio-input').value) || p.priority || 0, ...rec
  });

  archiveView = false;
  tagFilter = null;
  searchQuery = '';
  $('search-input').value = '';
  $('search-clear').classList.add('hidden');

  mutate('Add task', () => { tasks.push(t); });
  input.value = '';
  $('due-input').value = '';
  $('due-time-input').value = '';
  $('due-time-input').disabled = true;
  $('recur-input').value = '';
  $('prio-input').value = '';
  newRecurDays = [...DEFAULT_DAYS];
  renderNewDays();
  renderNewRecurExtra();
  updateCharCount();
  updateParseHint();
  sfxAdd();
  if ((smartView || miniMode) && !visibleTasks().some(x => x.id === t.id)) {
    const ln = (lists.find(l => l.id === t.listId) || {}).name || 'your list';
    showToast(`Added to "${ln}". It is not due in this view.`, null, null, 4500);
  }
  requestAnimationFrame(() => {
    const li = document.querySelector(`#task-list [data-id="${t.id}"]`);
    if (li) li.scrollIntoView({ block: 'nearest' });
  });
}

function toggleTask(task) {
  const completing = !task.done;
  mutate(completing ? 'Complete task' : 'Uncomplete task', () => {
    task.done = completing;
    task.completedDate = completing ? todayStr() : null;
  });
  if (completing) { sfxComplete(); checkStreak(); }
  else            { sfxUncomplete(); }              // streak is never rolled back
}

function togglePin(task) {
  mutate(task.pinned ? 'Unpin task' : 'Pin task', () => { task.pinned = !task.pinned; });
}

function archiveTask(task) {
  mutate('Archive task', () => { task.archived = true; expanded.delete(task.id); },
         `Archived "${shortText(task.text)}"`);
  sfxDelete();
}

function restoreTask(task) {
  mutate('Restore task', () => { task.archived = false; });
  sfxAdd();
}

function deleteForever(task) {
  mutate('Delete task', () => { tasks = tasks.filter(t => t !== task); expanded.delete(task.id); },
         `Deleted "${shortText(task.text)}"`);
  sfxDelete();
}

function clearDone() {
  const finished = tasks.filter(t => t.listId === activeListId && t.done && !t.archived && !t.recur);
  if (!finished.length) {
    const keeping = tasks.some(t => t.listId === activeListId && t.done && !t.archived && t.recur);
    showToast(keeping ? 'Nothing to clear. Repeating tasks reset on their own.' : 'No finished tasks to clear.');
    return;
  }
  mutate('Clear done', () => { finished.forEach(t => { t.archived = true; }); },
         `Archived ${finished.length} finished task${finished.length !== 1 ? 's' : ''}`);
  sfxDelete();
}

// Two-step: first click arms the button, second click deletes (still undoable)
let deleteAllTimer = null;
function resetDeleteAll() {
  clearTimeout(deleteAllTimer);
  deleteAllTimer = null;
  const b = $('delete-all-btn');
  b.classList.remove('armed');
  b.textContent = 'Delete all';
}
function deleteAllArchived() {
  const items = tasks.filter(t => t.listId === activeListId && t.archived);
  if (!items.length) return;
  const btn = $('delete-all-btn');
  if (!deleteAllTimer) {
    btn.textContent = `Delete ${items.length}? Click again`;
    btn.classList.add('armed');
    deleteAllTimer = setTimeout(resetDeleteAll, 3500);
    return;
  }
  resetDeleteAll();
  const ids = new Set(items.map(t => t.id));
  const n = items.length;
  mutate('Delete all archived', () => {
    tasks = tasks.filter(t => !ids.has(t.id));
    ids.forEach(id => expanded.delete(id));
  }, `Deleted ${n} archived task${n !== 1 ? 's' : ''}`);
  sfxDelete();
}

function toggleArchiveView() {
  archiveView = !archiveView;
  tagFilter = null;
  renderAll();
}

// ── Recurring tasks: done → resets itself on the next cycle ───────
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_DAYS = [1, 2, 3, 4, 5];

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}
function nextOccurrence(dateStr, days) {
  for (let k = 1; k <= 7; k++) {
    const d = addDays(dateStr, k);
    if (days.includes(weekdayOf(d))) return d;
  }
  return addDays(dateStr, 1);
}
// Date on which a completed repeating task comes back
function addUnits(dateStr, n, unit) {
  if (unit === 'day') return addDays(dateStr, n);
  if (unit === 'week') return addDays(dateStr, 7 * n);
  const [y, m, d] = dateStr.split('-').map(Number);
  const first = new Date(y, m - 1 + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return dateKey(new Date(first.getFullYear(), first.getMonth(), Math.min(d, last)));
}
// first date strictly after dateStr whose day-of-month is md (clamped to short months)
function nextMonthDayAfter(dateStr, md) {
  const [y, m] = dateStr.split('-').map(Number);
  let yy = y, mm = m - 1;
  for (let i = 0; i < 14; i++) {
    const last = new Date(yy, mm + 1, 0).getDate();
    const c = dateKey(new Date(yy, mm, Math.min(md, last)));
    if (c > dateStr) return c;
    mm++; if (mm > 11) { mm = 0; yy++; }
  }
  return addDays(dateStr, 30);
}

// Date on which a completed repeating task comes back
function nextDue(t) {
  const n = t.recurEvery || 1;
  switch (t.recur) {
    case 'days':     return nextOccurrence(t.completedDate, t.recurDays);
    case 'weekly':   return addDays(t.completedDate, 7);
    case 'after':    return addUnits(t.completedDate, n, t.recurUnit || 'day');          // N units after finishing
    case 'monthday': return nextMonthDayAfter(t.completedDate, t.recurMonthDay || 1);
    case 'every': {                                                                      // fixed schedule
      const base = t.due || t.completedDate;
      for (let k = 1; k < 4000; k++) { const c = addUnits(base, k * n, t.recurUnit || 'week'); if (c > t.completedDate) return c; }
      return addDays(t.completedDate, 1);
    }
    default:         return addDays(t.completedDate, 1);                                 // daily
  }
}
function recurLabel(t) { return NLP.recurLabel(t); }

// Row of 7 day toggles (used by the add row and the detail panel)
function buildDayChips(container, selected, onToggle) {
  container.innerHTML = '';
  DAY_NAMES.forEach((name, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'day-chip' + (selected.includes(i) ? ' on' : '');
    b.textContent = name.slice(0, 2);
    b.title = name;
    b.setAttribute('aria-pressed', String(selected.includes(i)));
    b.addEventListener('click', () => onToggle(i));
    container.appendChild(b);
  });
}
function toggleDay(list, i) {
  const has = list.includes(i);
  if (has && list.length === 1) { showToast('Keep at least one day selected.'); return list; }
  return (has ? list.filter(x => x !== i) : [...list, i]).sort();
}

let newRecurDays = [...DEFAULT_DAYS];
function renderNewDays() {
  const row = $('days-row');
  const on = $('recur-input').value === 'days';
  row.classList.toggle('hidden', !on);
  if (on) buildDayChips(row, newRecurDays, i => { newRecurDays = toggleDay(newRecurDays, i); renderNewDays(); });
}

function applyRecurrence() {
  const today = todayStr();
  let changed = false;
  for (const t of tasks) {
    if (t.completedDate && t.completedDate > today) { t.completedDate = today; changed = true; }   // clock was wrong
    if (!t.recur || !t.done || !t.completedDate) continue;
    const comeBack = nextDue(t);
    if (comeBack <= today) {
      t.done = false;
      t.completedDate = null;
      t.subtasks.forEach(s => { s.done = false; });
      if (t.due) {
        const n = t.recurEvery || 1;
        if (t.recur === 'days') {
          if (t.due < today) {
            let nd = today;
            for (let k = 0; k < 7 && !t.recurDays.includes(weekdayOf(nd)); k++) nd = addDays(nd, 1);   // bounded: never loops forever
            t.due = nd;
          }
        } else if (t.recur === 'monthday') {
          t.due = nextMonthDayAfter(addDays(today, -1), t.recurMonthDay || 1);          // first matching day from today
        } else if (t.recur === 'every') {
          let nd = comeBack;
          for (let k = 0; nd < today && k < 4000; k++) nd = addUnits(nd, n, t.recurUnit || 'week');
          t.due = nd;
        } else if (t.recur === 'after') {
          t.due = today;
        } else {
          const step = t.recur === 'weekly' ? 7 : 1;
          while (t.due < today) t.due = addDays(t.due, step);
        }
      }
      changed = true;
    }
  }
  if (changed) {
    persist();
    if (!isEditingActive()) renderAll();
  } else if (updateOverdueBadge() && !isEditingActive()) {
    renderTasks();                      // a timed task just became overdue
  }
}

// ── Settings ──────────────────────────────────────────────────────
function loadSettingsUI() {
  $('set-ontop').checked         = settings.alwaysOnTop;
  $('set-dark').checked          = settings.darkMode;
  $('set-snap').value            = settings.snapPosition   ?? 'none';
  $('set-auto-update').checked   = settings.autoUpdate !== false;
  $('set-minimize-tray').checked = settings.minimizeToTray ?? false;
  $('set-reminder').checked      = settings.reminderEnabled;
  $('set-notify-overdue').checked = settings.notifyOverdue !== false;
  $('set-launch-login').checked  = !!settings.launchAtLogin;
  $('set-weekly-review').checked = settings.weeklyReview !== false;
  $('set-review-time').value     = settings.reviewTime ?? '18:00';
  toggleReviewTimeRow();
  $('set-reminder-time').value   = settings.reminderTime   ?? '09:00';
  $('set-theme-color').value     = settings.themeColor === 'yellow' ? 'default' : (settings.themeColor ?? 'default');
  $('set-custom-color').value    = settings.customColor    ?? '#c97b2a';
  $('custom-color-hex').textContent = $('set-custom-color').value;
  $('set-compact').checked       = !!settings.compactMode;
  $('set-global-quick').checked  = settings.globalQuickAdd !== false;
  toggleCustomColorRow();
  $('set-ui-style').value        = settings.uiStyle        ?? 'default';
  const pct = Math.round((settings.windowOpacity ?? 1) * 100);
  $('set-opacity').value = pct;
  $('opacity-val').textContent = `${pct}%`;
  toggleReminderTimeRow();
}

async function saveSettings() {
  settings.alwaysOnTop     = $('set-ontop').checked;
  settings.darkMode        = $('set-dark').checked;
  settings.snapPosition    = $('set-snap').value;
  settings.minimizeToTray  = $('set-minimize-tray').checked;
  settings.reminderEnabled = $('set-reminder').checked;
  settings.notifyOverdue   = $('set-notify-overdue').checked;
  settings.launchAtLogin   = $('set-launch-login').checked;
  settings.autoUpdate      = $('set-auto-update').checked;
  settings.weeklyReview    = $('set-weekly-review').checked;
  settings.reviewTime      = $('set-review-time').value || '18:00';
  settings.reminderTime    = $('set-reminder-time').value;
  settings.themeColor      = $('set-theme-color').value;
  settings.customColor     = $('set-custom-color').value;
  settings.uiStyle         = $('set-ui-style').value;
  settings.compactMode     = $('set-compact').checked;
  settings.globalQuickAdd  = $('set-global-quick').checked;
  settings.windowOpacity   = Number($('set-opacity').value) / 100;
  const r = await window.api.saveSettings(settings);
  applyAppearance();
  showMain();
  if (settings.launchAtLogin && r && r.loginOk === false) {
    showToast('Launch at login only works in the installed app, not when started with npm start.', null, null, 7000);
  }
  if (settings.globalQuickAdd && r && r.shortcutOk === false) {
    showToast('Ctrl+Alt+N is already used by another app, so the quick-add shortcut is off.', null, null, 7000);
  }
}

function toggleCustomColorRow() {
  $('custom-color-row').style.display = $('set-theme-color').value === 'custom' ? 'flex' : 'none';
}

// Show appearance changes immediately; Back (or not saving) reverts them
function previewAppearance() {
  $('custom-color-hex').textContent = $('set-custom-color').value;
  toggleCustomColorRow();
  applyAppearance({
    darkMode: $('set-dark').checked,
    themeColor: $('set-theme-color').value,
    customColor: $('set-custom-color').value,
    uiStyle: $('set-ui-style').value,
    compactMode: $('set-compact').checked
  });
}

function toggleReviewTimeRow() {
  $('review-time-row').style.display = $('set-weekly-review').checked ? 'flex' : 'none';
}

function toggleReminderTimeRow() {
  $('reminder-time-row').style.display = $('set-reminder').checked ? 'flex' : 'none';
}

// ── Sync folder ───────────────────────────────────────────────────
function refreshSyncLabel() {
  $('sync-path-label').textContent = settings.syncFolder || 'Not set (stored on this device)';
  $('sync-clear').classList.toggle('hidden', !settings.syncFolder);
}

async function applySync(folder) {
  const res = await window.api.setSyncFolder(folder);
  settings.syncFolder = res.syncFolder;
  applyLoadedData(res.data);
  adoptStreak(res.streak);
  undoStack.length = 0;
  renderAll();
  refreshSyncLabel();
  $('tasks-path-label').textContent = await window.api.getDataPath();
  showToast(folder ? 'Sync folder set. Tasks were merged.' : 'Sync stopped. Using local storage.');
}

async function chooseSyncFolder() {
  const folder = await window.api.chooseSyncFolder();
  if (folder) applySync(folder);
}

// ── Backup & restore ──────────────────────────────────────────────
async function backupNow() {
  persist();                                   // flush any pending note edits first
  await new Promise(r => setTimeout(r, 150));
  const r = await window.api.backupData();
  if (r && r.ok) showToast('Backup saved to Documents/CandleTasks Backups', 'Show', () => window.api.showInFolder(r.filePath), 8000);
  else showToast('Backup failed: ' + ((r && r.error) || 'unknown error'));
}

async function restoreBackup() {
  const r = await window.api.restoreData();
  if (!r || r.canceled) return;
  if (!r.ok) { showToast(r.error || 'Restore failed.'); return; }
  activeListId = null;
  applyLoadedData(r.data);
  streak = normStreak(JSON.parse(JSON.stringify(r.streak)));
  Object.assign(settings, r.settings);
  undoStack.length = 0;
  applyAppearance();
  loadSettingsUI();
  renderSoundBtn();
  renderAll();
  renderStreak();
  showMain();
  showToast('Backup restored. A safety copy of your old data was saved.', null, null, 7000);
}

// ── Reminder ──────────────────────────────────────────────────────
// ── Minute ticker ─────────────────────────────────────────────────
// A plain setInterval(60000) starts at a random second, so an alert could land up to a
// minute late. Instead we sleep until just after the next minute boundary, every time.
const msToNextMinute = (now = Date.now()) => 60000 - (now % 60000) + 250;

// If the system date was moved forward and then back, undo streak progress dated in the future
async function checkClockDrift() {
  const today = todayStr();
  const fut = d => d > today;
  const hasFuture = (streak.lastCompletedDate && fut(streak.lastCompletedDate)) ||
    streak.completedDates.some(fut) || streak.frozenDates.some(fut) ||
    Object.keys(streak.doneByDate || {}).some(fut) || streak.journal.some(e => fut(e.date));
  if (!hasFuture) return;
  try {
    const r = await window.api.pruneStreak(streak);
    if (r && r.changed) {
      streak = normStreak(JSON.parse(JSON.stringify(r.streak)));
      renderStreak();
      showToast('Your clock moved back, so streak progress dated in the future was removed.', null, null, 7000);
    }
  } catch (e) {}
}

// Sunday summary notification (once per Sunday, at the chosen time or at the next launch after it)
function checkWeeklyReview() {
  if (settings.weeklyReview === false) return;
  const now = new Date();
  if (now.getDay() !== 0) return;
  if (nowHM() < (settings.reviewTime || '18:00')) return;
  const key = todayStr();
  try { if (localStorage.getItem('ct_review_last') === key) return; localStorage.setItem('ct_review_last', key); } catch (e) {}

  let total = 0, bestN = 0, bestWd = -1;
  for (let i = 0; i < 7; i++) {
    const d = offsetDate(-i);
    const n = (streak.doneByDate || {})[d] || 0;
    total += n;
    if (n > bestN) { bestN = n; bestWd = weekdayOf(d); }
  }
  const over = overdueTasks().length;
  const body = total
    ? `You completed ${total} task${total !== 1 ? 's' : ''} this week${bestWd >= 0 ? ` (best day: ${DAY_FULL[bestWd]})` : ''}. `
      + (over ? `${over} overdue. ` : 'Nothing overdue. ') + `Streak: ${streak.count} day${streak.count !== 1 ? 's' : ''}. Click for your stats.`
    : `No tasks completed this week. ${over ? over + ' overdue. ' : ''}A fresh week starts tomorrow. Click for your stats.`;
  window.api.sendNotification({ title: 'Your week in review', body, action: 'stats' });
}

function runTick() {
  checkClockDrift();
  applyRecurrence();
  checkOverdueNotifications();
  checkDailyReminder();
  checkWeeklyReview();
}

function startMinuteTicker() {
  const loop = () => { runTick(); setTimeout(loop, msToNextMinute()); };
  setTimeout(loop, msToNextMinute());
}

function checkDailyReminder() {
  if (!settings.reminderEnabled || !settings.reminderTime) return;
  if (nowHM() !== settings.reminderTime) return;
  const key = `${todayStr()} ${settings.reminderTime}`;
  if (key === lastReminderKey) return;                 // once per day
  lastReminderKey = key;
  const undone = tasks.filter(t => !t.done && !t.archived).length;
  window.api.sendNotification({
    title: 'CandleTasks',
    body: undone
      ? `You have ${undone} task${undone !== 1 ? 's' : ''} waiting today.`
      : 'All tasks done! Great work today.'
  });
}

// ── Panel switching ───────────────────────────────────────────────
function showSettings() {
  $('main-view').classList.add('hidden');
  $('settings-panel').classList.remove('hidden');
}
function showMain() {
  $('settings-panel').classList.add('hidden');
  $('main-view').classList.remove('hidden');
}
function settingsOpen() { return !$('settings-panel').classList.contains('hidden'); }

function isTypingTarget(el) {
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
}

// ── Events ────────────────────────────────────────────────────────
$('add-btn').addEventListener('click', addTask);
$('task-input').addEventListener('keydown', e => { if (e.key === 'Enter') addTask(); });
$('task-input').addEventListener('input', () => { updateCharCount(); updateParseHint(); });
$('list-add').addEventListener('click', addList);
$('mini-btn').addEventListener('click', toggleMini);
document.querySelectorAll('.view-chip').forEach(b => b.addEventListener('click', () => setSmartView(b.dataset.view)));
$('sort-select').addEventListener('change', e => {
  sortMode = e.target.value;
  try { localStorage.setItem('ct_sort', sortMode); } catch (err) {}
  renderTasks();
});
['due-input', 'prio-input'].forEach(id => $(id).addEventListener('input', updateParseHint));
$('recur-input').addEventListener('change', updateParseHint);

// right-click a tag to colour it
document.addEventListener('contextmenu', e => {
  const chip = e.target.closest && e.target.closest('.tag-chip');
  if (!chip || !chip.dataset.tag) return;
  e.preventDefault();
  openTagPop(chip.dataset.tag, e.clientX, e.clientY);
});
document.addEventListener('mousedown', e => { if (!e.target.closest('#tag-pop')) closeTagPop(); });
$('recur-input').addEventListener('change', () => { renderNewDays(); renderNewRecurExtra(); });
$('due-input').addEventListener('input', () => {
  $('due-time-input').disabled = !$('due-input').value;
  if (!$('due-input').value) $('due-time-input').value = '';
});
$('clear-done-btn').addEventListener('click', clearDone);
$('archive-btn').addEventListener('click', toggleArchiveView);
$('delete-all-btn').addEventListener('click', deleteAllArchived);

$('search-input').addEventListener('input', e => {
  searchQuery = e.target.value;
  $('search-clear').classList.toggle('hidden', !searchQuery);
  renderTasks();
});
$('search-clear').addEventListener('click', () => {
  searchQuery = '';
  $('search-input').value = '';
  $('search-clear').classList.add('hidden');
  renderTasks();
  $('search-input').focus();
});

$('settings-btn').addEventListener('click', showSettings);
$('back-btn').addEventListener('click', () => {
  window.api.setOpacity(settings.windowOpacity ?? 1);   // drop unsaved previews
  applyAppearance();
  loadSettingsUI();
  showMain();
});
$('save-settings-btn').addEventListener('click', saveSettings);
$('min-btn').addEventListener('click', () => window.api.minimizeWindow());
$('close-btn').addEventListener('click', () => window.api.closeWindow());
$('sound-btn').addEventListener('click', toggleSound);
$('help-btn').addEventListener('click', openHelp);
$('help-close').addEventListener('click', closeHelp);
$('help-modal').addEventListener('click', e => { if (e.target === $('help-modal')) closeHelp(); });
$('upd-check').addEventListener('click', () => window.api.checkForUpdate());
$('upd-close').addEventListener('click', closeUpdModal);
$('update-modal').addEventListener('click', e => { if (e.target === $('update-modal')) closeUpdModal(); });
$('set-reminder').addEventListener('change', toggleReminderTimeRow);
$('set-weekly-review').addEventListener('change', toggleReviewTimeRow);
['set-dark', 'set-theme-color', 'set-ui-style', 'set-compact'].forEach(id => $(id).addEventListener('change', previewAppearance));
$('set-custom-color').addEventListener('input', previewAppearance);
$('set-opacity').addEventListener('input', e => {
  $('opacity-val').textContent = `${e.target.value}%`;
  window.api.setOpacity(Number(e.target.value) / 100);   // live preview
});
$('sync-choose').addEventListener('click', chooseSyncFolder);
$('backup-btn').addEventListener('click', backupNow);
$('restore-btn').addEventListener('click', restoreBackup);
$('sync-clear').addEventListener('click', () => applySync(''));


$('flame-btn').addEventListener('click', e => { e.stopPropagation(); openStreakModal(); });
$('modal-close').addEventListener('click', closeStreakModal);
$('streak-modal').addEventListener('click', e => { if (e.target === $('streak-modal')) closeStreakModal(); });
document.querySelectorAll('#modal-tabs button').forEach(b => b.addEventListener('click', () => {
  calView = b.dataset.view;
  calOffset = 0;
  renderCalendar();
}));
$('cal-prev').addEventListener('click', () => { calOffset--; renderCalendar(); });
$('cal-next').addEventListener('click', () => { if (calOffset < 0) { calOffset++; renderCalendar(); } });

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (e.key === 'F1') {
    e.preventDefault();
    openHelp();
  } else if (mod && key === 'm') {                 // mini mode
    e.preventDefault();
    toggleMini();
  } else if (mod && key === 'n') {                 // focus the new-task input
    e.preventDefault();
    closeStreakModal();
    closeHelp();
    if (settingsOpen()) showMain();
    if (archiveView) { archiveView = false; renderAll(); }
    $('task-input').focus();
    $('task-input').select();
  } else if (mod && key === 'f') {                // focus search
    e.preventDefault();
    closeStreakModal();
    closeHelp();
    if (settingsOpen()) showMain();
    $('search-input').focus();
    $('search-input').select();
  } else if (mod && key === 'z' && !isTypingTarget(e.target)) {
    e.preventDefault();
    undo();
  } else if (e.key === 'Escape') {
    if (!$('tag-pop').classList.contains('hidden')) closeTagPop();
    else if (!$('update-modal').classList.contains('hidden')) closeUpdModal();
    else if (!$('help-modal').classList.contains('hidden')) closeHelp();
    else if (!$('streak-modal').classList.contains('hidden')) closeStreakModal();
    else if (document.activeElement === $('search-input') || searchQuery) $('search-clear').click();
    else if (document.activeElement === $('task-input')) $('task-input').blur();
    else if (selectedId) setSelected(null);
  }
});

// Arrow-key task navigation: ↑/↓ select, Space complete, Del archive, Enter edit
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingTarget(e.target)) return;
  if (settingsOpen() || !$('streak-modal').classList.contains('hidden') || !$('help-modal').classList.contains('hidden') || !$('update-modal').classList.contains('hidden')) return;
  const key = e.key;
  if (!['ArrowDown', 'ArrowUp', ' ', 'Delete', 'Enter'].includes(key)) return;
  const ids = visibleTasks().map(t => t.id);
  if (!ids.length) return;

  // a focused button would also react to Space/Enter itself, so drop focus first
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae.closest && ae.closest('#task-list, .list-tabs, .footer-bar')) ae.blur();

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    e.preventDefault();
    let i = ids.indexOf(selectedId);
    if (i < 0) i = key === 'ArrowDown' ? 0 : ids.length - 1;
    else i = Math.min(ids.length - 1, Math.max(0, i + (key === 'ArrowDown' ? 1 : -1)));
    setSelected(ids[i], true);
    return;
  }
  const task = tasks.find(t => t.id === selectedId);
  if (!task || !ids.includes(task.id)) return;
  if (key === ' ') {
    if (archiveView) return;
    e.preventDefault();
    toggleTask(task);
  } else if (key === 'Delete') {
    e.preventDefault();
    const i = ids.indexOf(task.id);
    selectedId = ids[i + 1] ?? ids[i - 1] ?? null;      // keep a neighbour selected
    if (archiveView) deleteForever(task); else archiveTask(task);
  } else if (key === 'Enter') {
    if (archiveView) return;
    e.preventDefault();
    const li = document.querySelector(`#task-list [data-id="${task.id}"]`);
    if (li) startEdit(task, li, li.querySelector('.task-main'), li.querySelector('.task-text'));
  }
});

// ── Start ─────────────────────────────────────────────────────────
init();
