// Report logic shared by the browser app and the tests. No DOM, no network.
//
// Arrivals report rules
//  * tour Office Name must equal the chosen office; tour arrival inside the date range
//  * person really on the tour: tour active, not cancelled/deleted, applicant active
//  * adults only: age on the tour's arrival date >= minimum age; infants always excluded
//  * previous trips = every other valid NKERP tour of the same ITS (any office) that arrived
//    before this one; deleted / cancelled tours and tours the person was removed from don't count
//  * times visited = previous trips + this one
//
// ITS lookup rules (any office)
//  * trips = every valid tour of the ITS; times visited counts all of them, booked ones included
//  * most recent trip = latest trip that has already arrived; next trip = the first one still ahead

export const DEFAULT_OFFICE = "Fayz E Husayni Trust Mumbai";
export const DEFAULT_MIN_AGE = 18;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ------------------------------------------------------------------ parsing helpers
// NKERP timestamps are local (Iraq) wall-clock times with no zone. They are kept as
// "naive" Date objects built from their parts in UTC, so no browser time zone shifts them.
export function parseDt(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m || m[1] === "0001") return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
}

export const dayKey = (d) => (d ? d.toISOString().slice(0, 10) : "");
export const dayOnly = (d) => (d ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : null);
const pad = (n) => String(n).padStart(2, "0");
export const fmtDay = (d) => (d ? `${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}` : "");
export const fmtDt = (d) => (d ? `${fmtDay(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : "");
export const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

export function ageOn(dob, day) {
  if (!dob || !day) return null;
  let age = day.getUTCFullYear() - dob.getUTCFullYear();
  if (day.getUTCMonth() < dob.getUTCMonth() ||
      (day.getUTCMonth() === dob.getUTCMonth() && day.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

export function tourNumber(reference) {
  const tail = String(reference || "").replace(/\/+$/, "").split("/").pop();
  return /^\d+$/.test(tail) ? Number(tail) : String(reference || "");
}

export function isOnTour(row) {
  return row.IsActive !== false && !row.IsCancellation && row.IsApplicantActive !== false &&
    clean(row.Status).toLowerCase() !== "deleted";
}

export function whyNotCounted(row) {
  if (clean(row.Status).toLowerCase() === "deleted" || row.IsActive === false) return "tour deleted";
  if (row.IsCancellation) return "tour cancelled";
  if (row.IsApplicantActive === false) return "removed from tour";
  return "not counted";
}

const flightsOf = (row) => ({
  arrCode: clean(row.ArrivalCode), arrTime: parseDt(row.FlightArrivalTime),
  depCode: clean(row.DepartureCode), depTime: parseDt(row.FlightDepartureTime),
});
const flightKey = (f) => [f.arrCode, fmtDt(f.arrTime), f.depCode, fmtDt(f.depTime)].join("|");

export function flightText(f) {
  const arr = `Arr ${f.arrCode || "—"}${f.arrTime ? ` ${fmtDt(f.arrTime)}` : ""}`;
  const dep = `Dep ${f.depCode || "—"}${f.depTime ? ` ${fmtDt(f.depTime)}` : ""}`;
  return `${arr}   |   ${dep}`;
}

/** Split pasted text into ITS numbers: any run of 5–12 digits, separated by anything at all. */
export function parseItsList(text) {
  const found = String(text || "").match(/\d+/g) || [];
  const its = [], ignored = [], seen = new Set();
  for (const token of found) {
    if (token.length < 5 || token.length > 12) { ignored.push(token); continue; }
    if (!seen.has(token)) { seen.add(token); its.push(token); }
  }
  return { its, ignored };
}

function toTrip(row) {
  return {
    tourId: row.TourId, reference: clean(row.ReferenceNo), arrival: parseDt(row.StartDate),
    departure: parseDt(row.EndDate), office: clean(row.OfficeName), package: clean(row.PackageName),
    status: clean(row.Status), flights: flightsOf(row), counted: isOnTour(row),
    reason: isOnTour(row) ? "" : whyNotCounted(row),
  };
}

// ------------------------------------------------------------------ arrivals report
export function buildArrivalsReport(arrivalRows, historyRows, opts) {
  const { from, to, office = DEFAULT_OFFICE, minAge = DEFAULT_MIN_AGE } = opts;
  const fromKey = String(from), toKey = String(to);
  const officeKey = clean(office).toLowerCase();
  const skipped = {};
  const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };
  const byIts = groupHistory(historyRows);
  const tours = new Map();
  const tourRows = new Map();
  const seen = new Set();

  for (const row of arrivalRows) {
    const arrival = parseDt(row.StartDate);
    if (clean(row.OfficeName).toLowerCase() !== officeKey) { skip("other office"); continue; }
    if (!arrival || dayKey(arrival) < fromKey || dayKey(arrival) > toKey) { skip("arrival outside range"); continue; }
    if (!isOnTour(row)) { skip("cancelled or removed"); continue; }
    if (!tours.has(row.TourId)) {
      tours.set(row.TourId, {
        tourId: row.TourId, reference: clean(row.ReferenceNo), number: tourNumber(row.ReferenceNo),
        arrival, departure: parseDt(row.EndDate), package: clean(row.PackageName), people: [],
      });
      tourRows.set(row.TourId, []);
    }
    tourRows.get(row.TourId).push(row);
    if (row.IsInfant) { skip("infant"); continue; }
    let age = ageOn(parseDt(row.DateOfBirth), dayOnly(arrival));
    if (age === null && Number.isInteger(row.Age)) age = row.Age;
    if (age === null) { skip("no date of birth"); continue; }
    if (age < minAge) { skip(`under ${minAge}`); continue; }
    const its = clean(row.ITSID);
    const key = `${row.TourId}|${its}`;
    if (/^\d+$/.test(its) && seen.has(key)) { skip("duplicate row"); continue; }
    seen.add(key);
    tours.get(row.TourId).people.push({
      its, name: clean(row.ApplicantName), age, gender: clean(row.Gender),
      flights: flightsOf(row), package: clean(row.PackageName),
    });
  }

  for (const [tourId, tour] of tours) {
    const counts = new Map();
    for (const r of tourRows.get(tourId)) {
      const f = flightsOf(r), k = flightKey(f);
      counts.set(k, { f, n: (counts.get(k)?.n || 0) + 1 });
    }
    tour.flights = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.f ||
      { arrCode: "", arrTime: null, depCode: "", depTime: null };
    tour.flightDetails = flightText(tour.flights);
    for (const person of tour.people) fillArrivalHistory(person, tour, byIts);
    tour.people.sort((a, b) => (/^\d+$/.test(b.its) - /^\d+$/.test(a.its)) || a.its.localeCompare(b.its));
  }

  const days = new Map();
  for (const tour of tours.values()) {
    if (!tour.people.length) { skip("tours with no adults"); continue; }
    const key = dayKey(tour.arrival);
    if (!days.has(key)) days.set(key, { day: dayOnly(tour.arrival), key, tours: [] });
    days.get(key).tours.push(tour);
  }
  const ordered = [...days.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const d of ordered) d.tours.sort((a, b) => a.arrival - b.arrival || a.reference.localeCompare(b.reference));
  const people = ordered.flatMap((d) => d.tours.flatMap((t) => t.people));
  return {
    kind: "arrivals", office, from: fromKey, to: toKey, minAge, days: ordered, skipped,
    tourCount: ordered.reduce((n, d) => n + d.tours.length, 0), peopleCount: people.length,
    maxEarlier: Math.max(0, ...people.map((p) => Math.max(0, p.previous.length - 1))),
    generatedAt: new Date(),
  };
}

function groupHistory(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const its = clean(r.ITSID);
    if (!map.has(its)) map.set(its, []);
    map.get(its).push(r);
  }
  return map;
}

function fillArrivalHistory(person, tour, byIts) {
  const notes = [];
  if (person.package) notes.push(`Package: ${person.package}`);
  if (flightKey(person.flights) !== flightKey(tour.flights)) notes.push(`Own flights: ${flightText(person.flights)}`);
  person.previous = [];
  person.notes = notes;
  if (!/^\d+$/.test(person.its)) {
    notes.push("No ITS number in NKERP, so past trips could not be looked up");
    person.total = 1;
    person.mostRecent = null;
    person.earlier = [];
    return;
  }
  const previous = new Map(), notCounted = new Set(), later = new Set();
  for (const row of byIts.get(person.its) || []) {
    if (row.TourId === tour.tourId) continue;
    const trip = toTrip(row);
    if (!trip.arrival) continue;
    if (trip.arrival >= tour.arrival) {
      if (trip.counted) later.add(`${trip.reference} (${fmtDay(trip.arrival)})`);
      continue;
    }
    if (!trip.counted) { notCounted.add(`${trip.reference} (${fmtDay(trip.arrival)}, ${trip.reason})`); continue; }
    if (!previous.has(trip.tourId)) previous.set(trip.tourId, trip);
  }
  // newest first: the most recent trip comes straight after the visit count
  person.previous = [...previous.values()].sort((a, b) => b.arrival - a.arrival);
  person.mostRecent = person.previous[0] || null;
  person.earlier = person.previous.slice(1);
  person.total = person.previous.length + 1;
  if (person.mostRecent) {
    const m = person.mostRecent;
    notes.push(`Most recent: ${m.reference}, ${m.office}${m.package ? `, package ${m.package}` : ""}`);
  }
  const packaged = person.previous.filter((t) => t.package).map((t) => `${fmtDay(t.arrival)} via ${t.package}`);
  if (packaged.length) notes.push(`Past packages: ${packaged.join("; ")}`);
  if (notCounted.size) notes.push(`Not counted: ${[...notCounted].sort().join("; ")}`);
  if (later.size) notes.push(`Also booked later: ${[...later].sort().join("; ")}`);
}

// ------------------------------------------------------------------ ITS lookup
export function buildItsLookup(itsList, historyRows, today = new Date()) {
  const byIts = groupHistory(historyRows);
  const todayKey = today.toISOString().slice(0, 10);
  const people = itsList.map((its) => {
    const rows = byIts.get(its) || [];
    if (!rows.length) return { its, found: false, name: "", trips: [], total: 0, notes: ["Not found in NKERP"] };
    const unique = new Map();
    for (const row of rows) {
      const trip = toTrip(row);
      if (!trip.arrival) continue;
      const prev = unique.get(trip.tourId);
      if (!prev || (!prev.counted && trip.counted)) unique.set(trip.tourId, trip);
    }
    const all = [...unique.values()].sort((a, b) => b.arrival - a.arrival);
    const trips = all.filter((t) => t.counted);
    const past = trips.filter((t) => dayKey(t.arrival) <= todayKey);
    const ahead = trips.filter((t) => dayKey(t.arrival) > todayKey).sort((a, b) => a.arrival - b.arrival);
    const latestRow = rows.slice().sort((a, b) => (parseDt(b.StartDate) || 0) - (parseDt(a.StartDate) || 0))[0];
    const notes = [];
    const skipped = all.filter((t) => !t.counted);
    if (skipped.length) notes.push(`Not counted: ${skipped.map((t) => `${t.reference} (${fmtDay(t.arrival)}, ${t.reason})`).join("; ")}`);
    const packaged = trips.filter((t) => t.package).map((t) => `${fmtDay(t.arrival)} via ${t.package}`);
    if (packaged.length) notes.push(`Packages: ${packaged.join("; ")}`);
    return {
      its, found: true, name: clean(latestRow.ApplicantName), gender: clean(latestRow.Gender),
      dob: parseDt(latestRow.DateOfBirth), trips, all, total: trips.length,
      mostRecent: past[0] || null, earlier: past.slice(1), next: ahead[0] || null, upcoming: ahead, notes,
    };
  });
  return {
    kind: "its", people, generatedAt: new Date(), searched: itsList.length,
    found: people.filter((p) => p.found).length,
    maxEarlier: Math.max(0, ...people.map((p) => (p.earlier || []).length)),
  };
}
