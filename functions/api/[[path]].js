// Cloudflare Pages Function: same-origin proxy for the existing /api/* calls.
export async function onRequest(context) {
  const { request, env } = context;
  const workerOrigin = env.API_WORKER_URL;
  if (!env.API_PROXY_TOKEN) {
    return Response.json({ ok: false, error: "api_proxy_not_configured", message: "Set the API_PROXY_TOKEN secret in Pages." }, { status: 503 });
  }
  if (!workerOrigin) {
    return Response.json(
      { ok: false, error: "api_proxy_not_configured", message: "Set API_WORKER_URL in the Pages environment." },
      { status: 503 },
    );
  }

  let target;
  try {
    target = new URL(request.url);
    const upstream = new URL(workerOrigin);
    target.protocol = upstream.protocol;
    target.host = upstream.host;
    target.username = "";
    target.password = "";
  } catch {
    return Response.json(
      { ok: false, error: "invalid_api_worker_url" },
      { status: 500 },
    );
  }

  // The browser never receives the shared secret; Pages adds it on the server side.
  const headers = new Headers(request.headers);
  headers.set("x-autosdr-proxy-token", env.API_PROXY_TOKEN);
  // Preserve the original path and query while routing /api/* to the Worker.
  return fetch(new Request(target.toString(), { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body, redirect: request.redirect }));
}
