import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { buildArrivalsReport, buildItsLookup, parseItsList, tourNumber } from "../public/report.js";
import { arrivalsWorkbook, itsWorkbook } from "../public/excel.js";
import { history, resetSession, trim } from "../src/nkerp.js";
import { api } from "../src/api.js";

const OFFICE = "Fayz E Husayni Trust Mumbai";
let nextId = 1;
function row(its, tourId, ref, start, o = {}) {
  return {
    Id: nextId++, ITSID: its, TourId: tourId, ReferenceNo: ref, StartDate: start, EndDate: "2026-12-10T19:00:00",
    OfficeName: o.office ?? OFFICE, DateOfBirth: o.dob ?? "1960-01-01", Age: null, IsInfant: !!o.infant,
    Status: o.status ?? "Approved", IsActive: o.active ?? true, IsCancellation: !!o.cancelled,
    IsApplicantActive: o.applicantActive ?? true, PackageName: o.package ?? null,
    ArrivalCode: o.arr?.[0] ?? "IA 442", FlightArrivalTime: o.arr?.[1] ?? "2026-12-01T07:00:00",
    DepartureCode: "IA 441", FlightDepartureTime: "2026-12-10T21:30:00", ApplicantName: o.name ?? `Person ${its}`, Gender: "Male",
  };
}
const current = (its, o) => row(its, 1, "NKERP/TOUR/2026/2696", "2026-12-01T11:00:00", o);
const opts = { from: "2026-12-01", to: "2026-12-07", office: OFFICE, minAge: 18 };

test("pasted text splits on any separator", () => {
  const { its, ignored } = parseItsList("Salaam! ITS: 20359107, 20301083.30303088\n40449375; 20359107 and 12 abc 123");
  assert.deepEqual(its, ["20359107", "20301083", "30303088", "40449375"]);
  assert.deepEqual(ignored, ["12", "123"]);
});

test("arrivals: count, most recent first, then older trips", () => {
  const history = [
    current("20359107"),
    row("20359107", 8, "NKERP/TOUR/2019/5", "2019-02-12T11:00:00", { package: "Permanent KUN Safar 1440" }),
    row("20359107", 9, "NKERP/TOUR/2024/10", "2024-05-05T11:00:00", { office: "Office Tours", status: "NA" }),
  ];
  const r = buildArrivalsReport([current("20359107")], history, opts);
  const p = r.days[0].tours[0].people[0];
  assert.equal(p.total, 3);
  assert.equal(p.mostRecent.reference, "NKERP/TOUR/2024/10");
  assert.deepEqual(p.earlier.map((t) => t.reference), ["NKERP/TOUR/2019/5"]);
  assert.ok(p.notes.includes("Past packages: 12-Feb-2019 via Permanent KUN Safar 1440"));
  assert.equal(r.maxEarlier, 1);
});

test("arrivals: deleted, cancelled, removed and later trips are not counted", () => {
  const history = [
    row("1", 2, "R/2020/1", "2020-01-01T00:00:00", { status: "Deleted", active: false }),
    row("1", 3, "R/2021/1", "2021-01-01T00:00:00", { cancelled: true }),
    row("1", 4, "R/2022/1", "2022-01-01T00:00:00", { applicantActive: false }),
    row("1", 5, "R/2027/1", "2027-01-01T00:00:00"),
  ];
  const p = buildArrivalsReport([current("1")], history, opts).days[0].tours[0].people[0];
  assert.equal(p.total, 1);
  const notes = p.notes.join("\n");
  assert.match(notes, /R\/2020\/1 \(01-Jan-2020, tour deleted\)/);
  assert.match(notes, /R\/2021\/1 \(01-Jan-2021, tour cancelled\)/);
  assert.match(notes, /R\/2022\/1 \(01-Jan-2022, removed from tour\)/);
  assert.match(notes, /Also booked later: R\/2027\/1/);
});

