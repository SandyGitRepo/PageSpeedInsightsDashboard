// Shared DOM/format helpers. All user/remote data goes through textContent, never innerHTML.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function scoreClass(score) {
  if (score === null || score === undefined) return 'score-na';
  if (score >= 90) return 'score-good';
  if (score >= 50) return 'score-avg';
  return 'score-poor';
}

export function scoreBadge(score) {
  return el('span', { className: `score ${scoreClass(score)}` }, score ?? '–');
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const formatTime = (ms) => (ms ? dateTime.format(new Date(ms)) : '–');

export function formatMs(ms) {
  if (ms === null || ms === undefined) return '–';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export const formatCls = (cls) => (cls === null || cls === undefined ? '–' : cls.toFixed(3));

export const strategyLabel = (s) => (s === 'mobile' ? 'Mobile' : 'Desktop');

// The app's root URL, taken from this module's own URL, so the app works under any path prefix
// (e.g. https://example.com/projects/psi/) as well as at /.
const APP_ROOT = new URL('./', import.meta.url);

export async function getJson(path) {
  const res = await fetch(new URL(path, APP_ROOT), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const reportHref = (id) => new URL(`report/${encodeURIComponent(id)}`, APP_ROOT).pathname;

export function psiHref(url, strategy) {
  const params = new URLSearchParams({ url, form_factor: strategy });
  return `https://pagespeed.web.dev/analysis?${params}`;
}
