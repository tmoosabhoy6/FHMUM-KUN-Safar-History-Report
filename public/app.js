import {
  DEFAULT_MIN_AGE, buildArrivalsReport, buildItsLookup, fmtDay, fmtDt, parseItsList,
} from "./report.js";
import { arrivalsWorkbook, itsWorkbook } from "./excel.js";

const $ = (sel) => document.querySelector(sel);
const BATCH = 25;           // ITS numbers per history request (Worker limit)
const PARALLEL = 3;         // requests in flight at once
const MAX_ITS = 400;
const EXCELJS = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";

// ------------------------------------------------------------------ helpers
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

function star(extra = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  if (extra) svg.setAttribute("class", extra);
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#khatam");
  svg.append(use);
  return svg;
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const weekday = (d) => d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });

class ApiError extends Error {}

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLock(); throw new ApiError(data.error || "Enter the access code first."); }
  if (!res.ok) throw new ApiError(data.error || `The server answered ${res.status}. Try again.`);
  return data;
}

async function pool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }));
  return results;
}

async function fetchHistory(itsList, onProgress) {
  const batches = [];
  for (let i = 0; i < itsList.length; i += BATCH) batches.push(itsList.slice(i, i + BATCH));
  let done = 0;
  const parts = await pool(batches, PARALLEL, async (batch) => {
    const data = await api("/api/history", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ its: batch }),
    });
    done += batch.length;
    onProgress?.(done, itsList.length);
    return data.rows;
  });
  return parts.flat();
}

function setStatus(target, message, fraction = null) {
  target.replaceChildren();
  if (!message) return;
  target.append(el("p", { class: "hint" }, message));
  if (fraction !== null) {
    const bar = el("span");
    target.append(el("div", { class: "progress" }, bar));
    requestAnimationFrame(() => { bar.style.width = `${Math.round(fraction * 100)}%`; });
  }
}

function setError(target, message) {
  target.replaceChildren(el("p", { class: "error" }, message));
}

let excelLoader;
function loadExcel() {
  excelLoader ||= new Promise((resolve, reject) => {
    if (window.ExcelJS) return resolve(window.ExcelJS);
    const s = el("script", { src: EXCELJS });
    s.onload = () => resolve(window.ExcelJS);
    s.onerror = () => { excelLoader = null; reject(new Error("Could not load the Excel writer. Check the connection and try again.")); };
    document.head.append(s);
  });
  return excelLoader;
}

async function download(button, statusTarget, build, filename) {
  button.classList.add("is-busy");
  try {
    const ExcelJS = await loadExcel();
    const buffer = await build(ExcelJS).xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));
    const a = el("a", { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    setError(statusTarget, err.message);
  } finally {
    button.classList.remove("is-busy");
  }
}

// ------------------------------------------------------------------ access lock
const lock = $("#lock");
function showLock() {
  if (!lock.hidden) return;
  lock.hidden = false;
  lock.classList.remove("is-leaving");
  setTimeout(() => $("#lock-code").focus(), 50);
}
$("#lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#lock-err");
  err.textContent = "";
  try {
    const res = await fetch("/api/unlock", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: $("#lock-code").value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "That access code isn't right.");
    lock.classList.add("is-leaving");
    setTimeout(() => { lock.hidden = true; $("#its-input").focus(); }, 500);
  } catch (ex) {
    err.textContent = ex.message;
  }
});
fetch("/api/session").then((r) => r.json()).then((s) => { if (s.locked) showLock(); }).catch(() => {});

