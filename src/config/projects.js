// Project → page URL mapping.
// Every URL listed here is checked on mobile and desktop every FETCH_INTERVAL_MINUTES.
// Quota note: each URL costs 48 PSI requests/day at an hourly interval (limit 25,000/day).
export const projects = {
  'Personal site': [
    'https://www.sandeeplokhande.com/'
  ],
  'Bajaj Housing Finance': [
    'https://www.bajajhousingfinance.in/',
  ],
  'ICICI Home Finance': [
    'https://www.icicihfc.com/',
  ],
  'Aadhar Housing Finance': [
    'https://aadharhousing.com/',
  ],
  'HDFC Home Loans': [
    'https://homeloans.hdfc.bank.in/',
  ],
};

// Project the dashboard selects when opened without filters ('' = all projects).
export const defaultProject = 'Bajaj Housing Finance';

// URLs that also get availability/response-time checks from Indian cities (Globalping).
// Every other URL gets PageSpeed checks only. Each URL here must also be listed in `projects`.
export const uptimeUrls = [
  'https://www.bajajhousingfinance.in/',
];

export function validateProjects(map, uptime = []) {
  const errors = [];
  if (!map || typeof map !== 'object' || Object.keys(map).length === 0) {
    errors.push('No projects configured.');
  }
  for (const [name, urls] of Object.entries(map ?? {})) {
    if (!name.trim()) errors.push('Project name must not be empty.');
    if (!Array.isArray(urls) || urls.length === 0) {
      errors.push(`Project "${name}" must have at least one URL.`);
      continue;
    }
    const seen = new Set();
    for (const url of urls) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        errors.push(`Project "${name}": invalid URL "${url}".`);
        continue;
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        errors.push(`Project "${name}": URL must be http(s): "${url}".`);
      }
      if (seen.has(url)) errors.push(`Project "${name}": duplicate URL "${url}".`);
      seen.add(url);
    }
  }
  const configured = new Set(Object.values(map ?? {}).flat());
  for (const url of uptime) {
    if (!configured.has(url)) errors.push(`uptimeUrls: "${url}" is not listed in any project.`);
  }
  return errors;
}

// Flat list of { project, url } pairs.
export function listTargets(map = projects) {
  return Object.entries(map).flatMap(([project, urls]) => urls.map((url) => ({ project, url })));
}
