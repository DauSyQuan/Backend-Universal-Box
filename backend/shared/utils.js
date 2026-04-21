import { timingSafeEqual } from "node:crypto";

export const BOOLEAN_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
export const BOOLEAN_FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (BOOLEAN_TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (BOOLEAN_FALSE_VALUES.has(normalized)) {
    return false;
  }
  return fallback;
}

export function normalizeSecret(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

export function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""), "utf8");
  const rightBuffer = Buffer.from(String(right ?? ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
