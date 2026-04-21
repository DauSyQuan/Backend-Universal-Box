export function debounce(fn, wait = 150) {
  let timer = null;

  return (...args) => {
    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSampleValue(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parsePrometheusMetrics(text = '') {
  const metrics = {
    httpRequestsTotal: [],
    httpRequestDurationSeconds: [],
    httpRequestsInFlight: 0
  };

  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;

    const [nameAndLabels, rawValue] = line.split(/\s+/);
    if (!nameAndLabels || rawValue === undefined) continue;

    const value = parseSampleValue(rawValue);
    if (nameAndLabels.startsWith('http_requests_in_flight')) {
      metrics.httpRequestsInFlight = value;
      continue;
    }

    if (nameAndLabels.startsWith('http_requests_total')) {
      metrics.httpRequestsTotal.push({ raw: nameAndLabels, value });
      continue;
    }

    if (nameAndLabels.startsWith('http_request_duration_seconds')) {
      metrics.httpRequestDurationSeconds.push({ raw: nameAndLabels, value });
    }
  }

  return metrics;
}

export function pickPrometheusCounter(entries, labelMatcher = {}) {
  if (!Array.isArray(entries)) return 0;
  const matcherEntries = Object.entries(labelMatcher);

  return entries.reduce((accumulator, entry) => {
    const labels = Object.fromEntries(
      Array.from(entry.raw.matchAll(/([a-zA-Z_]+)="([^"]*)"/g), ([, key, val]) => [key, val])
    );
    const matches = matcherEntries.every(([key, expected]) => labels[key] === expected);
    return matches ? accumulator + entry.value : accumulator;
  }, 0);
}
