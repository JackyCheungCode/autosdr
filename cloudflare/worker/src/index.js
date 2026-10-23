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

const COMPANY_PROFILE_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    company_name: { type: "string" }, tagline: { type: "string" }, what_we_sell: { type: "string" },
    services: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      name: { type: "string" }, description: { type: "string" }, ideal_for: { type: "string" },
      buying_signals: { type: "array", items: { type: "string" } }, source_chunks: { type: "array", items: { type: "string" } },
    }, required: ["name", "description", "ideal_for", "buying_signals", "source_chunks"] } },
    target_industries: { type: "array", items: { type: "string" } },
    case_studies: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      client: { type: "string" }, industry: { type: "string" }, problem: { type: "string" },
      result: { type: "string" }, source_chunks: { type: "array", items: { type: "string" } },
    }, required: ["client", "industry", "problem", "result", "source_chunks"] } },
    pricing_notes: { type: "string" }, limitations: { type: "array", items: { type: "string" } },
    differentiators: { type: "array", items: { type: "string" } },
  },
  required: ["company_name", "tagline", "what_we_sell", "services", "target_industries",
    "case_studies", "pricing_notes", "limitations", "differentiators"],
};

const DEFAULT_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

async function runStructuredAi(env, systemPrompt, userPrompt, schemaName, schema) {
  if (!env.Yoo || typeof env.Yoo.run !== "function") {
    const error = new Error("ai_not_configured");
    error.code = "ai_not_configured";
    throw error;
  }
  const model = env.Yoo_MODEL || DEFAULT_AI_MODEL;
  const result = await env.Yoo.run(model, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: schema,
    },
    max_tokens: 1800,
    temperature: 0.2,
  });
  const content = result?.response ?? result?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    try { return JSON.parse(content); }
    catch {
      const start = content.indexOf("{");
      const end = content.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { return JSON.parse(content.slice(start, end + 1)); } catch { /* handled below */ }
      }
    }
  }
  if (content && typeof content === "object" && !Array.isArray(content)) return content;
  throw new Error("Workers AI returned invalid structured output");
}

async function generateCompanyProfile(env, sourceName, sourceText) {
  if (!env.Yoo || typeof env.Yoo.run !== "function") {
    const error = new Error("ai_not_configured");
    error.code = "ai_not_configured";
    throw error;
  }
  const chunks = [];
  for (let i = 0; i < sourceText.length; i += 7000) {
    chunks.push({ id: `text-${chunks.length + 1}`, text: sourceText.slice(i, i + 7000) });
  }
  const doc = chunks.map(chunk => `[${chunk.id}] ${chunk.text}`).join("\\n\\n").slice(0, 90000);
  const profile = await runStructuredAi(
    env,
    "Extract a faithful company profile from the supplied document. Use only facts present; never invent services, clients, numbers or claims. Cite chunk IDs for services and case studies. If pricing is absent, say so. Include promises sales must never make in limitations.",
    `Source name: ${sourceName}\\nDocument chunks:\\n\\n${doc}`,
    "company_profile",
    COMPANY_PROFILE_SCHEMA,
  );
  if (!Array.isArray(profile.services) || !Array.isArray(profile.case_studies) ||
      !Array.isArray(profile.target_industries) || !Array.isArray(profile.limitations)) {
    throw new Error("LLM returned invalid company profile");
  }
  await setKv(env, "company_profile", profile);
  await setKv(env, "company_profile_source", { name: sourceName, chunks });
  return profile;
}

const REPLY_CLASSIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    category: { type: "string", enum: ["positive", "meeting_requested", "question", "pricing_objection", "technical_objection", "not_interested", "not_now", "wrong_person_referral", "other"] },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
    summary: { type: "string" },
    extracted_question: { type: "string" },
    next_action: { type: "string" },
  },
  required: ["category", "sentiment", "summary", "extracted_question", "next_action"],
};

