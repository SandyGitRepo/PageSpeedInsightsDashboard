const ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];
const METRIC_AUDITS = [
  'first-contentful-paint',
  'largest-contentful-paint',
  'total-blocking-time',
  'cumulative-layout-shift',
  'speed-index',
];
const MAX_ISSUES_PER_CATEGORY = 15;
const RETRY_DELAY_MS = 15_000;

export class PsiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// The key travels in the query string, so make sure it never leaks via error messages.
function redact(text, apiKey) {
  return apiKey?.length >= 8 ? String(text).replaceAll(apiKey, '***') : String(text);
}

async function request(url, strategy, apiKey, timeoutMs) {
  const params = new URLSearchParams({ url, strategy: strategy.toUpperCase(), key: apiKey });
  for (const category of CATEGORIES) params.append('category', category);

  let res;
  try {
    res = await fetch(`${ENDPOINT}?${params}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `timed out after ${timeoutMs / 1000}s` : err.message;
    throw new PsiError(redact(`Request failed: ${reason}`, apiKey));
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.error?.message || `HTTP ${res.status}`;
    throw new PsiError(redact(message, apiKey), res.status);
  }
  if (!body?.lighthouseResult) throw new PsiError('Response did not contain a Lighthouse result.');
  return body;
}

export async function runPagespeed({ url, strategy, apiKey, timeoutMs }) {
  try {
    return summarize(await request(url, strategy, apiKey, timeoutMs));
  } catch (err) {
    const retryable = err.status === 429 || err.status >= 500;
    if (!retryable) throw err;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return summarize(await request(url, strategy, apiKey, timeoutMs));
  }
}

const stripMarkdownLinks = (text) => (text ?? '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

function failingAudits(category, audits) {
  return (category?.auditRefs ?? [])
    .filter((ref) => ref.group !== 'metrics' && ref.group !== 'hidden')
    .map((ref) => audits[ref.id])
    .filter(
      (audit) =>
        audit &&
        audit.score !== null &&
        audit.score < 0.9 &&
        ['numeric', 'binary', 'metricSavings'].includes(audit.scoreDisplayMode),
    )
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_ISSUES_PER_CATEGORY)
    .map((audit) => ({
      id: audit.id,
      title: audit.title,
      description: stripMarkdownLinks(audit.description),
      displayValue: audit.displayValue ?? null,
      score: audit.score,
    }));
}

function summarizeField(experience) {
  if (!experience?.metrics) return null;
  return {
    overall: experience.overall_category ?? null,
    metrics: Object.entries(experience.metrics).map(([id, m]) => ({
      id,
      percentile: m.percentile,
      category: m.category,
    })),
  };
}

// Pull out the fields the dashboard uses; the full Lighthouse result is kept as `lhr`
// for the full report page.
function summarize(body) {
  const lhr = body.lighthouseResult;
  const audits = lhr.audits ?? {};
  const categories = lhr.categories ?? {};
  const score = (id) => (categories[id]?.score == null ? null : Math.round(categories[id].score * 100));
  const numeric = (id) => audits[id]?.numericValue ?? null;

  return {
    fetchedAt: Date.parse(lhr.fetchTime) || Date.now(),
    scores: {
      performance: score('performance'),
      accessibility: score('accessibility'),
      bestPractices: score('best-practices'),
      seo: score('seo'),
    },
    metrics: {
      fcpMs: numeric('first-contentful-paint'),
      lcpMs: numeric('largest-contentful-paint'),
      tbtMs: numeric('total-blocking-time'),
      cls: numeric('cumulative-layout-shift'),
      siMs: numeric('speed-index'),
    },
    details: {
      finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl ?? body.id,
      lighthouseVersion: lhr.lighthouseVersion,
      runWarnings: lhr.runWarnings ?? [],
      metrics: METRIC_AUDITS.filter((id) => audits[id]).map((id) => ({
        id,
        title: audits[id].title,
        displayValue: audits[id].displayValue ?? null,
        score: audits[id].score,
      })),
      categories: CATEGORIES.filter((id) => categories[id]).map((id) => ({
        id,
        title: categories[id].title,
        score: score(id),
        issues: failingAudits(categories[id], audits),
      })),
      fieldData: summarizeField(body.loadingExperience),
      originFieldData: summarizeField(body.originLoadingExperience),
    },
    lhr,
  };
}
