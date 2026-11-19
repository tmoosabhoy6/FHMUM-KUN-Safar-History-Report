// Read-only NKERP client for Cloudflare Workers.
//
// Only two endpoints are ever called; anything else throws before a request is made:
//   POST api/accounts/Login                 start a session (cookies)
//   POST api/tours/GeneralSearchPassengers  NKERP's General Search > Passengers list
//
// GeneralSearchPassengers returns one row per person per tour (ITS, date of birth, office,
// package, tour reference, arrival/departure, flight codes and times). Filtered by
// ArrivalFrom/ArrivalTo/OfficeName it gives arrivals; filtered by ITSIds (newline separated -
// commas return nothing) with a wide arrival range it gives each ITS's full tour history.

const BASE = "https://to.najafkarbala.com/NKERPApi/";
const ORIGIN = "https://to.najafkarbala.com";
export const LOGIN = "api/accounts/Login";
export const SEARCH = "api/tours/GeneralSearchPassengers";
const ALLOWED = new Set([LOGIN, SEARCH]);
const HISTORY_FROM = "2000-01-01";
const HISTORY_TO = "2100-12-31";

// Only these fields leave the Worker (no passport numbers, addresses or phone numbers).
const KEEP = [
  "Id", "ITSID", "TourId", "ReferenceNo", "StartDate", "EndDate", "OfficeName", "TOName",
  "DateOfBirth", "Age", "IsInfant", "Gender", "ApplicantName", "Status", "IsActive",
  "IsCancellation", "IsApplicantActive", "PackageName", "EntryPort", "ExitPort",
  "ArrivalCode", "FlightArrivalTime", "DepartureCode", "FlightDepartureTime",
];

export class NKERPError extends Error {}

export function trim(row) {
  const out = {};
  for (const key of KEEP) out[key] = row[key] ?? null;
  return out;
}

// One session per Worker isolate, reused across requests until NKERP rejects it.
let session = null;

function setCookies(response) {
  const headers = response.headers;
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie()
    : typeof headers.getAll === "function" ? headers.getAll("Set-Cookie") : [];
  return list.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

async function call(path, body, cookie, fetchImpl) {
  if (!ALLOWED.has(path)) throw new NKERPError(`${path} is not on the read-only allowlist`);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(BASE + path, {
        method: "POST",
        headers: {
          Accept: "application/json", "Content-Type": "application/json",
          Origin: ORIGIN, Referer: ORIGIN + "/", ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(body),
      });
      return response;
    } catch (err) {
      lastError = err; // network hiccup: both endpoints are reads, so retrying is safe
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw new NKERPError(`Could not reach NKERP (${lastError?.message || "network error"})`);
}

async function login(env, fetchImpl) {
  if (!env.NKERP_LOGIN_ID || !env.NKERP_PASSWORD) {
    throw new NKERPError("The NKERP login is not configured on the server");
  }
  const response = await call(LOGIN, {
    LocalUTCTime: new Date().toISOString(),
    LoginId: String(env.NKERP_LOGIN_ID).trim(),
    Password: env.NKERP_PASSWORD,
  }, null, fetchImpl);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ReturnStatus || !data.IsAuthenicated) {
    throw new NKERPError("NKERP rejected the saved login - update the NKERP_LOGIN_ID / NKERP_PASSWORD secrets");
  }
  session = { cookie: setCookies(response), at: Date.now() };
  return session;
}

export function resetSession() {
  session = null;
}

// One page of GeneralSearchPassengers, trimmed. Re-logs in once if the session expired.
export async function searchPage(env, filters, page, pageSize, fetchImpl = fetch) {
  if (!session) await login(env, fetchImpl);
  const body = {
    IsPaging: true, clientTimeZoneOffset: -180, sortBy: "StartDateTimeZone",
    currentPage: page, itemsPerPage: pageSize, maxSize: 10, totalItems: 0, reverse: false,
    ...filters,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await call(SEARCH, body, session.cookie, fetchImpl);
    if (response.status === 401 && attempt === 0) {
      await login(env, fetchImpl);
      continue;
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.IsError || data.ReturnStatus === false) {
      const msg = (data?.ReturnMessage || []).join(" ");
      throw new NKERPError(`NKERP passenger search failed (HTTP ${response.status}) ${msg}`.trim());
    }
    return {
      total: Number(data.TotalRows || 0),
      rows: (data.lstGeneralSearchPassengersDTO || []).map(trim),
    };
  }
  throw new NKERPError("NKERP session could not be renewed");
}

export async function arrivalsPage(env, { from, to, office, page, pageSize = 60 }, fetchImpl) {
  return searchPage(env, { ArrivalFrom: from, ArrivalTo: to, OfficeName: office }, page, pageSize, fetchImpl);
}

// Full history for a small batch of ITS numbers (any office).
export async function history(env, itsList, fetchImpl) {
  const filters = { ITSIds: itsList.join("\n"), ArrivalFrom: HISTORY_FROM, ArrivalTo: HISTORY_TO };
  const rows = [];
  let total = Infinity;
  for (let page = 1; rows.length < total && page <= 20; page++) {
    const result = await searchPage(env, filters, page, 500, fetchImpl);
    total = result.total;
    if (!result.rows.length) break;
    rows.push(...result.rows);
  }
  const wanted = new Set(itsList);
  const found = new Set(rows.map((r) => String(r.ITSID || "").trim()));
  // A batch lookup that returns nothing for an ITS gets one solo retry.
  for (const its of itsList) {
    if (found.has(its) || itsList.length === 1) continue;
    const solo = await searchPage(env, { ...filters, ITSIds: its }, 1, 500, fetchImpl);
    rows.push(...solo.rows);
  }
  return rows.filter((r) => wanted.has(String(r.ITSID || "").trim()));
}
