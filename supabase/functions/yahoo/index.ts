// Yahoo price proxy for the PWA. Adds a browser UA (Yahoo 429s bare datacenter
// requests) and falls back query1 -> query2.
//
// Security notes:
//  - `path` is caller-supplied. A bare startsWith() check is not sufficient:
//    "/v8/finance/../../quoteSummary" (or its percent-encoded form) passes the
//    prefix test but resolves to a different path once fetch() normalises the
//    URL. The path is therefore resolved against the target origin first and
//    re-validated afterwards.
//  - The resolved origin is pinned to the two Yahoo hosts, so the proxy can
//    never be pointed at an internal or third-party address.
//  - Only GET/OPTIONS are accepted, and the path length is capped.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];
// fundamentals-timeseries: the keyless market-cap source (prices.js fetchProfile).
const ALLOWED_PREFIXES = ["/v8/finance/", "/v1/finance/search", "/ws/fundamentals-timeseries/v1/finance/timeseries/"];
const MAX_PATH_LEN = 512;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });

/** Resolve `path` against `host`, or return null if it escapes the allowlist. */
function resolveTarget(host: string, path: string): URL | null {
  if (!path || path.length > MAX_PATH_LEN) return null;
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (path.includes("\\")) return null;

  let url: URL;
  try {
    url = new URL(path, host);
  } catch {
    return null;
  }
  // Re-check AFTER normalisation, so ".." / "%2e%2e" traversal cannot slip past.
  if (url.origin !== new URL(host).origin) return null;
  if (url.pathname.includes("..")) return null;
  if (!ALLOWED_PREFIXES.some((p) => url.pathname.startsWith(p))) return null;
  return url;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const path = new URL(req.url).searchParams.get("path") || "";
  if (!resolveTarget(HOSTS[0], path)) return json({ error: "bad path" }, 400);

  let last = "";
  for (const host of HOSTS) {
    const target = resolveTarget(host, path);
    if (!target) continue;
    try {
      const r = await fetch(target.toString(), {
        headers: { "User-Agent": UA, "Accept": "application/json" },
        redirect: "error", // a redirect could leave the pinned origin
        signal: AbortSignal.timeout(8000),
      });
      const body = await r.text();
      if (r.ok) {
        return new Response(body, {
          headers: { ...cors, "content-type": "application/json" },
        });
      }
      last = "HTTP " + r.status;
    } catch (e) {
      last = String(e);
    }
  }
  return json({ error: last || "fetch failed" }, 502);
});
