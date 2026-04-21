import http from "k6/http";
import encoding from "k6/encoding";
import { check, sleep } from "k6";

const baseUrl = __ENV.API_BASE_URL || "http://127.0.0.1:3000";
const basicUser = __ENV.BASIC_AUTH_USERNAME || "admin";
const basicPass = __ENV.BASIC_AUTH_PASSWORD || "123";

function basicAuthHeader(username, password) {
  return `Basic ${encoding.b64encode(`${username}:${password}`)}`;
}

function authHeaders() {
  return {
    Authorization: basicAuthHeader(basicUser, basicPass),
    Accept: "application/json"
  };
}

function checkOk(res, name) {
  return check(res, {
    [`${name} status is 200`]: (response) => response.status === 200
  });
}

export const options = {
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"]
  },
  scenarios: {
    baseline: {
      executor: "constant-vus",
      exec: "baseline",
      vus: 5,
      duration: "2m",
      startTime: "0s"
    },
    spike: {
      executor: "ramping-vus",
      exec: "spike",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 20 },
        { duration: "30s", target: 20 },
        { duration: "30s", target: 0 }
      ],
      startTime: "2m"
    },
    stress: {
      executor: "constant-arrival-rate",
      exec: "stress",
      rate: 30,
      timeUnit: "1s",
      duration: "2m",
      preAllocatedVUs: 20,
      maxVUs: 80,
      startTime: "4m"
    },
    soak: {
      executor: "constant-vus",
      exec: "soak",
      vus: 3,
      duration: "5m",
      startTime: "6m"
    }
  }
};

export function baseline() {
  const health = http.get(`${baseUrl}/api/health`);
  checkOk(health, "health");

  const ready = http.get(`${baseUrl}/api/ready`);
  checkOk(ready, "ready");

  sleep(1);
}

export function spike() {
  const res = http.get(`${baseUrl}/api/mcu/edges?limit=10&offset=0`, {
    headers: authHeaders()
  });
  checkOk(res, "edges");
  sleep(0.5);
}

export function stress() {
  const commands = http.get(`${baseUrl}/api/commands?limit=10&offset=0`, {
    headers: authHeaders()
  });
  checkOk(commands, "commands");

  const packages = http.get(`${baseUrl}/api/packages?include_inactive=true`, {
    headers: authHeaders()
  });
  checkOk(packages, "packages");

  sleep(0.25);
}

export function soak() {
  const report = http.get(`${baseUrl}/api/reports/usage?bucket=hour&window_minutes=1440`, {
    headers: authHeaders()
  });
  checkOk(report, "usage_report");

  sleep(2);
}
