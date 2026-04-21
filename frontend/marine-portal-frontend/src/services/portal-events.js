const listeners = new Set();

export function onPortalEvent(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitPortalEvent(event) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // ignore listener failures
    }
  }
}
