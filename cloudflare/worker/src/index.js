const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.FRONTEND_ORIGIN || "";
  const isLocalDev = /^http:\/\/localhost(?::\d+)?$/.test(origin || "");
  if (!origin || (origin !== allowed && !isLocalDev)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

function requireSupabase(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase server configuration is missing");
  }
  return {
    base: env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/",
    key: env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

async function supabaseRequest(env, table, params = {}, range = null, options = {}) {
  const cfg = requireSupabase(env);
  const url = new URL(table, cfg.base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const headers = {
    apikey: cfg.key,
    authorization: `Bearer ${cfg.key}`,
    accept: "application/json",
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    headers.prefer = options.prefer || "return=representation";
  }
  if (range) {
    headers.range = range;
    headers["range-unit"] = "items";
  }
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    // Do not return upstream response bodies: PostgREST errors may include schema details.
    throw new Error(`Supabase query failed (HTTP ${response.status})`);
  }
  if (response.status === 204) return [];
  return response.json();
}

async function formOrJson(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) return request.json();
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}

async function setKv(env, key, value) {
  const rows = await supabaseRequest(
    env, "kv", { on_conflict: "k" }, null,
    { method: "POST", body: { k: key, v: JSON.stringify(value) }, prefer: "resolution=merge-duplicates,return=representation" },
  );
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("Supabase KV upsert returned no row");
  return rows[0];
}

async function selectAll(env, table, select = "*", filters = {}) {
  const result = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const rows = await supabaseRequest(
      env, table, { select, ...filters, order: filters.order || "id.asc" },
      `${offset}-${offset + pageSize - 1}`,
    );
    if (!Array.isArray(rows)) throw new Error("Unexpected Supabase response");
    result.push(...rows);
    if (rows.length < pageSize) return result;
  }
}

async function getKv(env, key, fallback = null) {
  const rows = await supabaseRequest(env, "kv", {
    select: "v", k: `eq.${key}`, limit: "1",
  });
  if (!rows.length || rows[0].v == null) return fallback;
  try { return JSON.parse(rows[0].v); } catch { return rows[0].v; }
}

function parseJsonFields(row, fields) {
  const out = { ...row };
  for (const field of fields) {
    if (out[field]) {
      try { out[field] = JSON.parse(out[field]); } catch { /* keep legacy text intact */ }
    }
  }
  return out;
}

async function getState(env) {
  const [leads, profile, icp, costs] = await Promise.all([
    selectAll(env, "leads", "*", { order: "updated_ts.desc,id.asc" }),
    getKv(env, "company_profile"),
    getKv(env, "icp"),
    getKv(env, "costs", { calls: 0, tokens_in: 0, tokens_out: 0, usd: 0 }),
  ]);
  return {
    stages: ["discovered", "potential", "researching", "qualified", "contacted",
      "interested", "meeting_scheduled", "converted", "not_qualified",
      "not_interested", "do_not_contact"],
    leads: leads.map((lead) => parseJsonFields(lead, ["score_reasons", "service", "research"])),
    profile, icp, costs,
  };
}

async function getStats(env) {
  const [leads, messages, meetings, costs, approvalMode] = await Promise.all([
    selectAll(env, "leads", "id,stage,score"),
    selectAll(env, "messages", "id,direction,channel,status"),
    selectAll(env, "meetings", "id"),
    getKv(env, "costs", { usd: 0, calls: 0 }),
    getKv(env, "approval_mode", false),
  ]);
  const funnel = {};
  for (const lead of leads) funnel[lead.stage] = (funnel[lead.stage] || 0) + 1;
  const qualifiedStages = new Set(["qualified", "contacted", "interested", "meeting_scheduled", "converted"]);
  const qualified = leads.filter((lead) => qualifiedStages.has(lead.stage));
  const scored = qualified.filter((lead) => lead.score != null);
  const qualifiedScore = scored.length
    ? scored.reduce((sum, lead) => sum + Number(lead.score), 0) / scored.length : null;
  const qualifiedPlus = qualified.length;
  return {
    funnel, total_leads: leads.length, qualified_plus: qualifiedPlus,
    emails_out: messages.filter((m) => m.direction === "out" && String(m.channel || "").startsWith("email") && m.status !== "draft").length,
    emails_live: messages.filter((m) => m.direction === "out" && m.channel === "email").length,
    replies: messages.filter((m) => m.direction === "in").length,
    whatsapp: messages.filter((m) => String(m.channel || "").startsWith("whatsapp")).length,
    meetings: meetings.length,
    avg_qualified_score: qualifiedScore == null ? null : Math.round(qualifiedScore * 10) / 10,
    cost_usd: costs?.usd || 0, llm_calls: costs?.calls || 0,
    cost_per_qualified: qualifiedPlus ? Number(((costs?.usd || 0) / qualifiedPlus).toFixed(4)) : null,
    approval_mode: Boolean(approvalMode),
    pending_approvals: messages.filter((m) => m.status === "draft").length,
  };
}

