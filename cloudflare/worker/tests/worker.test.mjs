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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json([{ k: "health-check" }]);
  try {
    const response = await worker.fetch(request("/api/health"), env);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.supabase_configured, true);
    assert.equal(JSON.stringify(body).includes("SERVICE_ROLE_KEY_VALUE"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unmigrated API endpoints fail explicitly rather than pretending to work", async () => {
  const response = await worker.fetch(request("/api/run"), {});
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


const configuredEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-secret",
};

test("state reads leads and JSON profile values from Supabase REST", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(new Headers(init.headers).get("apikey"), configuredEnv.SUPABASE_SERVICE_ROLE_KEY);
    if (url.pathname.endsWith("/leads")) {
      return Response.json([{ id: "lead-1", name: "Example Ltd", stage: "qualified", score_reasons: "{\"score\":80}", updated_ts: 10 }]);
    }
    if (url.pathname.endsWith("/kv") && url.searchParams.get("k") === "eq.company_profile") {
      return Response.json([{ v: "{\"company_name\":\"Demo Co\"}" }]);
    }
    if (url.pathname.endsWith("/kv")) return Response.json([]);
    throw new Error("Unexpected table request");
  };
  try {
    const response = await worker.fetch(request("/api/state"), configuredEnv);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.leads[0].id, "lead-1");
    assert.deepEqual(body.leads[0].score_reasons, { score: 80 });
    assert.deepEqual(body.profile, { company_name: "Demo Co" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stats computes funnel counts and does not require a live Supabase project in tests", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/leads")) return Response.json([
      { id: "a", stage: "qualified", score: 80 },
      { id: "b", stage: "discovered", score: null },
    ]);
    if (url.pathname.endsWith("/messages")) return Response.json([
      { id: "m1", direction: "out", channel: "email", status: "sent" },
      { id: "m2", direction: "in", channel: "email", status: "received" },
      { id: "m3", direction: "out", channel: "email", status: "draft" },
    ]);
    if (url.pathname.endsWith("/meetings")) return Response.json([{ id: "meeting-1" }]);
    if (url.pathname.endsWith("/kv") && url.searchParams.get("k") === "eq.costs") return Response.json([{ v: "{\"usd\":2,\"calls\":4}" }]);
    if (url.pathname.endsWith("/kv")) return Response.json([{ v: "true" }]);
    throw new Error("Unexpected table request");
  };
  try {
    const response = await worker.fetch(request("/api/stats"), configuredEnv);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total_leads, 2);
    assert.equal(body.qualified_plus, 1);
    assert.equal(body.emails_out, 1);
    assert.equal(body.pending_approvals, 1);
    assert.equal(body.meetings, 1);
    assert.equal(body.approval_mode, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("health checks actual Supabase reachability, not only secret presence", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });
  try {
    const response = await worker.fetch(request("/api/health"), configuredEnv);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "database_unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("lead detail returns the lead and related records from Supabase", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/leads")) {
      return Response.json([{ id: "lead-1", name: "Example Ltd", score_reasons: "{\"headline\":\"Strong fit\"}" }]);
    }
    if (url.pathname.endsWith("/contacts")) return Response.json([{ id: "contact-1", lead_id: "lead-1" }]);
    if (url.pathname.endsWith("/evidence")) return Response.json([]);
    if (url.pathname.endsWith("/messages")) return Response.json([{ id: "msg-1", lead_id: "lead-1", meta: "{\"to_addr\":\"sales@example.com\"}" }]);
    if (url.pathname.endsWith("/meetings") || url.pathname.endsWith("/followups") || url.pathname.endsWith("/memory_notes")) return Response.json([]);
    throw new Error("Unexpected table request");
  };
  try {
    const response = await worker.fetch(request("/api/leads/lead-1"), configuredEnv);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.lead.score_reasons, { headline: "Strong fit" });
    assert.equal(body.contacts[0].id, "contact-1");
    assert.deepEqual(body.messages[0].meta, { to_addr: "sales@example.com" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("read endpoints return a controlled unavailable response when Supabase is not configured", async () => {
  const response = await worker.fetch(request("/api/state"), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "database_unavailable");
});
