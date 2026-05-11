import test from "node:test";
import assert from "node:assert/strict";
import { loadApiRuntimeConfig } from "../../shared/config.js";

test("loadApiRuntimeConfig prefers AUTH_TOKEN_SECRET and parses CORS origins", () => {
  const config = loadApiRuntimeConfig({
    AUTH_TOKEN_SECRET: "0123456789abcdef0123456789abcdef",
    CORS_ALLOWED_ORIGINS: "https://dashboard.example.com, http://localhost:5173 ",
    BASIC_AUTH_ENABLED: "true"
  });

  assert.equal(config.authTokenSecret, "0123456789abcdef0123456789abcdef");
  assert.deepEqual(config.authTokenSecrets, ["0123456789abcdef0123456789abcdef"]);
  assert.equal(config.authTokenSecretKid, "v1");
  assert.deepEqual(config.corsAllowedOrigins, [
    "https://dashboard.example.com",
    "http://localhost:5173"
  ]);
});

test("loadApiRuntimeConfig preserves rotation order when V2 secret exists", () => {
  const config = loadApiRuntimeConfig({
    AUTH_TOKEN_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    AUTH_TOKEN_SECRET_V2: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    AUTH_TOKEN_SECRET_V1: "cccccccccccccccccccccccccccccccc"
  });

  assert.equal(config.authTokenSecret, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.deepEqual(config.authTokenSecrets, [
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "cccccccccccccccccccccccccccccccc"
  ]);
  assert.equal(config.authTokenSecretKid, "v2");
});