async function leadDetail(env, leadId) {
  const [leads, contacts, evidence, messages, meetings, followups, notes] = await Promise.all([
    supabaseRequest(env, "leads", { select: "*", id: `eq.${leadId}`, limit: "1" }),
    supabaseRequest(env, "contacts", { select: "*", lead_id: `eq.${leadId}` }),
    supabaseRequest(env, "evidence", { select: "*", lead_id: `eq.${leadId}`, order: "ts.asc" }),
    supabaseRequest(env, "messages", { select: "*", lead_id: `eq.${leadId}`, order: "ts.asc" }),
    supabaseRequest(env, "meetings", { select: "*", lead_id: `eq.${leadId}` }),
    supabaseRequest(env, "followups", { select: "*", lead_id: `eq.${leadId}`, order: "due_ts.asc" }),
    supabaseRequest(env, "memory_notes", { select: "*", lead_id: `eq.${leadId}`, order: "ts.asc" }),
  ]);
  if (!leads.length) return null;
  return {
    lead: parseJsonFields(leads[0], ["score_reasons", "service", "research"]),
    contacts, evidence,
    messages: messages.map((message) => parseJsonFields(message, ["meta"])),
    meetings, followups, notes,
  };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    const url = new URL(request.url);
    const headers = { ...cors, "cache-control": "no-store" };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname.startsWith("/api/")) {
      if (!env.API_PROXY_TOKEN) {
        return json({ ok: false, error: "api_proxy_not_configured" }, 503, headers);
      }
      if (request.headers.get("x-autosdr-proxy-token") !== env.API_PROXY_TOKEN) {
        return json({ ok: false, error: "unauthorized" }, 401, headers);
      }
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      try {
        await supabaseRequest(env, "kv", { select: "k", limit: "1" });
        return json({ ok: true, service: "autosdr-worker", stage: "read-api", supabase_configured: true }, 200, headers);
      } catch {
        return json({ ok: false, service: "autosdr-worker", supabase_configured: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY), error: "database_unavailable" }, 503, headers);
      }
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      try { return json(await getState(env), 200, headers); }
      catch { return json({ ok: false, error: "database_unavailable" }, 503, headers); }
    }

    if (request.method === "GET" && url.pathname === "/api/stats") {
      try { return json(await getStats(env), 200, headers); }
      catch { return json({ ok: false, error: "database_unavailable" }, 503, headers); }
    }

    if (request.method === "GET" && url.pathname === "/api/memory") {
      try {
        const notes = await supabaseRequest(env, "memory_notes", { select: "*", order: "ts.desc", limit: "50" });
        return json({ short_term: { current_task: null, active_agent: null, leads: {} }, long_term_notes: notes }, 200, headers);
      } catch { return json({ ok: false, error: "database_unavailable" }, 503, headers); }
    }

    if (request.method === "POST" && url.pathname === "/api/settings/approval") {
      try {
        const input = await formOrJson(request);
        const raw = input.enabled;
        const enabled = raw === true || raw === "true" || raw === "1" || raw === 1 || raw === "on";
        await setKv(env, "approval_mode", enabled);
        return json({ ok: true, approval_mode: enabled }, 200, headers);
      } catch {
        return json({ ok: false, error: "database_unavailable" }, 503, headers);
      }
    }

    const rejectMatch = url.pathname.match(/^\\/api\\/outbox\\/([^/]+)\\/reject$/);
    if (request.method === "POST" && rejectMatch) {
      try {
        const messageId = decodeURIComponent(rejectMatch[1]);
        const updated = await supabaseRequest(
          env, "messages",
          { id: `eq.${messageId}`, status: "eq.draft" },
          null,
          { method: "PATCH", body: { status: "rejected" } },
        );
        if (!Array.isArray(updated) || updated.length === 0) {
          return json({ ok: false, error: "draft_not_found_or_already_handled" }, 404, headers);
        }
        return json({ ok: true }, 200, headers);
      } catch {
        return json({ ok: false, error: "database_unavailable" }, 503, headers);
      }
    }

    if (request.method === "POST" && url.pathname.match(/^\\/api\\/outbox\\/[^/]+\\/approve$/)) {
      return json({
        ok: false,
        error: "not_implemented",
        message: "Email delivery is intentionally not enabled in the Cloudflare Worker yet.",
      }, 501, headers);
    }

    if (request.method === "GET" && url.pathname === "/api/outbox") {
      try {
        const drafts = await supabaseRequest(env, "messages", { select: "*", status: "eq.draft", order: "ts.asc" });
        const leadIds = [...new Set(drafts.map((draft) => draft.lead_id).filter(Boolean))];
        const leads = leadIds.length
          ? await supabaseRequest(env, "leads", { select: "id,name", id: `in.(${leadIds.join(",")})` })
          : [];
        const names = new Map(leads.map((lead) => [lead.id, lead.name]));
        return json({ drafts: drafts.map((draft) => ({ ...parseJsonFields(draft, ["meta"]), lead_name: names.get(draft.lead_id) || null })) }, 200, headers);
      } catch { return json({ ok: false, error: "database_unavailable" }, 503, headers); }
    }

    const leadMatch = url.pathname.match(/^\/api\/leads\/([^/]+)$/);
    if (request.method === "GET" && leadMatch) {
      try {
        const detail = await leadDetail(env, decodeURIComponent(leadMatch[1]));
        return detail ? json(detail, 200, headers) : json({ ok: false, error: "not_found" }, 404, headers);
      } catch { return json({ ok: false, error: "database_unavailable" }, 503, headers); }
    }

    if (url.pathname.startsWith("/api/")) {
      return json({
        ok: false,
        error: "not_implemented",
        message: "This endpoint has not yet been migrated from FastAPI.",
        path: url.pathname,
      }, 501, headers);
    }

    return json({ ok: false, error: "not_found" }, 404, headers);
  },
};