test("arrivals: only adults of the office who are on the tour", () => {
  const rows = [
    current("1", { dob: "2008-12-01" }), current("2", { dob: "2008-12-02" }),
    current("3", { infant: true, dob: "2026-01-01" }), current("4", { applicantActive: false }),
    row("5", 7, "R/2026/7", "2026-12-02T11:00:00", { office: "Hakimi Tours And Travels" }),
    row("6", 8, "R/2026/8", "2026-12-09T11:00:00"),
  ];
  const r = buildArrivalsReport(rows, [], opts);
  assert.deepEqual(r.days.flatMap((d) => d.tours.flatMap((t) => t.people.map((p) => p.its))), ["1"]);
  assert.equal(r.skipped["under 18"], 1);
  assert.equal(r.skipped.infant, 1);
});

test("arrivals: tour flights are the majority, others get a note", () => {
  const rows = [current("1"), current("2"), current("3", { arr: ["FZ 221", "2026-12-01T15:05:00"] })];
  const tour = buildArrivalsReport(rows, [], opts).days[0].tours[0];
  assert.equal(tour.flightDetails, "Arr IA 442 01-Dec-2026 07:00   |   Dep IA 441 10-Dec-2026 21:30");
  assert.ok(tour.people.find((p) => p.its === "3").notes.some((n) => n.startsWith("Own flights: Arr FZ 221")));
  assert.equal(tourNumber(tour.reference), 2696);
});

test("ITS lookup: any office, most recent, next booking, not found", () => {
  const today = new Date("2026-11-19T00:00:00Z");
  const rows = [
    row("100", 1, "R/2017/1", "2017-07-09T00:00:00", { office: "Office Tours", status: "NA" }),
    row("100", 2, "R/2024/1", "2024-12-03T00:00:00", { office: "Shahi" }),
    row("100", 3, "R/2026/1", "2026-11-28T00:00:00"),
    row("100", 4, "R/2020/1", "2020-01-28T00:00:00", { status: "Deleted", active: false, cancelled: true }),
  ];
  const l = buildItsLookup(["100", "999"], rows, today);
  const [p, missing] = l.people;
  assert.equal(p.total, 3);
  assert.equal(p.mostRecent.reference, "R/2024/1");
  assert.deepEqual(p.earlier.map((t) => t.reference), ["R/2017/1"]);
  assert.equal(p.next.reference, "R/2026/1");
  assert.match(p.notes[0], /Not counted: R\/2020\/1/);
  assert.equal(missing.found, false);
  assert.equal(l.found, 1);
});

test("arrivals workbook layout: date, tour, ITS, name, visits, most recent, earlier", async () => {
  const history = [
    row("20359107", 8, "R/2019/5", "2019-02-12T11:00:00"),
    row("20359107", 9, "R/2024/10", "2024-05-05T11:00:00"),
    row("20359107", 10, "R/2025/10", "2025-05-05T11:00:00"),
  ];
  const r = buildArrivalsReport([current("20359107", { name: "Shaikh A" }), current("20000001")], history,
    { ...opts, to: "2026-12-01" });
  const buf = await arrivalsWorkbook(ExcelJS, r).xlsx.writeBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet("Report");
  const v = (a) => ws.getCell(a).value;
  assert.deepEqual([v("A1"), v("B1"), v("C1"), v("D1"), v("E1"), v("F1"), v("G1"), v("H1"), v("I1")],
    ["Arrival date", "Tour", "ITS", "Name", "Times visited (incl. this one)", "Most recent trip",
      "Earlier trip 1", "Earlier trip 2", "Notes"]);
  assert.equal(v("A2").toISOString().slice(0, 10), "2026-12-01");
  assert.equal(v("B3"), 2696);
  assert.match(v("C3"), /^Arr IA 442/);
  assert.equal(v("C4"), 20000001);
  assert.equal(v("E4"), 1);
  assert.equal(v("F4"), null);
  assert.equal(v("C5"), 20359107);
  assert.equal(v("D5"), "Shaikh A");
  assert.equal(v("E5"), 4);
  assert.equal(v("F5").toISOString().slice(0, 10), "2025-05-05");
  assert.equal(v("G5").toISOString().slice(0, 10), "2024-05-05");
  assert.equal(v("H5").toISOString().slice(0, 10), "2019-02-12");
});