// ------------------------------------------------------------------ tabs
const tabs = [...document.querySelectorAll('[role="tab"]')];
const ink = $(".modes__ink");
function moveInk(tab) {
  ink.style.width = `${tab.offsetWidth - 24}px`;
  ink.style.transform = `translateX(${tab.offsetLeft + 12}px)`;
}
function select(tab, focus = false) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", on);
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
  }
  moveInk(tab);
  if (focus) tab.focus();
  history.replaceState(null, "", tab.id === "tab-arrivals" ? "#arrivals" : "#its");
}
tabs.forEach((tab, i) => {
  tab.addEventListener("click", () => select(tab));
  tab.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      select(tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length], true);
    }
  });
});
addEventListener("resize", () => moveInk(tabs.find((t) => t.getAttribute("aria-selected") === "true")));
document.fonts?.ready.then(() => select(location.hash === "#arrivals" ? tabs[1] : tabs[0]));
select(location.hash === "#arrivals" ? tabs[1] : tabs[0]);

// ------------------------------------------------------------------ ITS chips
const chipList = $("#chips");
const input = $("#its-input");
let itsList = [];
const chipState = new Map(); // its -> "found" | "missing"

function renderChips() {
  chipList.replaceChildren(...itsList.map((its) => {
    const state = chipState.get(its);
    const remove = el("button", { type: "button", "aria-label": `Remove ${its}` }, "×");
    remove.addEventListener("click", () => {
      itsList = itsList.filter((x) => x !== its);
      renderChips();
      input.focus();
    });
    return el("li", { class: `chip${state ? ` is-${state}` : ""}` }, its, remove);
  }));
  const n = itsList.length;
  const ready = $("#ready");
  ready.replaceChildren();
  if (n) ready.append(el("b", {}, n.toLocaleString()), ` ITS ${n === 1 ? "number" : "numbers"} ready to search`);
  else ready.textContent = "Add at least one ITS number.";
  $("#its-search").disabled = !n;
  $("#its-search").textContent = n > 1 ? `Search all ${n}` : "Search";
  $("#its-clear").hidden = !n;
}

function shake() {
  const f = $("#chipfield");
  f.classList.remove("is-shaking");
  void f.offsetWidth;
  f.classList.add("is-shaking");
}

function addFrom(text) {
  const { its, ignored } = parseItsList(text);
  const fresh = its.filter((x) => !itsList.includes(x));
  if (itsList.length + fresh.length > MAX_ITS) {
    setError($("#its-status"), `Search up to ${MAX_ITS} ITS numbers at a time. Split the list and run it in parts.`);
    return 0;
  }
  if (!its.length && String(text).trim()) shake();
  itsList.push(...fresh);
  renderChips();
  if (ignored.length) {
    setStatus($("#its-status"), `Skipped ${ignored.join(", ")}: ITS numbers have 5 to 12 digits.`);
  }
  return fresh.length;
}

input.addEventListener("keydown", (e) => {
  if (["Enter", ",", " ", ".", ";", "Tab"].includes(e.key) && input.value.trim()) {
    e.preventDefault();
    addFrom(input.value);
    input.value = "";
  } else if (e.key === "Enter" && !input.value.trim() && itsList.length) {
    e.preventDefault();
    $("#its-form").requestSubmit();
  } else if (e.key === "Backspace" && !input.value && itsList.length) {
    itsList.pop();
    renderChips();
  }
});
input.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text") || "";
  if (/\D/.test(text.trim())) {
    e.preventDefault();
    addFrom(text);
  }
});
input.addEventListener("blur", () => { if (input.value.trim()) { addFrom(input.value); input.value = ""; } });
$("#chipfield").addEventListener("click", (e) => { if (e.target === e.currentTarget) input.focus(); });
$("#its-clear").addEventListener("click", () => {
  itsList = [];
  chipState.clear();
  renderChips();
  input.focus();
});

