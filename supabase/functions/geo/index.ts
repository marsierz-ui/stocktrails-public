// geo: resolve the caller's country (ISO 3166-1 alpha-2) from their IP.
// The edge runtime sits behind Cloudflare but cf-ipcountry is not forwarded,
// so we look the IP up via ipapi.co (free tier; clients cache the result for
// hours, so volume stays trivial).
//
// Returns { country, ip_country, ip_tz, vpn }:
//  - ip_country: where the IP geolocates.
//  - vpn: the IP belongs to a hosting / VPN provider (org match below). Then
//    country is "XV" - a user-assigned ISO code the World view shows as its own
//    "VPN" category instead of crediting the exit node's country. Clients that
//    predate this field read only `country`, so they get XV too.
//  - ip_tz: the IP location's IANA timezone. Newer clients compare the country
//    it implies with their own clock's timezone (a VPN moves the IP, not the
//    device clock) and also record XV on a mismatch; see cloud.js resolveCountry.
//  - ip_lat / ip_lon: the IP location rounded to 0.1 degree (~10 km), so the
//    client can flag impossible travel between two lookups. Not stored server-side;
//    the client keeps the last fix (at_geo_fix) on the device.
//
// Security note: x-forwarded-for is attacker-controlled. The value is validated
// as a literal IP address and percent-encoded before it reaches the URL, and
// cf-connecting-ip (set by the edge, not by the client) is preferred.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Content-Type": "application/json",
};

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-fA-F:]{2,45}$/;

// Datacenter / VPN exit networks. Deliberately NOT Cloudflare, Akamai or Fastly:
// iCloud Private Relay and WARP egress through them but keep the user's real
// country, so they are not a location spoof.
const VPN_ORG = new RegExp([
  "vpn", "m247", "datacamp", "cdn77", "clouvider", "packethub", "tefincom", "proton", "mullvad",
  "31173 services", "private layer", "performive", "hostroyale", "zenlayer", "leaseweb", "ovh",
  "hetzner", "digitalocean", "linode", "vultr", "choopa", "constant company", "contabo",
  "amazon", "\\baws\\b", "oracle cloud", "alibaba", "tencent cloud", "hostinger", "servers\\.com",
  "hosting", "data ?cent(er|re)", "colo(cation)?\\b",
].join("|"), "i");

function validIp(raw: string | null | undefined): string | null {
  const ip = (raw || "").trim();
  if (!ip || ip.length > 45) return null;
  if (IPV4.test(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts.some((o) => Number.isNaN(o) || o > 255)) return null;
    // Private / loopback / link-local: no point asking, and no point letting a
    // caller probe with them.
    if (
      parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 169 && parts[1] === 254)
    ) return null;
    return ip;
  }
  if (ip.includes(":") && IPV6.test(ip)) {
    if (ip === "::1" || ip.toLowerCase().startsWith("fe80:")) return null;
    return ip;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const ip = validIp(req.headers.get("cf-connecting-ip")) ??
    validIp((req.headers.get("x-forwarded-for") || "").split(",")[0]);

  let ipCountry: string | null = null, ipTz: string | null = null, vpn = false;
  let lat: number | null = null, lon: number | null = null;
  if (ip) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(
        `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
        {
          signal: ctl.signal,
          redirect: "error",
          headers: { "User-Agent": "attention-tracker-geo/1.0" },
        },
      );
      clearTimeout(t);
      if (r.ok) {
        const j = await r.json();
        const cc = String(j && j.country_code || "");
        if (/^[A-Z]{2}$/.test(cc)) ipCountry = cc;
        const tz = String(j && j.timezone || "");
        if (/^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+){1,2}$/.test(tz)) ipTz = tz;
        vpn = VPN_ORG.test(String(j && j.org || ""));
        const la = j && j.latitude != null ? Number(j.latitude) : NaN, lo = j && j.longitude != null ? Number(j.longitude) : NaN;
        if (Number.isFinite(la) && Number.isFinite(lo)) { lat = Math.round(la * 10) / 10; lon = Math.round(lo * 10) / 10; }
      }
    } catch (_e) { /* fall through to null */ }
  }
  const country = ipCountry && vpn ? "XV" : ipCountry;
  return new Response(JSON.stringify({ country, ip_country: ipCountry, ip_tz: ipTz, ip_lat: lat, ip_lon: lon, vpn }), { headers: CORS });
});
