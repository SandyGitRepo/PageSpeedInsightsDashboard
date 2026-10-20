import { formatTime, getJson, psiHref, strategyLabel } from './common.js';

// Renders the stored Lighthouse result for one hit with Google's report renderer
// (vendor/lighthouse/standalone.js, which defines window.__initLighthouseReport__).
async function main() {
  const id = encodeURIComponent(location.pathname.split('/').pop());
  const meta = document.getElementById('hit-meta');

  let run;
  let lhr;
  try {
    [run, lhr] = await Promise.all([getJson(`api/runs/${id}`), getJson(`api/runs/${id}/lighthouse.json`)]);
  } catch (err) {
    meta.textContent = `Could not load report: ${err.message}`;
    meta.className = 'error';
    return;
  }

  meta.textContent = `${run.project} · ${strategyLabel(run.strategy)} · checked ${formatTime(run.fetched_at)}`;
  const psi = document.getElementById('hit-psi');
  psi.href = psiHref(run.url, run.strategy);
  psi.hidden = false;
  document.title = `${strategyLabel(run.strategy)} · ${run.url} · ${formatTime(run.fetched_at)}`;

  window.__LIGHTHOUSE_JSON__ = lhr;
  window.__initLighthouseReport__();
}

main();