// paste area
const pasteToggle = $("#paste-toggle"), pasteBody = $("#paste-body"), pasteText = $("#paste-text");
pasteToggle.addEventListener("click", () => {
  const open = pasteToggle.getAttribute("aria-expanded") !== "true";
  pasteToggle.setAttribute("aria-expanded", open);
  pasteBody.hidden = !open;
  if (open) pasteText.focus();
});
pasteText.addEventListener("input", () => {
  const { its } = parseItsList(pasteText.value);
  const fresh = its.filter((x) => !itsList.includes(x)).length;
  $("#paste-count").textContent = its.length
    ? `Found ${plural(its.length, "ITS number")}${fresh < its.length ? `, ${fresh} new` : ""}.`
    : "No ITS numbers found yet.";
  $("#paste-add").disabled = !fresh;
  $("#paste-add").textContent = fresh ? `Add ${fresh} to the list` : "Add to list";
});
$("#paste-add").addEventListener("click", () => {
  addFrom(pasteText.value);
  pasteText.value = "";
  pasteText.dispatchEvent(new Event("input"));
  input.focus();
});

// ------------------------------------------------------------------ ITS search
let lastLookup = null;

$("#its-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (input.value.trim()) { addFrom(input.value); input.value = ""; }
  if (!itsList.length) return shake();
  const button = $("#its-search"), status = $("#its-status");
  const list = [...itsList];
  button.classList.add("is-busy");
  button.disabled = true;
  setStatus(status, `Looking up ${plural(list.length, "ITS number")} in NKERP…`, 0.05);
  try {
    const rows = await fetchHistory(list, (done, total) =>
      setStatus(status, `Looked up ${done} of ${total}…`, done / total));
    lastLookup = buildItsLookup(list, rows);
    chipState.clear();
    for (const p of lastLookup.people) chipState.set(p.its, p.found ? "found" : "missing");
    renderChips();
    setStatus(status, "");
    renderLedger(lastLookup);
  } catch (err) {
    setError(status, err.message);
  } finally {
    button.classList.remove("is-busy");
    button.disabled = !itsList.length;
  }
});

function timeline(people) {
  const years = people.flatMap((p) => (p.trips || []).map((t) => t.arrival.getUTCFullYear()));
  const now = new Date().getUTCFullYear();
  const start = Math.min(2016, ...years);
  const end = Math.max(now, ...years) + 1;
  return { start: Date.UTC(start, 0, 1), end: Date.UTC(end, 0, 1), first: start, last: end };
}

function renderLedger(lookup) {
  const results = $("#its-results");
  results.hidden = false;
  const missing = lookup.searched - lookup.found;
  $("#its-summary").replaceChildren(
    el("b", {}, lookup.found.toLocaleString()), ` of ${plural(lookup.searched, "ITS number")} found`,
    missing ? `, ${missing} not in NKERP` : "",
  );
  const range = timeline(lookup.people.filter((p) => p.found));
  const tpl = $("#tpl-person");
  const items = lookup.people.map((p, i) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.style.setProperty("--i", Math.min(i, 12));
    node.querySelector(".person__its").textContent = `ITS ${p.its}`;
    if (!p.found) {
      node.classList.add("is-missing");
      node.querySelector(".person__name").textContent = "Not found in NKERP";
      node.querySelector(".person__recent").textContent = "Check the number. No tour in NKERP lists this ITS.";
      node.querySelector(".person__tally").remove();
      node.querySelector(".thread").remove();
      node.querySelector(".person__more").remove();
      return node;
    }
    node.querySelector(".person__name").textContent = p.name;
    const recent = node.querySelector(".person__recent");
    if (p.mostRecent) {
      recent.append("Most recent trip ", el("strong", {}, fmtDay(p.mostRecent.arrival)), ` with ${p.mostRecent.office}`);
    } else {
      recent.append("No trip completed yet");
    }
    if (p.next) recent.append(el("br"), "Booked next: ", el("strong", {}, fmtDay(p.next.arrival)), ` with ${p.next.office}`);

    const stars = node.querySelector(".stars");
    const shown = Math.min(p.total, 24);
    const ordered = [...p.trips].sort((a, b) => a.arrival - b.arrival);
    ordered.slice(0, shown).forEach((t, s) => {
      const svg = star(p.upcoming.includes(t) ? "is-ahead" : "");
      svg.style.setProperty("--s", s);
      stars.append(svg);
    });
    if (p.total > shown) stars.append(el("span", { class: "more" }, `+${p.total - shown}`));
    node.querySelector(".count b").textContent = p.total;
    node.querySelector(".count small").textContent = p.total === 1 ? "visit" : "visits";

    const thread = node.querySelector(".thread");
    const span = range.end - range.start;
    const step = range.last - range.first > 10 ? 2 : 1;
    for (let y = range.first; y <= range.last; y += step) {
      const x = ((Date.UTC(y, 0, 1) - range.start) / span) * 100;
      if (x > 97) continue;
      thread.append(el("span", { class: "thread__year", style: `left:${x}%` }, String(y)));
    }
    ordered.forEach((t, s) => {
      const x = ((t.arrival.getTime() - range.start) / span) * 100;
      const cls = ["thread__dot", t === p.mostRecent && "is-recent", p.upcoming.includes(t) && "is-ahead"].filter(Boolean).join(" ");
      thread.append(el("span", { class: cls, style: `left:${x}%;--s:${s}`, title: `${fmtDay(t.arrival)} ${t.office}` }));
    });

    const more = node.querySelector(".person__more");
    const box = node.querySelector(".person__trips");
    more.textContent = `Show ${plural(p.all.length, "trip")}`;
    more.addEventListener("click", () => {
      const open = more.getAttribute("aria-expanded") !== "true";
      more.setAttribute("aria-expanded", open);
      more.textContent = open ? "Hide trips" : `Show ${plural(p.all.length, "trip")}`;
      if (open && !box.firstChild) box.append(tripsTable(p));
      box.hidden = !open;
    });
    return node;
  });
  $("#ledger").replaceChildren(...items);
  results.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

