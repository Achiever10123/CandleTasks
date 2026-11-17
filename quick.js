// Quick-add popup: shares style.css, so it follows dark/light, theme color and UI style.
function customAccentVars(hex, dark, plain) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0, l = (mx + mn) / 2;
  if (mx !== mn) { const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
  s = Math.min(.9, Math.max(.4, s)); l = Math.min(.58, Math.max(.36, l));
  const H = Math.round(h), S = Math.round(s * 100), L = Math.round(l * 100);
  const v = {
    '--accent': `hsl(${H} ${S}% ${L}%)`, '--accent-2': `hsl(${H} ${S}% ${Math.min(72, L + 12)}%)`,
    '--accent-bg': `hsla(${H} ${S}% ${L}% / .14)`, '--accent-border': `hsla(${H} ${S}% ${L}% / .36)`, '--accent-glow': `hsla(${H} ${S}% ${L}% / .32)`
  };
  if (plain) Object.assign(v, dark
    ? { '--bg': `hsl(${H} 22% 8%)`, '--bg-2': `hsl(${H} 22% 11%)`, '--bg-3': `hsl(${H} 22% 14%)`, '--border': `hsl(${H} 20% 21%)` }
    : { '--bg': `hsl(${H} 60% 96%)`, '--bg-2': `hsl(${H} 55% 92%)`, '--bg-3': `hsl(${H} 50% 88%)`, '--border': `hsl(${H} 40% 76%)` });
  return v;
}

(async function () {
  const body  = document.getElementById('app-body');
  const input = document.getElementById('quick-input');
  const count = document.getElementById('quick-count');
  const sel   = document.getElementById('quick-list');

  const settings = await window.api.getSettings();
  const colorMap = { default: '', green: 'theme-green', blue: 'theme-blue', red: 'theme-red' };
  const styleMap = { default: '', glass: 'ui-glass', minimal: 'ui-glass', brutalism: 'ui-brutalism', bento: 'ui-bento' };
  body.className = ['quick-body', settings.darkMode ? 'dark' : 'light', colorMap[settings.themeColor] || '', styleMap[settings.uiStyle] || '']
    .filter(Boolean).join(' ');

  // custom accent colour (same maths as the main window)
  if (settings.themeColor === 'custom' && /^#[0-9a-f]{6}$/i.test(settings.customColor || '')) {
    const c = customAccentVars(settings.customColor, !!settings.darkMode, (settings.uiStyle || 'default') === 'default');
    for (const [k, v] of Object.entries(c)) body.style.setProperty(k, v);
  }

  const data = await window.api.getData();
  for (const l of data.lists) {
    const o = document.createElement('option');
    o.value = l.id; o.textContent = l.name;
    if (l.id === data.activeListId) o.selected = true;
    sel.appendChild(o);
  }
  sel.style.display = data.lists.length > 1 ? '' : 'none';

  function updateCount() {
    const n = input.value.length;
    count.textContent = `${n}/120`;
    count.classList.toggle('has-text', n > 0);
    count.classList.toggle('warn', n >= 100 && n < 120);
    count.classList.toggle('max', n >= 120);
  }

  async function submit() {
    const text = input.value.trim();
    if (!text) return;
    await window.api.quickAdd({ text, listId: sel.value });
    window.api.closeQuick();
  }

  input.addEventListener('input', updateCount);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') window.api.closeQuick(); });
  document.getElementById('add-btn').addEventListener('click', submit);
  input.focus();
})();
