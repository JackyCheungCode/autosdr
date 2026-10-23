import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { onRequest } from "../../../functions/api/[[path]].js";

const request = (path, init = {}) => {
  const headers = new Headers(init.headers);
  if (!headers.has("x-autosdr-proxy-token")) headers.set("x-autosdr-proxy-token", "test-proxy-token");
  return new Request(`https://autosdr-api.example.workers.dev${path}`, { ...init, headers });
};

const baseEnv = { API_PROXY_TOKEN: "test-proxy-token" };

test("health reports missing secrets without exposing any secret", async () => {
  const response = await worker.fetch(request("/api/health"), baseEnv);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.supabase_configured, false);
  assert.equal(JSON.stringify(body).includes("SERVICE_ROLE_KEY_VALUE"), false);
});

test("health reports configuration presence without returning secret values", async () => {
  const env = {
    API_PROXY_TOKEN: "test-proxy-token",
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
  const response = await worker.fetch(request("/api/run"), baseEnv);
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error, "not_implemented");
});

test("unapproved production origins do not receive CORS permission", async () => {
  const req = request("/api/health", {
    headers: { Origin: "https://attacker.example" },
  });
  const response = await worker.fetch(req, baseEnv);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});


const configuredEnv = {
  API_PROXY_TOKEN: "test-proxy-token",
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
  const response = await worker.fetch(request("/api/state"), baseEnv);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "database_unavailable");
});


test("Worker rejects direct requests without the trusted proxy token", async () => {
  const response = await worker.fetch(new Request("https://autosdr-api.example.workers.dev/api/state"), baseEnv);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "unauthorized");
});

test("Worker refuses API access when the proxy token is not configured", async () => {
  const response = await worker.fetch(request("/api/state"), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "api_proxy_not_configured");
});


test("Pages proxy injects the shared token server-side and preserves the API path", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl;
  let seenToken;
  globalThis.fetch = async (input, init = {}) => {
    seenUrl = new URL(input instanceof Request ? input.url : input);
    seenToken = new Headers(init.headers || (input instanceof Request ? input.headers : undefined)).get("x-autosdr-proxy-token");
    return Response.json({ ok: true });
  };
  try {
    const response = await onRequest({
      request: new Request("https://autosdr-preview.pages.dev/api/state?view=compact"),
      env: { API_WORKER_URL: "https://autosdr-api.example.workers.dev", API_PROXY_TOKEN: "server-only-token" },
    });
    assert.equal(response.status, 200);
    assert.equal(seenUrl.origin, "https://autosdr-api.example.workers.dev");
    assert.equal(seenUrl.pathname, "/api/state");
    assert.equal(seenUrl.searchParams.get("view"), "compact");
    assert.equal(seenToken, "server-only-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Pages proxy fails closed when its shared token is missing", async () => {
  const response = await onRequest({
    request: new Request("https://autosdr-preview.pages.dev/api/state"),
    env: { API_WORKER_URL: "https://autosdr-api.example.workers.dev" },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "api_proxy_not_configured");
});


test("approval setting accepts JSON and upserts a boolean into Supabase KV", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl;
  let seenBody;
  let seenMethod;
  globalThis.fetch = async (input, init = {}) => {
    seenUrl = new URL(input);
    seenMethod = init.method;
    seenBody = JSON.parse(init.body);
    assert.match(new Headers(init.headers).get("prefer"), /resolution=merge-duplicates/);
    return Response.json([{ k: "approval_mode", v: "true" }]);
  };
  try {
    const response = await worker.fetch(request("/api/settings/approval", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }), configuredEnv);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, approval_mode: true });
    assert.equal(seenUrl.pathname.endsWith("/kv"), true);
    assert.equal(seenMethod, "POST");
    assert.deepEqual(seenBody, { k: "approval_mode", v: "true" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reject draft only changes a currently-draft message", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl;
  let seenBody;
  let seenMethod;
  globalThis.fetch = async (input, init = {}) => {
    seenUrl = new URL(input instanceof Request ? input.url : input);
    const actualInit = init || {};
    seenMethod = actualInit.method || (input instanceof Request ? input.method : "GET");
    seenBody = JSON.parse(actualInit.body || (input instanceof Request ? await input.clone().text() : "null"));
    assert.equal(seenUrl.searchParams.get("id"), "eq.msg-123");
    assert.equal(seenUrl.searchParams.get("status"), "eq.draft");
    return Response.json([{ id: "msg-123", status: "rejected" }]);
  };
  try {
    const response = await worker.fetch(request("/api/outbox/msg-123/reject", { method: "POST" }), configuredEnv);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(seenMethod, "PATCH");
    assert.deepEqual(seenBody, { status: "rejected" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reject draft returns 404 when no pending draft was updated", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json([]);
  try {
    const response = await worker.fetch(request("/api/outbox/missing/reject", { method: "POST" }), configuredEnv);
    assert.equal(response.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("approve draft remains disabled until email delivery is safely ported", async () => {
  const response = await worker.fetch(request("/api/outbox/msg-123/approve", { method: "POST" }), configuredEnv);
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error, "not_implemented");
});


test("ICP generation fails closed when LLM credentials are not configured", async () => {
  const response = await worker.fetch(request("/api/icp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ location: "Germany", industry: "manufacturing" }),
  }), configuredEnv);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "company_profile_required");
});

test("ICP generation uses configured LLM and persists the structured result", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const expectedIcp = {
    location: "Germany",
    industries: ["manufacturing"],
    company_size: "50-500 employees",
    special_targeting: "exporters",
    must_have: ["B2B website"],
    disqualifiers: ["consumer-only"],
    search_queries: ["German industrial exporters"],
    scoring_hints: ["clear export activity"],
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (url.hostname === "example.supabase.co" && url.pathname.endsWith("/kv") && (init.method || "GET") === "GET") {
      return Response.json([{ v: JSON.stringify({ company_name: "Example Co", services: [{ name: "Export consulting" }], what_we_sell: "Consulting" }) }]);
    }
    if (url.hostname === "api.openai.com") {
      return Response.json({ choices: [{ message: { content: JSON.stringify(expectedIcp) } }] });
    }
    if (url.hostname === "example.supabase.co" && url.pathname.endsWith("/kv") && init.method === "POST") {
      assert.match(new Headers(init.headers).get("prefer"), /resolution=merge-duplicates/);
      return Response.json([{ k: "icp", v: JSON.stringify(expectedIcp) }]);
    }
    throw new Error("Unexpected mocked fetch: " + url.toString());
  };
  try {
    const env = { ...configuredEnv, OPENAI_API_KEY: "test-llm-key", OPENAI_MODEL: "test-model" };
    const response = await worker.fetch(request("/api/icp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ location: "Germany", industry: "manufacturing", size: "50-500 employees", targeting: "exporters" }),
    }), env);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).icp, expectedIcp);
    assert.equal(calls.some(call => call.url.hostname === "api.openai.com"), true);
    assert.equal(calls.some(call => call.method === "POST" && call.url.hostname === "example.supabase.co"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