function tripsTable(p) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = p.all.map((t) => {
    const ahead = t.counted && t.arrival.toISOString().slice(0, 10) > today;
    return el("tr", { class: !t.counted ? "is-void" : ahead ? "is-ahead" : "" },
      el("td", {}, fmtDay(t.arrival)), el("td", {}, t.reference), el("td", {}, t.office),
      el("td", {}, t.package || ""),
      el("td", {}, [t.flights.arrCode, t.flights.depCode].filter(Boolean).join(" / ")),
      el("td", {}, !t.counted ? `Not counted: ${t.reason}` : ahead ? "Booked" : t.status));
  });
  return el("div", { class: "wide" }, el("table", { class: "trips" },
    el("thead", {}, el("tr", {}, ["Arrival", "Tour", "Office", "Package", "Flights", "Status"].map((h) => el("th", {}, h)))),
    el("tbody", {}, rows)));
}

$("#its-download").addEventListener("click", (e) => {
  if (!lastLookup) return;
  const stamp = new Date().toISOString().slice(0, 10);
  download(e.currentTarget, $("#its-status"), (X) => itsWorkbook(X, lastLookup), `its-lookup_${stamp}.xlsx`);
});

// ------------------------------------------------------------------ arrivals report
const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
$("#arr-from").value = iso(today);
$("#arr-to").value = iso(new Date(today.getTime() + 6 * 86400000));
let lastReport = null;

$("#arr-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const from = $("#arr-from").value, to = $("#arr-to").value;
  const office = $("#arr-office").value.trim();
  const minAge = Number($("#arr-age").value || DEFAULT_MIN_AGE);
  const status = $("#arr-status"), button = $("#arr-run");
  if (to < from) return setError(status, "The end date is before the start date. Swap them and try again.");
  if ((new Date(to) - new Date(from)) / 86400000 > 62) return setError(status, "Choose at most two months at a time.");
  button.classList.add("is-busy");
  button.disabled = true;
  try {
    setStatus(status, `Reading ${office} arrivals from NKERP…`, 0.04);
    const q = (page) => api(`/api/arrivals?${new URLSearchParams({ from, to, office, page })}`);
    const first = await q(1);
    const pages = Math.ceil(first.total / Math.max(first.rows.length, 1));
    const rest = pages > 1
      ? await pool(Array.from({ length: pages - 1 }, (_, i) => i + 2), PARALLEL, async (p) => (await q(p)).rows)
      : [];
    const rows = [...first.rows, ...rest.flat()];
    const ids = [...new Set(rows.filter((r) => !r.IsInfant && /^\d+$/.test(String(r.ITSID || "").trim()))
      .map((r) => String(r.ITSID).trim()))];
    setStatus(status, `Found ${plural(rows.length, "passenger")}. Looking up past trips…`, 0.15);
    const history = await fetchHistory(ids, (done, total) =>
      setStatus(status, `Past trips: ${done} of ${total} ITS looked up…`, 0.15 + 0.85 * (done / total)));
    lastReport = buildArrivalsReport(rows, history, { from, to, office, minAge });
    setStatus(status, "");
    renderArrivals(lastReport);
  } catch (err) {
    setError(status, err.message);
  } finally {
    button.classList.remove("is-busy");
    button.disabled = false;
  }
});

