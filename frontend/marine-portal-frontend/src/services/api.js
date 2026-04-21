import { getStoredBasicAuthHeader } from './auth';
import { emitPortalEvent } from './portal-events';
import { parsePrometheusMetrics, sleep } from '../utils/performance';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
const BASIC_USER = import.meta.env.VITE_API_BASIC_USER || '';
const BASIC_PASS = import.meta.env.VITE_API_BASIC_PASS || '';
const BASIC_AUTH_HEADER = BASIC_USER && BASIC_PASS
  ? `Basic ${btoa(`${BASIC_USER}:${BASIC_PASS}`)}`
  : (import.meta.env.VITE_API_BASIC_AUTH_HEADER || '');
const DEFAULT_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS || 15_000);
const DEFAULT_RETRY_COUNT = Number(import.meta.env.VITE_API_RETRY_COUNT || 2);

function buildUrl(path) {
  const base = API_BASE_URL.replace(/\/$/, '');
  const suffix = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

function buildHeaders(extraHeaders = {}) {
  const headers = {
    accept: 'application/json',
    ...extraHeaders
  };

  if (BASIC_AUTH_HEADER && !headers.authorization && !headers.Authorization) {
    headers.authorization = BASIC_AUTH_HEADER;
  }

  const storedHeader = getStoredBasicAuthHeader();
  if (storedHeader && !headers.authorization && !headers.Authorization) {
    headers.authorization = storedHeader;
  }

  return headers;
}

function createAbortController(timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0 || typeof AbortController === 'undefined') {
    return { controller: null, clear: () => {} };
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(new Error('request_timeout')), timeoutMs);
  return {
    controller,
    clear: () => clearTimeout(timer)
  };
}

function parseRateLimit(headers) {
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset') || headers.get('retry-after');
  if (!limit && !remaining && !reset) return null;

  return {
    limit: limit ? Number(limit) : null,
    remaining: remaining ? Number(remaining) : null,
    reset: reset ? Number(reset) : null
  };
}

function emitRateLimitFeedback(response, path) {
  const rateLimit = parseRateLimit(response.headers);
  if (rateLimit) {
    emitPortalEvent({ type: 'rate-limit', path, rateLimit, status: response.status });
  }

  if (response.status === 429) {
    emitPortalEvent({
      type: 'toast',
      tone: 'warning',
      title: 'Rate limit reached',
      message: `Request to ${path} was rate-limited. Please retry shortly.`
    });
  } else {
    const remaining = rateLimit?.remaining;
    if (remaining !== null && remaining !== undefined && remaining <= 5) {
      emitPortalEvent({
        type: 'toast',
        tone: 'warning',
        title: 'Rate limit warning',
        message: rateLimit.limit ? `${rateLimit.remaining}/${rateLimit.limit} requests remaining for ${path}` : `Low request budget remaining for ${path}`
      });
    }
  }
}

async function requestOnce(path, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const { controller, clear } = createAbortController(timeoutMs);
  const mergedOptions = {
    ...options,
    signal: options.signal || controller?.signal,
    headers: buildHeaders(options.headers)
  };

  try {
    const response = await fetch(buildUrl(path), mergedOptions);
    emitRateLimitFeedback(response, path);
    return response;
  } catch (error) {
    emitPortalEvent({
      type: 'toast',
      tone: 'danger',
      title: 'Request failed',
      message: `${path}: ${error?.message || 'network error'}`
    });
    throw error;
  } finally {
    clear();
  }
}

async function requestRaw(path, options = {}) {
  const retries = options.retries ?? DEFAULT_RETRY_COUNT;
  const method = String(options.method || 'GET').toUpperCase();
  const shouldRetry = method === 'GET' || method === 'HEAD';
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await requestOnce(path, options);
      const text = await response.text();

      if (!response.ok) {
        const contentType = response.headers.get('content-type') || '';
        const payload = contentType.includes('application/json')
          ? JSON.parse(text || '{}')
          : { raw: text };
        const error = new Error(payload?.error || response.statusText || 'request_failed');
        error.status = response.status;
        error.payload = payload;
        error.rateLimit = parseRateLimit(response.headers);
        throw error;
      }

      return { response, text };
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const retryAfter = Number(error?.payload?.retry_after || error?.rateLimit?.reset || 0);
      const retryable = shouldRetry && (status === 0 || status >= 500 || status === 429);

      if (!retryable || attempt >= retries) {
        throw error;
      }

      emitPortalEvent({
        type: 'toast',
        tone: 'warning',
        title: 'Retrying request',
        message: `${path} attempt ${attempt + 2}/${retries + 1}`
      });

      const waitMs = retryAfter > 0 ? Math.min(30_000, retryAfter * 1000) : Math.min(2_000 * (attempt + 1), 5_000);
      await sleep(waitMs);
    }
  }

  throw lastError || new Error('request_failed');
}

