export function getHealth() {
  return {
    status: "ok",
    service: "api",
    timestamp: new Date().toISOString()
  };
}

export function getReady({ database }) {
  return {
    status: database ? "ready" : "not_ready",
    service: "api",
    checks: {
      database
    },
    timestamp: new Date().toISOString()
  };
}
