import aedes from "aedes";
import dotenv from "dotenv";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";

dotenv.config({ path: path.resolve(process.cwd(), "ops/.env") });
dotenv.config({ path: path.resolve(process.cwd(), "ops/env.example"), override: false });

const booleanTrueValues = new Set(["1", "true", "yes", "on"]);
const booleanFalseValues = new Set(["0", "false", "no", "off"]);

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (booleanTrueValues.has(normalized)) {
    return true;
  }
  if (booleanFalseValues.has(normalized)) {
    return false;
  }
  return fallback;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""), "utf8");
  const rightBuffer = Buffer.from(String(right ?? ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

const port = Number(process.env.MQTT_PORT || 1883);
const allowAnonymous = parseBoolean(process.env.MQTT_ALLOW_ANONYMOUS, false);
const expectedUsername = String(process.env.MQTT_USERNAME || "").trim();
const expectedPassword = String(process.env.MQTT_PASSWORD || "");

if (!allowAnonymous && (!expectedUsername || !expectedPassword)) {
  throw new Error("MQTT_USERNAME and MQTT_PASSWORD are required when MQTT_ALLOW_ANONYMOUS=false");
}

const broker = new aedes({
  authenticate(client, username, password, callback) {
    if (allowAnonymous) {
      callback(null, true);
      return;
    }

    const providedUsername = username ? String(username) : "";
    const providedPassword = password ? password.toString("utf8") : "";
    const authorized =
      safeEqual(providedUsername, expectedUsername) && safeEqual(providedPassword, expectedPassword);

    if (!authorized) {
      const error = new Error("not authorized");
      error.returnCode = 4;
      callback(error, false);
      return;
    }

    callback(null, true);
  }
});

const server = createServer(broker.handle);

server.listen(port, function () {
  console.log(`[mqtt-broker] server started and listening on port ${port}`);
  console.log(`[mqtt-broker] anonymous access ${allowAnonymous ? "enabled" : "disabled"}`);
  if (!allowAnonymous) {
    console.log(`[mqtt-broker] credential auth enabled for user ${expectedUsername}`);
  }
});
