// The read-only API the app calls. Mounted by src/worker.js.
//
//   POST /api/unlock     {code}                 -> sets the access cookie (when APP_PASSCODE is set)
//   GET  /api/session                           -> {locked: bool}
//   GET  /api/arrivals?from&to&office&page      -> {total, rows}  one page of arrivals
//   POST /api/history    {its: ["2030...", ...]} -> {rows}         full history, max 25 ITS
//
// Secrets: NKERP_LOGIN_ID, NKERP_PASSWORD (the NKERP login the app uses) and
// APP_PASSCODE (the code staff type once per device; leave unset to disable the lock).
import { NKERPError, arrivalsPage, history } from "./nkerp.js";

const COOKIE = "kun_access";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

async function sign(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function unlocked(request, env) {
  if (!env.APP_PASSCODE) return true;
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`${COOKIE}=([0-9]+)\\.([0-9a-f]{64})`));
  if (!match || Number(match[1]) < Date.now() / 1000) return false;
  return safeEqual(match[2], await sign(env.APP_PASSCODE, match[1]));
}

export async function api(request, env, url) {
  const path = url.pathname;

  if (path === "/api/unlock" && request.method === "POST") {
    if (!env.APP_PASSCODE) return json({ ok: true });
    const { code = "" } = await request.json().catch(() => ({}));
    if (!safeEqual(String(code).trim(), env.APP_PASSCODE)) {
      return json({ error: "That access code isn't right. Check it and try again." }, 401);
    }
    const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE);
    const value = `${exp}.${await sign(env.APP_PASSCODE, exp)}`;
    return json({ ok: true }, 200, {
      "Set-Cookie": `${COOKIE}=${value}; Max-Age=${MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Strict`,
    });
  }

  if (path === "/api/session") return json({ locked: !(await unlocked(request, env)) });

  if (!(await unlocked(request, env))) return json({ error: "Enter the access code first." }, 401);

  if (path === "/api/arrivals" && request.method === "GET") {
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const office = (url.searchParams.get("office") || "").trim();
    const page = Math.max(1, Math.min(200, Number(url.searchParams.get("page")) || 1));
    if (!DATE.test(from) || !DATE.test(to) || !office) {
      return json({ error: "Choose a from date, a to date and an office." }, 400);
    }
    return json(await arrivalsPage(env, { from, to, office, page }));
  }

  if (path === "/api/history" && request.method === "POST") {
    const { its = [] } = await request.json().catch(() => ({}));
    const list = [...new Set((Array.isArray(its) ? its : []).map((x) => String(x).trim()))]
      .filter((x) => /^\d{5,12}$/.test(x));
    if (!list.length) return json({ rows: [] });
    if (list.length > 25) return json({ error: "Send at most 25 ITS numbers per request." }, 400);
    return json({ rows: await history(env, list) });
  }

  return json({ error: "Not found" }, 404);
}

export { NKERPError };
