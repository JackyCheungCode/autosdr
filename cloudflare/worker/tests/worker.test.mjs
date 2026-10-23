import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const request = (path, init = {}) =>
  new Request(`https://autosdr-api.example.workers.dev${path}`, init);

test("health reports missing secrets without exposing any secret", async () => {
  const response = await worker.fetch(request("/api/health"), {});
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.supabase_configured, false);
  assert.equal(JSON.stringify(body).includes("SERVICE_ROLE_KEY_VALUE"), false);
});

test("health reports configuration presence without returning secret values", async () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "SERVICE_ROLE_KEY_VALUE",
  };
  const response = await worker.fetch(request("/api/health"), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.supabase_configured, true);
  assert.equal(JSON.stringify(body).includes("SERVICE_ROLE_KEY_VALUE"), false);
});

test("unmigrated API endpoints fail explicitly rather than pretending to work", async () => {
  const response = await worker.fetch(request("/api/state"), {});
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error, "not_implemented");
});

test("unapproved production origins do not receive CORS permission", async () => {
  const req = request("/api/health", {
    headers: { Origin: "https://attacker.example" },
  });
  const response = await worker.fetch(req, {});
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});