test("ITS workbook layout", async () => {
  const rows = [row("100", 2, "R/2024/1", "2024-12-03T00:00:00"), row("100", 1, "R/2017/1", "2017-07-09T00:00:00")];
  const l = buildItsLookup(["100"], rows, new Date("2026-11-19T00:00:00Z"));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await itsWorkbook(ExcelJS, l).xlsx.writeBuffer());
  const ws = wb.getWorksheet("ITS lookup");
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((c) => ws.getRow(1).getCell(c).value),
    ["ITS", "Name", "Times visited", "Most recent trip", "Earlier trip 1", "Next booked trip", "Notes"]);
  assert.equal(ws.getCell("C2").value, 2);
  assert.equal(ws.getCell("D2").value.toISOString().slice(0, 10), "2024-12-03");
  assert.equal(ws.getCell("E2").value.toISOString().slice(0, 10), "2017-07-09");
});

// ------------------------------------------------------------------ Worker / client
function fakeNkerp(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace("https://to.najafkarbala.com/NKERPApi/", "");
    const body = JSON.parse(init.body);
    calls.push({ path, body, cookie: init.headers.Cookie });
    if (path === "api/accounts/Login") {
      return new Response(JSON.stringify({ ReturnStatus: true, IsAuthenicated: true, UserId: 1 }), {
        headers: { "Set-Cookie": ".ASPXAUTH=abc; path=/; HttpOnly" },
      });
    }
    return new Response(JSON.stringify(handler(body)));
  };
  return { calls, fetchImpl };
}

test("client: history uses newline ITS lists, trims private fields, keeps the session", async () => {
  resetSession();
  const { calls, fetchImpl } = fakeNkerp((body) => ({
    TotalRows: 1, lstGeneralSearchPassengersDTO: [{ ...row("111", 1, "R/1", "2020-01-01T00:00:00"), PassportNumber: "X1", ITSID: body.ITSIds.split("\n")[0] }],
  }));
  const env = { NKERP_LOGIN_ID: "id", NKERP_PASSWORD: "pw" };
  const rows = await history(env, ["111", "222"], fetchImpl);
  assert.equal(calls[0].path, "api/accounts/Login");
  assert.equal(calls[1].body.ITSIds, "111\n222");
  assert.equal(calls[1].cookie, ".ASPXAUTH=abc");
  assert.equal(calls[2].body.ITSIds, "222"); // solo retry for the ITS the batch missed
  assert.equal(rows.length, 2);
  assert.equal(rows[0].PassportNumber, undefined);
  assert.deepEqual(Object.keys(trim({})).includes("PassportNumber"), false);
});

test("worker: access code gate", async () => {
  const env = { APP_PASSCODE: "1234" };
  const worker = { fetch: (req) => api(req, env, new URL(req.url)) };
  const blocked = await worker.fetch(new Request("https://x/api/arrivals?from=2026-12-01&to=2026-12-02&office=A"), env);
  assert.equal(blocked.status, 401);
  const wrong = await worker.fetch(new Request("https://x/api/unlock", { method: "POST", body: '{"code":"9"}' }), env);
  assert.equal(wrong.status, 401);
  const ok = await worker.fetch(new Request("https://x/api/unlock", { method: "POST", body: '{"code":"1234"}' }), env);
  const cookie = ok.headers.get("Set-Cookie").split(";")[0];
  const session = await worker.fetch(new Request("https://x/api/session", { headers: { Cookie: cookie } }), env);
  assert.deepEqual(await session.json(), { locked: false });
});
