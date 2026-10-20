// Project → page URL mapping.
// Every URL listed here is checked on mobile and desktop every FETCH_INTERVAL_MINUTES.
// Quota note: each URL costs 192 PSI requests/day at a 15-minute interval (limit 25,000/day).
export const projects = {
  'Personal site': [
    'https://www.sandeeplokhande.com/'
  ],
  'Watch 1 site': [
    'https://www.bajajhousingfinance.in/',
  ]
};

// Project the dashboard selects when opened without filters ('' = all projects).
export const defaultProject = 'Watch 1 site';

export function validateProjects(map) {
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
  return errors;
}

// Flat list of { project, url } pairs.
export function listTargets(map = projects) {
  return Object.entries(map).flatMap(([project, urls]) => urls.map((url) => ({ project, url })));
}
