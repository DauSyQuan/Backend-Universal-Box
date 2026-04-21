const STORAGE_KEY = 'marine_portal_basic_auth';

export function getStoredBasicAuthHeader() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setStoredBasicAuthHeader(header) {
  try {
    window.localStorage.setItem(STORAGE_KEY, header || '');
  } catch {
    // ignore storage errors
  }
}

export function saveBasicAuth(username, password) {
  const header = `Basic ${btoa(`${String(username ?? '').trim()}:${String(password ?? '')}`)}`;
  setStoredBasicAuthHeader(header);
  return header;
}

export function clearStoredBasicAuthHeader() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

export function hasStoredBasicAuthHeader() {
  return Boolean(getStoredBasicAuthHeader());
}
