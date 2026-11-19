// Excel workbooks for both reports. ExcelJS is passed in (browser global or Node import).
//
// Arrivals sheet, column by column:
//   A arrival date | B tour no. | C ITS (tour rows: flight details) | D name |
//   E times visited (incl. this one) | F most recent trip | G… earlier trips, newest → oldest | notes
import { fmtDay, fmtDt } from "./report.js";

const INK = "FF0F2A2E", TEAL = "FF1E8C8A", GOLD_BG = "FFFBF1D2", DAY_BG = "FFD7EAE6", TOUR_BG = "FFF1F6F4", LINE = "FFCFDAD6";
const DATE_FMT = "dd-mmm-yyyy";

const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

function headerRow(ws, headers) {
  const row = ws.getRow(1);
  headers.forEach((text, i) => {
    const cell = row.getCell(i + 1);
    cell.value = text;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = fill(INK);
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  row.height = 34;
}

export function arrivalsWorkbook(ExcelJS, report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Kun Safar History";
  const ws = wb.addWorksheet("Report", { views: [{ state: "frozen", xSplit: 4, ySplit: 1 }] });
  const earlierStart = 7; // G
  const notesCol = earlierStart + report.maxEarlier;
  const headers = ["Arrival date", "Tour", "ITS", "Name", "Times visited (incl. this one)", "Most recent trip"];
  for (let i = 0; i < report.maxEarlier; i++) headers.push(`Earlier trip ${i + 1}`);
  headers.push("Notes");
  headerRow(ws, headers);

  let r = 2;
  for (const day of report.days) {
    const row = ws.getRow(r++);
    row.getCell(1).value = day.day;
    row.getCell(1).numFmt = "d-mmm";
    row.getCell(1).font = { bold: true, size: 12, color: { argb: INK } };
    for (let c = 1; c <= notesCol; c++) row.getCell(c).fill = fill(DAY_BG);
    for (const tour of day.tours) {
      const tr = ws.getRow(r++);
      tr.getCell(2).value = tour.number;
      tr.getCell(2).font = { bold: true, color: { argb: TEAL } };
      tr.getCell(3).value = tour.flightDetails;
      tr.getCell(3).font = { bold: true };
      tr.getCell(notesCol).value = [tour.reference, tour.package && `Package: ${tour.package}`,
        `${tour.people.length} adults`].filter(Boolean).join(", ");
      for (let c = 2; c <= notesCol; c++) tr.getCell(c).fill = fill(TOUR_BG);
      for (const p of tour.people) {
        const pr = ws.getRow(r++);
        pr.getCell(3).value = /^\d+$/.test(p.its) ? Number(p.its) : p.its;
        pr.getCell(3).alignment = { horizontal: "left" };
        pr.getCell(4).value = p.name;
        const count = pr.getCell(5);
        count.value = p.total;
        count.font = { bold: true };
        count.fill = fill(GOLD_BG);
        count.alignment = { horizontal: "center" };
        if (p.mostRecent) {
          pr.getCell(6).value = p.mostRecent.arrival;
          pr.getCell(6).numFmt = DATE_FMT;
          pr.getCell(6).font = { bold: true };
        }
        p.earlier.forEach((trip, i) => {
          const cell = pr.getCell(earlierStart + i);
          cell.value = trip.arrival;
          cell.numFmt = DATE_FMT;
        });
        pr.getCell(notesCol).value = p.notes.join("\n");
        pr.getCell(notesCol).alignment = { wrapText: true, vertical: "top" };
        for (let c = 1; c <= notesCol; c++) pr.getCell(c).border = { bottom: { style: "thin", color: { argb: LINE } } };
      }
    }
  }
  const widths = { 1: 11, 2: 9, 3: 13, 4: 34, 5: 12, 6: 14 };
  for (let i = 0; i < report.maxEarlier; i++) widths[earlierStart + i] = 13;
  widths[notesCol] = 70;
  for (const [c, w] of Object.entries(widths)) ws.getColumn(Number(c)).width = w;

  const det = wb.addWorksheet("Details", { views: [{ state: "frozen", ySplit: 1 }] });
  headerRow(det, ["Arrival date", "Tour reference", "Tour no.", "ITS", "Name", "Gender", "Age at arrival",
    "Times visited (incl. this one)", "Most recent trip", "Most recent tour", "Most recent office",
    "Earlier trips (newest → oldest)", "Tour arrival", "Tour departure", "Arrival flight", "Arrival flight time",
    "Departure flight", "Departure flight time", "Package", "Notes"]);
  for (const day of report.days) for (const t of day.tours) for (const p of t.people) {
    det.addRow([day.day, t.reference, t.number, /^\d+$/.test(p.its) ? Number(p.its) : p.its, p.name, p.gender, p.age,
      p.total, p.mostRecent?.arrival || null, p.mostRecent?.reference || "", p.mostRecent?.office || "",
      p.earlier.map((x) => fmtDay(x.arrival)).join(", "), t.arrival, t.departure,
      p.flights.arrCode, p.flights.arrTime, p.flights.depCode, p.flights.depTime, p.package, p.notes.join(" | ")]);
  }
  formatDetails(det, { 1: DATE_FMT, 9: DATE_FMT, 13: "dd-mmm-yyyy hh:mm", 14: "dd-mmm-yyyy hh:mm",
    16: "dd-mmm-yyyy hh:mm", 18: "dd-mmm-yyyy hh:mm" },
  [12, 22, 9, 11, 32, 8, 8, 12, 13, 22, 26, 40, 17, 17, 12, 17, 12, 17, 30, 80]);

  about(wb, [
    ["Report", "FHMUM Kun Safar arrivals"],
    ["Office", report.office],
    ["Arrivals", `${fmtDay(new Date(report.from))} to ${fmtDay(new Date(report.to))}`],
    ["Minimum age", `${report.minAge} on the tour's arrival date (infants always left out)`],
    ["Generated", fmtDt(nowNaive(report.generatedAt))],
    ["Tours", report.tourCount], ["Adults listed", report.peopleCount], ["", ""],
    ["Rules", "Times visited = this trip + every earlier NKERP tour of the same ITS, from any office."],
    ["", "Most recent trip is the latest of those earlier tours; the columns after it go back in time."],
    ["", "Deleted or cancelled tours, and tours the person was removed from, are not counted (see Notes)."],
    ["", "Tour flight details are the flights most of the tour's passengers have; anyone different gets an 'Own flights' note."],
    ["", ""], ["Left out of the report", ""],
    ...Object.entries(report.skipped).sort().map(([k, v]) => [`  ${k}`, v]),
  ]);
  return wb;
}

export function itsWorkbook(ExcelJS, lookup) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Kun Safar History";
  const ws = wb.addWorksheet("ITS lookup", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  const earlierStart = 5; // E
  const nextCol = earlierStart + lookup.maxEarlier;
  const notesCol = nextCol + 1;
  const headers = ["ITS", "Name", "Times visited", "Most recent trip"];
  for (let i = 0; i < lookup.maxEarlier; i++) headers.push(`Earlier trip ${i + 1}`);
  headers.push("Next booked trip", "Notes");
  headerRow(ws, headers);
  lookup.people.forEach((p, idx) => {
    const row = ws.getRow(idx + 2);
    row.getCell(1).value = Number(p.its);
    row.getCell(1).alignment = { horizontal: "left" };
    row.getCell(2).value = p.found ? p.name : "Not found in NKERP";
    if (!p.found) row.getCell(2).font = { italic: true, color: { argb: "FF9E3B3B" } };
    const count = row.getCell(3);
    count.value = p.total;
    count.font = { bold: true };
    count.fill = fill(GOLD_BG);
    count.alignment = { horizontal: "center" };
    if (p.mostRecent) Object.assign(row.getCell(4), { value: p.mostRecent.arrival, numFmt: DATE_FMT });
    (p.earlier || []).forEach((t, i) => Object.assign(row.getCell(earlierStart + i), { value: t.arrival, numFmt: DATE_FMT }));
    if (p.next) Object.assign(row.getCell(nextCol), { value: p.next.arrival, numFmt: DATE_FMT });
    const notes = [...p.notes];
    if (p.mostRecent) notes.unshift(`Most recent: ${p.mostRecent.reference}, ${p.mostRecent.office}`);
    row.getCell(notesCol).value = notes.join("\n");
    row.getCell(notesCol).alignment = { wrapText: true, vertical: "top" };
    for (let c = 1; c <= notesCol; c++) row.getCell(c).border = { bottom: { style: "thin", color: { argb: LINE } } };
  });
  const widths = { 1: 12, 2: 34, 3: 10, 4: 14 };
  for (let i = 0; i < lookup.maxEarlier; i++) widths[earlierStart + i] = 13;
  widths[nextCol] = 14;
  widths[notesCol] = 70;
  for (const [c, w] of Object.entries(widths)) ws.getColumn(Number(c)).width = w;

  const trips = wb.addWorksheet("Trips", { views: [{ state: "frozen", ySplit: 1 }] });
  headerRow(trips, ["ITS", "Name", "Arrival", "Departure", "Tour reference", "Office", "Package", "Status",
    "Counted", "Arrival flight", "Arrival flight time", "Departure flight", "Departure flight time"]);
  for (const p of lookup.people) for (const t of (p.all || []).slice().sort((a, b) => a.arrival - b.arrival)) {
    trips.addRow([Number(p.its), p.name, t.arrival, t.departure, t.reference, t.office, t.package, t.status,
      t.counted ? "Yes" : `No (${t.reason})`, t.flights.arrCode, t.flights.arrTime, t.flights.depCode, t.flights.depTime]);
  }
  formatDetails(trips, { 3: DATE_FMT, 4: DATE_FMT, 11: "dd-mmm-yyyy hh:mm", 13: "dd-mmm-yyyy hh:mm" },
    [11, 32, 13, 13, 22, 30, 32, 11, 22, 12, 17, 12, 17]);
  return wb;
}

function formatDetails(ws, formats, widths) {
  ws.eachRow((row, n) => {
    if (n === 1) return;
    for (const [c, f] of Object.entries(formats)) row.getCell(Number(c)).numFmt = f;
  });
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: widths.length } };
}

function about(wb, rows) {
  const ws = wb.addWorksheet("About");
  rows.forEach((r) => ws.addRow(r));
  ws.getColumn(1).width = 26;
  ws.getColumn(1).font = { bold: true };
  ws.getColumn(2).width = 110;
}

// The generated-at time is a real instant; show it as Iraq (UTC+3) wall time.
function nowNaive(d) {
  return new Date(d.getTime() + 3 * 3600 * 1000);
}