async function requestJson(path, options = {}) {
  const { text } = await requestRaw(path, options);
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function requestJsonWithMeta(path, options = {}) {
  const { response, text } = await requestRaw(path, options);
  const payload = text ? JSON.parse(text) : {};
  return {
    payload,
    meta: {
      rateLimit: parseRateLimit(response.headers),
      status: response.status
    }
  };
}

async function requestBlob(path, options = {}) {
  const { response, text } = await requestRaw(path, options);
  if (response.ok) {
    return response.blob();
  }

  const payload = (() => {
    try {
      return JSON.parse(text || '{}');
    } catch {
      return { raw: text };
    }
  })();
  const error = new Error(payload?.error || response.statusText || 'request_failed');
  error.status = response.status;
  error.payload = payload;
  throw error;
}

export async function getPublicHealth() {
  return requestJson('/api/health');
}

export async function getPublicHealthWithMeta() {
  return requestJsonWithMeta('/api/health');
}

export async function getPublicReady() {
  return requestJson('/api/ready');
}

export async function getPublicReadyWithMeta() {
  return requestJsonWithMeta('/api/ready');
}

export async function getMetrics() {
  const response = await requestOnce('/metrics');
  const text = await response.text();
  return parsePrometheusMetrics(text);
}

export async function listEdges(params = {}) {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', String(params.limit));
  if (params.tenant) query.set('tenant', params.tenant);
  if (params.vessel) query.set('vessel', params.vessel);
  if (params.online_seconds) query.set('online_seconds', String(params.online_seconds));
  return requestJson(`/api/mcu/edges${query.toString() ? `?${query.toString()}` : ''}`);
}

export async function listEdgesWithMeta(params = {}) {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', String(params.limit));
  if (params.tenant) query.set('tenant', params.tenant);
  if (params.vessel) query.set('vessel', params.vessel);
  if (params.online_seconds) query.set('online_seconds', String(params.online_seconds));
  return requestJsonWithMeta(`/api/mcu/edges${query.toString() ? `?${query.toString()}` : ''}`);
}

export async function getEdgeDetail(params = {}) {
  const tenant = encodeURIComponent(params.tenant);
  const vessel = encodeURIComponent(params.vessel);
  const edge = encodeURIComponent(params.edge);
  const query = new URLSearchParams();
  if (params.onlineSeconds) query.set('online_seconds', String(params.onlineSeconds));
  return requestJson(`/api/mcu/edges/${tenant}/${vessel}/${edge}${query.toString() ? `?${query.toString()}` : ''}`);
}

export async function getEdgeTraffic(params = {}) {
  const tenant = encodeURIComponent(params.tenant);
  const vessel = encodeURIComponent(params.vessel);
  const edge = encodeURIComponent(params.edge);
  const query = new URLSearchParams();
  if (params.interfaceName) query.set('interface_name', params.interfaceName);
  if (params.windowMinutes) query.set('window_minutes', String(params.windowMinutes));
  if (params.limit) query.set('limit', String(params.limit));
  return requestJson(`/api/mcu/edges/${tenant}/${vessel}/${edge}/traffic${query.toString() ? `?${query.toString()}` : ''}`);
}

export async function listCommands(params = {}) {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', String(params.limit));
  if (params.offset) query.set('offset', String(params.offset));
  if (params.after) query.set('after', String(params.after));
  if (params.tenant) query.set('tenant_code', params.tenant);
  if (params.vessel) query.set('vessel_code', params.vessel);
  if (params.edge) query.set('edge_code', params.edge);
  if (params.status) query.set('status', params.status);
  return requestJson(`/api/commands${query.toString() ? `?${query.toString()}` : ''}`);
}

export async function listCommandsWithMeta(params = {}) {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', String(params.limit));
  if (params.offset) query.set('offset', String(params.offset));
  if (params.after) query.set('after', String(params.after));
  if (params.tenant) query.set('tenant_code', params.tenant);
  if (params.vessel) query.set('vessel_code', params.vessel);
  if (params.edge) query.set('edge_code', params.edge);
  if (params.status) query.set('status', params.status);
  return requestJsonWithMeta(`/api/commands${query.toString() ? `?${query.toString()}` : ''}`);
}

export async function createCommand(payload) {
  return requestJson('/api/commands', {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}

export async function listPackages(params = {}) {
  const query = new URLSearchParams();
  if (params.tenant) query.set('tenant_code', params.tenant);
  if (params.includeInactive) query.set('include_inactive', 'true');
  return requestJson(`/api/packages${query.toString() ? `?${query.toString()}` : ''}`);
}

export async function listPackagesWithMeta(params = {}) {
  const query = new URLSearchParams();
  if (params.tenant) query.set('tenant_code', params.tenant);
  if (params.includeInactive) query.set('include_inactive', 'true');
  return requestJsonWithMeta(`/api/packages${query.toString() ? `?${query.toString()}` : ''}`);
}

export async function getUsageReport(params = {}) {
  const query = new URLSearchParams();
  if (params.tenant) query.set('tenant', params.tenant);
  if (params.vessel) query.set('vessel', params.vessel);
  if (params.bucket) query.set('bucket', params.bucket);
  if (params.windowMinutes) query.set('window_minutes', String(params.windowMinutes));
  if (params.dateFrom) query.set('date_from', params.dateFrom);
  if (params.dateTo) query.set('date_to', params.dateTo);
  return requestJson(`/api/reports/usage${query.toString() ? `?${query.toString()}` : ''}`);
}

export async function getUsageReportWithMeta(params = {}) {
  const query = new URLSearchParams();
  if (params.tenant) query.set('tenant', params.tenant);
  if (params.vessel) query.set('vessel', params.vessel);
  if (params.bucket) query.set('bucket', params.bucket);
  if (params.windowMinutes) query.set('window_minutes', String(params.windowMinutes));
  if (params.dateFrom) query.set('date_from', params.dateFrom);
  if (params.dateTo) query.set('date_to', params.dateTo);
  return requestJsonWithMeta(`/api/reports/usage${query.toString() ? `?${query.toString()}` : ''}`);
}

export async function listPackageAudit(params = {}) {
  const query = new URLSearchParams();
  if (params.tenant) query.set('tenant', params.tenant);
  if (params.packageCode) query.set('package_code', params.packageCode);
  if (params.vessel) query.set('vessel', params.vessel);
  if (params.username) query.set('username', params.username);
  if (params.actionType) query.set('action_type', params.actionType);
  if (params.dateFrom) query.set('date_from', params.dateFrom);
  if (params.dateTo) query.set('date_to', params.dateTo);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.offset) query.set('offset', String(params.offset));
  if (params.after) query.set('after', String(params.after));
  return requestJson(`/api/package-audit${query.toString() ? `?${query.toString()}` : ''}`);
}

export async function listPackageAuditWithMeta(params = {}) {
  const query = new URLSearchParams();
  if (params.tenant) query.set('tenant', params.tenant);
  if (params.packageCode) query.set('package_code', params.packageCode);
  if (params.vessel) query.set('vessel', params.vessel);
  if (params.username) query.set('username', params.username);
  if (params.actionType) query.set('action_type', params.actionType);
  if (params.dateFrom) query.set('date_from', params.dateFrom);
  if (params.dateTo) query.set('date_to', params.dateTo);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.offset) query.set('offset', String(params.offset));
  if (params.after) query.set('after', String(params.after));
  return requestJsonWithMeta(`/api/package-audit${query.toString() ? `?${query.toString()}` : ''}`);
}

export async function listAssignments(params = {}) {
  const query = new URLSearchParams();
  if (params.tenant) query.set('tenant', params.tenant);
  if (params.vessel) query.set('vessel', params.vessel);
  if (params.packageId) query.set('package_id', params.packageId);
  if (params.limit) query.set('limit', String(params.limit));
  return requestJson(`/api/package-assignments${query.toString() ? `?${query.toString()}` : ''}`);
}

export async function getPackageAssignment(id) {
  return requestJson(`/api/package-assignments/${encodeURIComponent(id)}`);
}

export async function createPackage(payload) {
  return requestJson('/api/packages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}

export async function updatePackage(id, payload) {
  return requestJson(`/api/packages/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}

export async function assignPackage(packageId, payload) {
  return requestJson(`/api/packages/${encodeURIComponent(packageId)}/assign`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}

export async function unassignPackageAssignment(id) {
  return requestJson(`/api/package-assignments/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
}

export async function exportUsageReport(params = {}) {
  const query = new URLSearchParams();
  if (params.tenant) query.set('tenant', params.tenant);
  if (params.vessel) query.set('vessel', params.vessel);
  if (params.username) query.set('username', params.username);
  if (params.packageCode) query.set('package_code', params.packageCode);
  if (params.dateFrom) query.set('date_from', params.dateFrom);
  if (params.dateTo) query.set('date_to', params.dateTo);
  if (params.bucket) query.set('bucket', params.bucket);
  if (params.windowMinutes) query.set('window_minutes', String(params.windowMinutes));
  return requestBlob(`/api/reports/usage/export${query.toString() ? `?${query.toString()}` : ''}`);
}