async function classifyReply(env, lead, contact, subject, body) {
  if (!env.Yoo || typeof env.Yoo.run !== "function") {
    const error = new Error("ai_not_configured");
    error.code = "ai_not_configured";
    throw error;
  }
  const result = await runStructuredAi(
    env,
    "Classify a prospect's email reply. Use meeting_requested for a request to talk, see a demo, or pick a time. Separate pricing and technical objections. Do not draft or send a response.",
    `Company: ${lead?.name || "unknown"}; contact role: ${contact?.role || "unknown"}\\nSubject: ${subject}\\nReply: ${body.slice(0, 5000)}`,
    "reply_classification",
    REPLY_CLASSIFICATION_SCHEMA,
  );
  const categories = REPLY_CLASSIFICATION_SCHEMA.properties.category.enum;
  const sentiments = REPLY_CLASSIFICATION_SCHEMA.properties.sentiment.enum;
  if (!result || typeof result !== "object" ||
      !categories.includes(result.category) ||
      !sentiments.includes(result.sentiment) ||
      ["summary", "extracted_question", "next_action"].some((field) => typeof result[field] !== "string")) {
    throw new Error("LLM returned invalid classification");
  }
  return result;
}

const ICP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    location: { type: "string" },
    industries: { type: "array", items: { type: "string" } },
    company_size: { type: "string" },
    special_targeting: { type: "string" },
    must_have: { type: "array", items: { type: "string" } },
    disqualifiers: { type: "array", items: { type: "string" } },
    search_queries: { type: "array", items: { type: "string" } },
    scoring_hints: { type: "array", items: { type: "string" } },
  },
  required: ["location", "industries", "company_size", "special_targeting",
    "must_have", "disqualifiers", "search_queries", "scoring_hints"],
};