function renderArrivals(report) {
  const results = $("#arr-results");
  results.hidden = false;
  $("#arr-summary").replaceChildren(
    el("b", {}, report.peopleCount.toLocaleString()),
    ` adults on ${plural(report.tourCount, "tour")}, arriving ${fmtDay(new Date(report.from))} to ${fmtDay(new Date(report.to))}`,
  );
  const days = report.days.map((day) => el("section", { class: "day" },
    el("div", { class: "day__head" },
      el("h2", { class: "day__date" }, fmtDay(day.day).slice(0, 6)),
      el("span", { class: "day__weekday" }, `${weekday(day.day)} ${day.day.getUTCFullYear()}`)),
    day.tours.map(tourCard)));
  if (!days.length) days.push(el("p", { class: "hint", style: "margin-top:24px" }, "No adults from this office arrive in these dates. Try a wider range."));
  $("#arr-days").replaceChildren(...days);
  results.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

function flightChip(label, code, time) {
  return el("span", { class: "flight" }, el("span", {}, label), code || "No flight", time ? ` ${fmtDt(time)}` : "");
}

function personRow(p) {
  return el("tr", {},
    el("td", {}, p.its),
    el("td", {}, p.name),
    el("td", { class: `n${p.total === 1 ? " is-first" : ""}` }, String(p.total)),
    el("td", { class: "recent" }, p.mostRecent ? fmtDay(p.mostRecent.arrival) : "First visit"),
    el("td", { class: "earlier" }, earlierText(p.earlier)),
    el("td", { class: "notes" }, p.notes.filter((n) => !n.startsWith("Most recent")).join(". ")));
}

function tourCard(tour) {
  const head = el("header", { class: "tour__head" },
    el("span", { class: "tour__no" }, String(tour.number)),
    flightChip("Arrives", tour.flights.arrCode, tour.flights.arrTime),
    flightChip("Departs", tour.flights.depCode, tour.flights.depTime),
    el("span", { class: "tour__meta" },
      `${tour.reference}${tour.package ? `, ${tour.package}` : ""}, ${plural(tour.people.length, "adult")}`));
  const headings = ["ITS", "Name", "Visits", "Most recent trip", "Earlier trips", "Notes"].map((h) => el("th", {}, h));
  const table = el("table", {}, el("thead", {}, el("tr", {}, headings)), el("tbody", {}, tour.people.map(personRow)));
  return el("article", { class: "tour" }, head, el("div", { class: "wide" }, table));
}

function earlierText(list) {
  if (!list.length) return "";
  const shown = list.slice(0, 4).map((t) => fmtDay(t.arrival)).join(", ");
  return list.length > 4 ? `${shown} and ${list.length - 4} more` : shown;
}

$("#arr-download").addEventListener("click", (e) => {
  if (!lastReport) return;
  download(e.currentTarget, $("#arr-status"), (X) => arrivalsWorkbook(X, lastReport),
    `kun-safar-arrivals_${lastReport.from}_to_${lastReport.to}.xlsx`);
});

renderChips();
