// Streak rules, kept free of any UI so they can be unit-tested. Works in the renderer (window.StreakRules)
// and in Node (require).
//
// How a streak works
//   * Finish at least one task a day to grow it.
//   * GRACE: the first fully missed day after your last completed day is forgiven for free.
//   * FREEZES: each further missed day in a row uses one streak freeze (you hold at most 3).
//   * With no freeze left to cover a missed day, the streak resets to 0 and the freezes are gone.
//   * You earn one freeze every 7th streak day.
//
// "Missed" days are days that have fully ended: today never counts as missed, so you can still finish a
// task today. The state is always *calculated* from the last completed day, never edited behind your back,
// so what you see is correct at any moment (freezes drop as soon as a day is missed, not only after your
// next task) and it cannot be undone by a sync merge or by moving the clock.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StreakRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const GRACE_DAYS = 1;       // missed days forgiven for free
  const MAX_FREEZES = 3;
  const FREEZE_EVERY = 7;     // a freeze is earned on every 7th streak day

  const pad = n => String(n).padStart(2, '0');
  const utc = d => { const [y, m, dd] = String(d).split('-').map(Number); return Date.UTC(y, m - 1, dd); };
  const dayDiff = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
  function addDays(d, n) {
    const t = new Date(utc(d) + n * 86400000);
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }
  const whole = v => { v = Math.floor(Number(v)); return Number.isFinite(v) && v > 0 ? v : 0; };
  const heldFreezes = s => Math.min(MAX_FREEZES, whole(s && s.freezes));

  // The state of a streak as of `today`, without changing it.
  //   alive      the streak is still going (it may be waiting for today's task)
  //   broken     it has just run out of grace and freezes: it counts as 0 until the next task
  //   count      the streak length to show (0 when broken or when there is no streak)
  //   freezes    freezes left to show, after any that were used for missed days
  //   missed     fully missed days since the last completed day
  //   graceUsed  the grace day has been used up
  //   used       freezes used for missed days so far
  //   frozenDays the missed days those freezes cover (for the calendar)
  function evaluate(s, today) {
    const count = whole(s && s.count);
    const held = heldFreezes(s);
    const last = s && typeof s.lastCompletedDate === 'string' ? s.lastCompletedDate : null;
    if (!count || !last) {
      return { alive: false, broken: false, count: 0, freezes: held, missed: 0, graceUsed: false, used: 0, frozenDays: [] };
    }
    const missed = Math.max(0, dayDiff(last, today) - 1);
    const needed = Math.max(0, missed - GRACE_DAYS);
    if (needed <= held) {
      return {
        alive: true, broken: false, count, freezes: held - needed, missed, graceUsed: missed >= GRACE_DAYS, used: needed,
        frozenDays: Array.from({ length: needed }, (_, k) => addDays(last, 1 + GRACE_DAYS + k))
      };
    }
    return { alive: false, broken: true, count: 0, freezes: 0, missed, graceUsed: true, used: held, frozenDays: [] };
  }

  // Record a completed task on `today` (the first one of that day). Changes `s` and says what happened.
  //   used    freezes spent to keep the streak alive (0 when it was reset)
  //   reset   the streak had run out and starts again at 1
  //   earned  a new freeze was earned today
  function applyCompletion(s, today) {
    const ev = evaluate(s, today);
    let used = 0, reset = false, earned = false;
    if (ev.alive) {
      s.freezes = ev.freezes;
      if (ev.frozenDays.length) s.frozenDates = [...new Set([...(s.frozenDates || []), ...ev.frozenDays])].sort();
      s.count = ev.count + 1;
      used = ev.used;
    } else {
      s.count = 1;
      if (ev.broken) { s.freezes = 0; reset = true; }
    }
    s.lastCompletedDate = today;
    s.best = Math.max(whole(s.best), s.count);
    if (ev.alive && s.count % FREEZE_EVERY === 0 && heldFreezes(s) < MAX_FREEZES) { s.freezes = heldFreezes(s) + 1; earned = true; }
    return { used, reset, earned };
  }

  // The streak day on which the next freeze is earned
  const nextFreezeDay = count => (Math.floor(whole(count) / FREEZE_EVERY) + 1) * FREEZE_EVERY;

  return { GRACE_DAYS, MAX_FREEZES, FREEZE_EVERY, dayDiff, addDays, evaluate, applyCompletion, nextFreezeDay };
});