async function generateIcp(env, profile, answers) {
  if (!env.Yoo || typeof env.Yoo.run !== "function") {
    const error = new Error("ai_not_configured");
    error.code = "ai_not_configured";
    throw error;
  }
  const icp = await runStructuredAi(
    env,
    "You are an Ideal Customer Profile agent. Ground the ICP in the selling company's actual offers. Produce realistic search queries for company websites/directories, concrete disqualifiers, and useful scoring hints. Do not invent company capabilities.",
    `Selling company: ${profile.company_name || "(unknown)"}; services: ${(profile.services || []).map(s => s.name).join("; ")}; offer: ${profile.what_we_sell || ""}\\nTarget location: ${answers.location || ""}\\nTarget industry/market: ${answers.industry || ""}\\nCompany size/criteria: ${answers.size || ""}\\nSpecial targeting: ${answers.targeting || ""}`,
    "icp",
    ICP_SCHEMA,
  );
  if (!Array.isArray(icp.industries) || !Array.isArray(icp.search_queries) ||
      !Array.isArray(icp.disqualifiers) || !Array.isArray(icp.must_have) ||
      !Array.isArray(icp.scoring_hints)) throw new Error("LLM returned invalid ICP");
  return icp;
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

function sseEvent(event) {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

function eventsStream(env, headers, request) {
  let cancelled = false;
  let timer = null;
  let lastSeq = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (text) => {
        if (!cancelled) controller.enqueue(encoder.encode(text));
      };
      const wait = (ms) => new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      });
      try {
        const initial = await supabaseRequest(env, "events", {
          select: "seq,ts,agent,type,label,lead_id,payload",
          order: "seq.desc",
          limit: "100",
        });
        if (!Array.isArray(initial)) throw new Error("Unexpected events response");
        for (const event of initial.reverse()) {
          lastSeq = Math.max(lastSeq, Number(event.seq) || 0);
          send(sseEvent(event));
        }
        let lastKeepalive = Date.now();
        while (!cancelled) {
          await wait(3000);
          if (cancelled) break;
          const rows = await supabaseRequest(env, "events", {
            select: "seq,ts,agent,type,label,lead_id,payload",
            seq: `gt.${lastSeq}`,
            order: "seq.asc",
            limit: "100",
          });
          if (!Array.isArray(rows)) throw new Error("Unexpected events response");
          for (const event of rows) {
            lastSeq = Math.max(lastSeq, Number(event.seq) || 0);
            send(sseEvent(event));
          }
          if (Date.now() - lastKeepalive >= 15000) {
            send(": keepalive\n\n");
            lastKeepalive = Date.now();
          }
        }
      } catch {
        send(`event: error\ndata: ${JSON.stringify({ error: "event_stream_unavailable" })}\n\n`);
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      ...headers,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
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

    if (url.pathname === "/api/events/stream" && request.method === "GET") {
      return eventsStream(env, headers, request);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      try {
        await supabaseRequest(env, "kv", { select: "k", limit: "1" });
        return json({ ok: true, service: "autosdr-worker", stage: "read-api", supabase_configured: true }, 200, headers);
      } catch {
        return json({ ok: false, service: "autosdr-worker", supabase_configured: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY), error: "database_unavailable" }, 503, headers);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/run") {
      try {
        const input = await formOrJson(request);
        const requested = Math.max(1, Math.min(3, Number(input.max_leads || 3) || 3));
        const icp = await getKv(env, "icp", null);
        const profile = await getKv(env, "company_profile", null);
        if (!icp || !Array.isArray(icp.industries) || !icp.industries.length) {
          return json({ok:false,error:"icp_required",message:"请先生成并保存 ICP。"},400,headers);
        }
        const query = [icp.industries.slice(0,3).join(" OR "), icp.location || "Europe", "industrial valve importer distributor company"].filter(Boolean).join(" ");
        let provider = "";
        let results = [];
        if (env.TAVILY_API_KEY) {
          provider = "tavily";
          const response = await fetch("https://api.tavily.com/search", {
            method:"POST", headers:{"content-type":"application/json"},
            body:JSON.stringify({api_key:env.TAVILY_API_KEY,query,search_depth:"basic",max_results:requested,include_answer:false})
          });
          if (!response.ok) throw new Error("tavily_http_"+response.status);
          const data=await response.json();
          results=(data.results||[]).map(x=>({name:x.title||"",url:x.url||"",content:x.content||""}));
        } else if (env.SERPER_API_KEY) {
          provider = "serper";
          const response = await fetch("https://google.serper.dev/search", {
            method:"POST", headers:{"content-type":"application/json","X-API-KEY":env.SERPER_API_KEY},
            body:JSON.stringify({q:query,num:requested})
          });
          if (!response.ok) throw new Error("serper_http_"+response.status);
          const data=await response.json();
          results=(data.organic||[]).map(x=>({name:x.title||"",url:x.link||"",content:x.snippet||""}));
        } else {
          return json({ok:false,error:"search_provider_not_configured",message:"未配置 Tavily 或 Serper 搜索密钥。"},503,headers);
        }
        const now=Date.now()/1000, saved=[], processed=[];
        const scoringSchema={type:"object",additionalProperties:false,properties:{
          score:{type:"integer",minimum:0,maximum:100},
          qualified:{type:"boolean"},
          industry_fit:{type:"integer",minimum:0,maximum:40},
          buying_signal:{type:"integer",minimum:0,maximum:30},
          evidence_quality:{type:"integer",minimum:0,maximum:20},
          target_market_fit:{type:"integer",minimum:0,maximum:10},
          reasons:{type:"array",items:{type:"string"}},
          summary:{type:"string"},
          next_step:{type:"string"}
        },required:["score","qualified","industry_fit","buying_signal","evidence_quality","target_market_fit","reasons","summary","next_step"]};
        for (const item of results) {
          if (!item.name || !item.url) continue;
          let parsed; try { parsed=new URL(item.url); } catch { continue; }
          if (!/^https?:$/.test(parsed.protocol)) continue;
          const domain=parsed.hostname.replace(/^www\./,"");
          const existing=await supabaseRequest(env,"leads",{select:"id,name,stage,score",domain:`eq.${domain}`,limit:"1"});
          if (existing.length) { processed.push({id:existing[0].id,name:existing[0].name,domain,duplicate:true,stage:existing[0].stage,score:existing[0].score}); continue; }
          let evidence=String(item.content||"").slice(0,2500);
          try {
            const site=await fetch(parsed.origin,{headers:{"user-agent":"HephaestusLeadResearch/1.0"},signal:AbortSignal.timeout(4500)});
            if(site.ok){
              const html=(await site.text()).slice(0,18000).replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim();
              if(html) evidence=(evidence+"\\nWebsite evidence: "+html).slice(0,5000);
            }
          } catch {}
          const scoreResult=await runStructuredAi(env,
            "Score a B2B prospect for an industrial valve exporter. Use only supplied search and website evidence. Do not assume the company buys valves unless evidence supports it. Industry fit max 40, buying signals max 30, evidence quality max 20, target market fit max 10. Qualified must be true only when score >= 70 and evidence supports a plausible industrial valve buyer, importer, distributor, equipment manufacturer, or engineering contractor. If evidence is weak, score conservatively and list that uncertainty.",
            JSON.stringify({company:item.name,website:parsed.origin,domain,icp,product:profile?.what_we_sell||"industrial valves",search_evidence:item.content||"",website_evidence:evidence}),
            "prospect_score",scoringSchema);
          const score=Math.max(0,Math.min(100,Number(scoreResult.score)||0));
          const qualified=Boolean(scoreResult.qualified)&&score>=70;
          const stage=qualified?"qualified":"potential";
          const id=crypto.randomUUID();
          await supabaseRequest(env,"leads",{},null,{method:"POST",body:{
            id,name:item.name.slice(0,240),domain,website:parsed.origin,
            location:String(icp.location||"").slice(0,160),
            industry:String((icp.industries||[]).slice(0,3).join(", ")).slice(0,240),
            size_hint:String(icp.company_size||"").slice(0,120),
            source:provider,stage,score,
            score_reasons:JSON.stringify({industry_fit:scoreResult.industry_fit,buying_signal:scoreResult.buying_signal,evidence_quality:scoreResult.evidence_quality,target_market_fit:scoreResult.target_market_fit,reasons:scoreResult.reasons,summary:scoreResult.summary,next_step:scoreResult.next_step}),
            service:String(profile?.what_we_sell||"industrial valves").slice(0,240),
            research:evidence,created_ts:now,updated_ts:now
          }});
          const result={id,name:item.name,domain,website:parsed.origin,source:provider,stage,score,qualified,reasons:scoreResult.reasons};
          saved.push(result); processed.push(result);
          await supabaseRequest(env,"events",{},null,{method:"POST",body:{
            ts:Date.now()/1000,agent:"research_scoring",type:"success",
            label:`Researched and scored ${item.name.slice(0,100)}: ${score}/100 (${stage})`,
            lead_id:id,payload:JSON.stringify({score,qualified,reasons:scoreResult.reasons,domain})
          }});
        }
        await supabaseRequest(env,"events",{},null,{method:"POST",body:{
          ts:Date.now()/1000,agent:"discovery",type:saved.length?"success":"warning",
          label:`Search and scoring completed via ${provider}: ${saved.length} new prospects processed`,
          lead_id:saved[0]?.id||null,
          payload:JSON.stringify({provider,query,requested,received:results.length,saved:saved.length,processed:processed.length,qualified:saved.filter(x=>x.qualified).length})
        }});
        return json({ok:true,status:"discovery_research_scoring_complete",provider,requested,received:results.length,saved:saved.length,processed:processed.length,qualified:saved.filter(x=>x.qualified).length,leads:processed,emails_sent:0,message:"搜索、官网证据收集和 AI 评分已执行；未发送邮件。"},200,headers);
      } catch (error) {
        const msg=String(error?.message||"run_failed");
        const code=msg.startsWith("tavily_http_")||msg.startsWith("serper_http_")?"search_provider_failed":msg.startsWith("Supabase")?"database_write_failed":"run_failed";
        return json({ok:false,error:code,message:code==="search_provider_failed"?"搜索服务请求失败，请检查密钥权限或额度。":code==="database_write_failed"?"搜索有结果，但写入数据库失败。":"启动搜索失败；请确认 ICP、搜索密钥和数据库配置。"},502,headers);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/stop") {
      return json({
        ok: false,
        error: "pipeline_not_running",
        message: "当前 Cloudflare 版本没有可停止的客户开发后台任务，因为该流程尚未迁移。",
      }, 501, headers);
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

    if (request.method === "POST" && url.pathname === "/api/company/text") {
      try {
        const input = await formOrJson(request);
        const sourceText = String(input.text || "").trim();
        if (!sourceText) return json({ ok: false, error: "empty_text" }, 400, headers);
        if (sourceText.length > 180000) return json({ ok: false, error: "text_too_large" }, 413, headers);
        const sourceName = String(input.name || "company description").trim().slice(0, 160) || "company description";
        const profile = await generateCompanyProfile(env, sourceName, sourceText);
        return json({ ok: true, profile }, 200, headers);
      } catch (error) {
        if (error?.code === "ai_not_configured") return json({ ok: false, error: "ai_not_configured" }, 503, headers);
        return json({ ok: false, error: "company_profile_generation_failed" }, 502, headers);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/icp") {
      try {
        const input = await formOrJson(request);
        const profile = await getKv(env, "company_profile");
        if (!profile) return json({ ok: false, error: "company_profile_required" }, 400, headers);
        const answers = {
          location: String(input.location || ""),
          industry: String(input.industry || ""),
          size: String(input.size || ""),
          targeting: String(input.targeting || ""),
        };
        const icp = await generateIcp(env, profile, answers);
        await setKv(env, "icp", icp);
        return json({ ok: true, icp }, 200, headers);
      } catch (error) {
        if (error?.code === "ai_not_configured") {
          return json({ ok: false, error: "ai_not_configured" }, 503, headers);
        }
        return json({ ok: false, error: "icp_generation_failed" }, 502, headers);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/sim/reply") {
      let input;
      try { input = await formOrJson(request); }
      catch { return json({ ok: false, error: "invalid_request" }, 400, headers); }
      const fromEmail = String(input.from_email || "").trim().toLowerCase();
      const subject = String(input.subject || "").trim().slice(0, 500);
      const body = String(input.body || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail) || !body) {
        return json({ ok: false, error: "from_email_and_body_required" }, 400, headers);
      }
      if (body.length > 10000) return json({ ok: false, error: "reply_too_large" }, 413, headers);
      try {
        const contacts = await supabaseRequest(env, "contacts", {
          select: "id,lead_id,name,role,email", email: `ilike.${fromEmail}`, order: "ts.desc", limit: "1",
        });
        if (!contacts.length) return json({ ok: false, error: "contact_not_found" }, 404, headers);
        const contact = contacts[0];
        const leadRows = contact.lead_id ? await supabaseRequest(env, "leads", {
          select: "id,name,stage", id: `eq.${contact.lead_id}`, limit: "1",
        }) : [];
        const lead = leadRows[0] || null;
        const classification = await classifyReply(env, lead, contact, subject, body);
        const now = Date.now() / 1000;
        const messageId = crypto.randomUUID();
        await supabaseRequest(env, "messages", {}, null, {
          method: "POST",
          body: {
            id: messageId, lead_id: contact.lead_id || null, contact_id: contact.id,
            direction: "in", channel: "email", subject, body,
            meta: JSON.stringify({ classification, simulated: true }),
            status: "received", ts: now,
          },
        });
        const interested = ["positive", "meeting_requested", "question", "pricing_objection", "technical_objection"];
        if (lead && interested.includes(classification.category)) {
          await supabaseRequest(env, "leads", { id: `eq.${lead.id}` }, null, {
            method: "PATCH", body: { stage: "interested", updated_ts: now },
          });
        } else if (lead && classification.category === "not_interested") {
          await supabaseRequest(env, "leads", { id: `eq.${lead.id}` }, null, {
            method: "PATCH", body: { stage: "not_interested", updated_ts: now },
          });
        }
        await supabaseRequest(env, "events", {}, null, {
          method: "POST",
          body: {
            ts: now, agent: "inbox", type: "decision",
            label: `Reply classified: ${classification.category} (${classification.sentiment})`,
            lead_id: contact.lead_id || null, payload: JSON.stringify(classification),
          },
        });
        return json({ ok: true, received: true, classification, auto_reply_sent: false }, 200, headers);
      } catch (error) {
        if (error?.code === "ai_not_configured") return json({ ok: false, error: "ai_not_configured" }, 503, headers);
        return json({ ok: false, error: "reply_processing_failed" }, 502, headers);
      }
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

    const rejectMatch = url.pathname.match(/^\/api\/outbox\/([^/]+)\/reject$/);
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

    if (request.method === "POST" && url.pathname.match(/^\/api\/outbox\/[^/]+\/approve$/)) {
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
