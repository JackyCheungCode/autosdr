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

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      const configured = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
      return json({
        ok: configured,
        service: "autosdr-worker",
        stage: "bootstrap",
        supabase_configured: configured,
        note: configured
          ? "Worker configuration detected; business API migration is not complete."
          : "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY as Worker secrets before database integration.",
      }, configured ? 200 : 503, cors);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({
        ok: false,
        error: "not_implemented",
        message: "This endpoint has not been migrated from FastAPI yet.",
        path: url.pathname,
      }, 501, cors);
    }

    return json({ ok: false, error: "not_found" }, 404, cors);
  },
};
