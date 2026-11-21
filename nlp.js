// Plain-word task parsing: dates, times, repeats, #tags and !priority.
// Works in the renderer (window.NLP) and in the main process (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NLP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const WD = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
  const MONTHS = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
    jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 };
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH_RE = 'january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec';
  const WD_RE = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat';

  const pad = n => String(n).padStart(2, '0');
  const key = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayOnly = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const plusDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const clampDay = (y, m, d) => Math.min(d, new Date(y, m + 1, 0).getDate());
  function plusMonths(d, n) { const t = new Date(d.getFullYear(), d.getMonth() + n, 1); return new Date(t.getFullYear(), t.getMonth(), clampDay(t.getFullYear(), t.getMonth(), d.getDate())); }
  function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function fmtTime(hm) { const [h, m] = hm.split(':').map(Number); return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`; }

  function recurLabel(t) {
    switch (t.recur) {
      case 'daily': return 'Daily';
      case 'weekly': return 'Weekly';
      case 'days': {
        const d = [...(t.recurDays || [])].sort(), j = d.join();
        if (d.length === 7) return 'Daily';
        if (j === '1,2,3,4,5') return 'Weekdays';
        if (j === '0,6') return 'Weekends';
        return d.map(i => DAY_SHORT[i]).join('/');
      }
      case 'every': { const n = t.recurEvery || 1, u = t.recurUnit || 'week'; return n === 1 ? `Every ${u}` : `Every ${n} ${u}s`; }
      case 'after': { const n = t.recurEvery || 1, u = t.recurUnit || 'day'; return `${n} ${u}${n !== 1 ? 's' : ''} after done`; }
      case 'monthday': return `Monthly on the ${ordinal(t.recurMonthDay || 1)}`;
      default: return '';
    }
  }

  function nextWeekday(from, wd, includeToday) {
    for (let k = includeToday ? 0 : 1; k <= 7; k++) { const d = plusDays(from, k); if (d.getDay() === wd) return d; }
    return plusDays(from, 1);
  }
  // "next friday": that weekday in the calendar week (Mon-Sun) after the current one
  function weekdayOfNextWeek(from, wd) {
    const toNextMonday = ((8 - from.getDay()) % 7) || 7;
    return plusDays(from, toNextMonday + ((wd + 6) % 7));
  }
  function nextMonthDay(from, md) {                       // first date >= from whose day-of-month is md (clamped)
    let y = from.getFullYear(), m = from.getMonth();
    for (let i = 0; i < 14; i++) {
      const c = new Date(y, m, clampDay(y, m, md));
      if (c >= from) return c;
      m++; if (m > 11) { m = 0; y++; }
    }
    return from;
  }

  // opts.dmy (default true): "on 3/4" means 3 April. Pass dmy:false for US-style month/day.
  function parse(raw, now, opts) {
    now = now || new Date();
    opts = Object.assign({ tags: true, priority: true, dates: true, repeats: true, dmy: true }, opts || {});
    const today = dayOnly(now);
    const nowHM = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const original = ' ' + String(raw) + ' ';
    let s = original;
    const out = { text: '', tags: [], priority: 0, due: null, dueTime: null, recur: null, found: [] };

    // Remove the first match that fn() accepts. A rejected match (fn returns false) no longer blocks later ones,
    // e.g. "wed" used as an ordinary word followed by a real "on friday".
    const take = (re, fn) => {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m;
      while ((m = g.exec(s))) {
        if (fn(m) === false) { g.lastIndex = m.index + 1; continue; }
        s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
        return true;
      }
      return false;
    };

    // ── #tags and !priority ──
    if (opts.tags) {
      // a tag needs at least one letter, so "customer #1" keeps its number
      while (take(/\s#((?=[\p{L}\p{N}_-]*\p{L})[\p{L}\p{N}_-]{1,24})(?=\s)/u, m => {
        if (!out.tags.some(x => x.toLowerCase() === m[1].toLowerCase())) out.tags.push(m[1]);
      })) { /* keep taking */ }
    }
    if (opts.priority) {
      take(/\s!(high|hi|h|medium|med|m|low|lo|l)(?=\s)/i, m => {
        const k = m[1].toLowerCase()[0];
        out.priority = k === 'h' ? 3 : k === 'm' ? 2 : 1;
        out.found.push({ type: 'priority', label: ['', 'Low', 'Medium', 'High'][out.priority] + ' priority' });
      });
    }

    // ── repeats ──
    let recurDefaultDue = null;
    if (opts.repeats) {
      const set = (spec, label) => { out.recur = spec; out.found.push({ type: 'repeat', label: label || recurLabel(spec) }); return true; };
      const unitOf = u => u.toLowerCase().replace(/s$/, '');
      take(/\s(?:repeat\s+)?(\d{1,3})\s*(days?|weeks?|months?)\s+after\s+(?:i\s+)?(?:finish(?:ing|ed)?|complet(?:e|ed|ing)|done)(?:\s+it)?(?=\s)/i,
          m => { const n = +m[1]; if (n < 1) return false; return set({ recur: 'after', recurEvery: n, recurUnit: unitOf(m[2]) }); }) ||
        take(/\s(?:monthly|every\s+month)\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?(?=\s)/i,
          m => { const d = +m[1]; if (d < 1 || d > 31) return false; recurDefaultDue = { monthday: d }; return set({ recur: 'monthday', recurMonthDay: d }); }) ||
        take(/\son\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(?:every|each)\s+month(?=\s)/i,
          m => { const d = +m[1]; if (d < 1 || d > 31) return false; recurDefaultDue = { monthday: d }; return set({ recur: 'monthday', recurMonthDay: d }); }) ||
        take(/\severy\s+(\d{1,2})(?:st|nd|rd|th)(?=\s)/i,
          m => { const d = +m[1]; if (d < 1 || d > 31) return false; recurDefaultDue = { monthday: d }; return set({ recur: 'monthday', recurMonthDay: d }); }) ||
        take(/\severy\s+other\s+(day|week|month)(?=\s)/i, m => set({ recur: 'every', recurEvery: 2, recurUnit: m[1].toLowerCase() })) ||
        take(/\s(?:biweekly|fortnightly)(?=\s)/i, () => set({ recur: 'every', recurEvery: 2, recurUnit: 'week' })) ||
        take(/\severy\s+(\d{1,3})\s*(days?|weeks?|months?)(?=\s)/i,
          m => { const n = +m[1]; if (n < 1) return false; return set({ recur: 'every', recurEvery: n, recurUnit: unitOf(m[2]) }); }) ||
        take(/\severy\s+weekdays?(?=\s)/i, () => { recurDefaultDue = { days: [1, 2, 3, 4, 5] }; return set({ recur: 'days', recurDays: [1, 2, 3, 4, 5] }); }) ||
        take(/\severy\s+weekends?(?=\s)/i, () => { recurDefaultDue = { days: [0, 6] }; return set({ recur: 'days', recurDays: [0, 6] }); }) ||
        take(new RegExp('\\severy\\s+((?:' + WD_RE + ')s?(?:(?:\\s*(?:,|and|&)\\s*|\\s+)(?:' + WD_RE + ')s?)*)(?=\\s)', 'i'), m => {
          const days = [...new Set((m[1].toLowerCase().match(/[a-z]+/g) || []).filter(w => w !== 'and').map(w => WD[w] !== undefined ? WD[w] : WD[w.replace(/s$/, '')]))];
          if (!days.length || days.some(d => d === undefined)) return false;
          days.sort(); recurDefaultDue = { days };
          return set({ recur: 'days', recurDays: days });
        }) ||
        take(/\s(?:daily|every\s*day)(?=\s)/i, () => set({ recur: 'daily' })) ||
        take(/\s(?:weekly|every\s+week)(?=\s)/i, () => set({ recur: 'weekly' })) ||
        take(/\s(?:monthly|every\s+month)(?=\s)/i, () => set({ recur: 'every', recurEvery: 1, recurUnit: 'month' }));
    }

    const defaultDue = off => recurDefaultDue.days
      ? (() => { for (let k = off; k <= off + 7; k++) { const c = plusDays(today, k); if (recurDefaultDue.days.includes(c.getDay())) return c; } return today; })()
      : nextMonthDay(plusDays(today, off), recurDefaultDue.monthday);

    // ── dates and times ──
    let dateSet = false, timeSet = false, tonight = false, dateLabel = '';
    const setDate = (d, label) => { out.due = key(d); dateLabel = label; dateSet = true; return true; };
    const setTime = (h, mi) => {
      if (h < 0 || h > 23 || mi < 0 || mi > 59) return false;
      out.dueTime = `${pad(h)}:${pad(mi)}`; timeSet = true; return true;
    };
    if (opts.dates) {
      // relative minutes/hours -> a concrete moment today (or tomorrow)
      take(/\sin\s+(\d{1,3})\s*(minutes?|mins?|hours?|hrs?|h)(?=\s)/i, m => {
        const n = +m[1], mins = /^h/i.test(m[2]) ? n * 60 : n;
        if (n < 1) return false;
        const t = new Date(now.getTime() + mins * 60000);
        out.due = key(t); out.dueTime = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
        dateSet = true; timeSet = true; dateLabel = ''; out.found.push({ type: 'date', label: `${key(t) === key(today) ? 'Today' : 'Tomorrow'} ${fmtTime(out.dueTime)}` });
      });
      if (!dateSet) take(/\sin\s+(\d{1,3})\s*(days?|weeks?|months?)(?=\s)/i, m => {
        const n = +m[1]; if (n < 1) return false;
        const u = m[2].toLowerCase()[0];
        return setDate(u === 'd' ? plusDays(today, n) : u === 'w' ? plusDays(today, 7 * n) : plusMonths(today, n), `In ${n} ${m[2].toLowerCase().replace(/s$/, '')}${n !== 1 ? 's' : ''}`);
      });
      if (!dateSet) take(/\sday\s+after\s+tomorrow(?=\s)/i, () => setDate(plusDays(today, 2), 'In 2 days'));
      if (!dateSet) take(/\s(?:tomorrow|tomorow|tmrw|tmr)(?=\s)/i, () => setDate(plusDays(today, 1), 'Tomorrow'));
      if (!dateSet) take(/\s(today|tonight)(?=\s)/i, m => { if (m[1].toLowerCase() === 'tonight') tonight = true; return setDate(today, 'Today'); });
      if (!dateSet) take(/\snext\s+week(?=\s)/i, () => setDate(plusDays(today, 7), 'Next week'));
      if (!dateSet) take(/\snext\s+month(?=\s)/i, () => setDate(plusMonths(today, 1), 'Next month'));
      if (!dateSet) take(/\sthis\s+weekend(?=\s)/i, () => setDate(nextWeekday(today, 6, true), 'This weekend'));
      if (!dateSet) take(/\s(\d{4})-(\d{2})-(\d{2})(?=\s)/, m => {
        const d = new Date(+m[1], +m[2] - 1, +m[3]);
        if (d.getMonth() !== +m[2] - 1) return false;
        return setDate(d, `${DAY_SHORT[d.getDay()]} ${d.getDate()} ${MON_SHORT[d.getMonth()]}`);
      });
      if (!dateSet) take(/\s(?:on|by|due|until)\s+(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?(?=\s)/i, m => {      // day/month by default (opts.dmy)
        const dd = opts.dmy === false ? +m[2] : +m[1], mm = opts.dmy === false ? +m[1] : +m[2];
        if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
        let y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : today.getFullYear();
        let d = new Date(y, mm - 1, dd);
        if (d.getMonth() !== mm - 1) return false;
        if (!m[3] && d < today) d = new Date(y + 1, mm - 1, dd);
        return setDate(d, `${DAY_SHORT[d.getDay()]} ${d.getDate()} ${MON_SHORT[d.getMonth()]}`);
      });
      const monthDate = (day, mon, yr) => {
        const mi = MONTHS[mon.toLowerCase()];
        if (mi === undefined || day < 1 || day > 31) return false;
        let y = yr ? +yr : today.getFullYear();
        let d = new Date(y, mi, day);
        if (d.getMonth() !== mi) return false;
        if (!yr && d < today) d = new Date(y + 1, mi, day);
        return setDate(d, `${DAY_SHORT[d.getDay()]} ${d.getDate()} ${MON_SHORT[d.getMonth()]}`);
      };
      if (!dateSet) take(new RegExp('\\s(?:(?:on|by|due|until)\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(' + MONTH_RE + ')\\.?(?:,?\\s+(\\d{4}))?(?=\\s)', 'i'), m => monthDate(+m[1], m[2], m[3]));
      if (!dateSet) take(new RegExp('\\s(?:(?:on|by|due|until)\\s+)?(' + MONTH_RE + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?=\\s)', 'i'), m => monthDate(+m[2], m[1], m[3]));
      if (!dateSet) {
        const re = new RegExp('\\s(?:(on|by|due|until|this|next)\\s+)?(' + WD_RE + ')(?=\\s)', 'i');
        take(re, m => {
          const name = m[2].toLowerCase(), kw = m[1] && m[1].toLowerCase();
          const full = name.length > 4 && !['tues', 'weds', 'thur', 'thurs'].includes(name);
          const rest = s.slice(m.index + m[0].length).trim();
          const endish = rest === '' || /^(at\s+|@\s*)?\d{1,2}(:\d{2})?\s*(am|pm)?(\s|$)/i.test(rest) || /^(at\s+)?noon/i.test(rest);
          if (!full && !kw && !endish) return false;           // "sat", "sun", "wed" are also ordinary words
          const d = kw === 'next' ? weekdayOfNextWeek(today, WD[name]) : nextWeekday(today, WD[name], kw === 'this');
          return setDate(d, `${DAY_SHORT[d.getDay()]} ${d.getDate()} ${MON_SHORT[d.getMonth()]}`);
        });
      }

      // times
      take(/\s(?:at\s+|@\s*)?(\d{1,2}):(\d{2})\s*(am|pm)?(?=\s)/i, m => {
        let h = +m[1]; const mi = +m[2], ap = m[3] && m[3].toLowerCase();
        if (ap) { if (h < 1 || h > 12) return false; h = ap === 'pm' ? (h % 12) + 12 : h % 12; }
        return setTime(h, mi);
      });
      if (!timeSet) take(/\s(?:at\s+|@\s*)?(\d{1,2})\s*(am|pm)(?=\s)/i, m => {
        let h = +m[1]; if (h < 1 || h > 12) return false;
        h = m[2].toLowerCase() === 'pm' ? (h % 12) + 12 : h % 12;
        return setTime(h, 0);
      });
      if (!timeSet) take(/\sat\s+(1[3-9]|2[0-3])(?=\s)/i, m => setTime(+m[1], 0));
      if (!timeSet) take(/\s(?:at\s+)?noon(?=\s)/i, () => setTime(12, 0));
      // "tonight" means 8 PM, unless it is already past 8 PM: then leave it as "today" with no time
      if (tonight && !timeSet && nowHM < '20:00') { out.dueTime = '20:00'; timeSet = true; }

      // a repeat that names its days (or day of month) decides the first date, unless the time already passed today
      if (!dateSet && recurDefaultDue) {
        const d = defaultDue(timeSet && out.dueTime < nowHM ? 1 : 0);
        out.due = key(d);
        dateLabel = `${DAY_SHORT[d.getDay()]} ${d.getDate()} ${MON_SHORT[d.getMonth()]}`;
        dateSet = true;
      }
      if (timeSet && !dateSet) {
        const t = out.dueTime;
        out.due = key(t < nowHM ? plusDays(today, 1) : today);
        dateLabel = t < nowHM ? 'Tomorrow' : 'Today';
        dateSet = true;
      }
      if (dateSet && dateLabel) out.found.push({ type: 'date', label: dateLabel + (timeSet ? ' ' + fmtTime(out.dueTime) : '') });
      else if (timeSet && !dateLabel && !out.found.some(f => f.type === 'date')) out.found.push({ type: 'date', label: fmtTime(out.dueTime) });
    }

    // a repeat that names its days/day-of-month also decides the first due date
    if (out.recur && !out.due && recurDefaultDue) {
      const d = defaultDue(0);
      out.due = key(d);
      out.found.push({ type: 'date', label: `${DAY_SHORT[d.getDay()]} ${d.getDate()} ${MON_SHORT[d.getMonth()]}` });
    }
    if (out.recur) {                                       // flatten {recur, recurEvery, ...} onto the result
      const spec = out.recur;
      out.recur = spec.recur;
      for (const k of ['recurDays', 'recurEvery', 'recurUnit', 'recurMonthDay']) if (spec[k] !== undefined) out[k] = spec[k];
    }

    // ── tidy the text left behind ──
    let text = s.replace(/\s+/g, ' ').trim();
    if (s !== original) {                                  // only strip dangling "on/at/for..." if we actually removed something
      let prev;
      do { prev = text; text = text.replace(/\s+(?:on|at|by|due|until|before|from|for|this|next|every|in|@|-)$/i, '').trim(); } while (text !== prev);
    }
    if (!text) {                                           // nothing left: the whole input was the "date"; keep it as the task text
      return { text: String(raw).trim(), tags: [], priority: 0, due: null, dueTime: null, recur: null, found: [] };
    }
    out.text = text;
    return out;
  }

  return { parse, recurLabel, ordinal, fmtTime };
});
