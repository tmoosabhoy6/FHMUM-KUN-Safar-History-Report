"""Write the report as an .xlsx workbook.

Sheet "Report" follows the hand-made layout:

    A            B       C                    D, E, F ...              count   notes   name
    1-Dec                                                              (date row)
                 2696    Arr IA 442 · ... | Dep IA 449 · ...           (tour row: tour no. + flights)
                         20359107  12-Feb-2019  05-May-2024    ...    3       ...     ...
                                                                       (one row per adult ITS)

Previous visits run left to right, earliest to latest. The "Total visits" column sits right
after the longest list of previous visits in the report, so every count lines up.
"""
from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from .report import fmt_day, fmt_dt

DATE_FMT = "dd-mmm-yyyy"
DAY_FMT = "d-mmm"
HEADER_FILL = PatternFill("solid", fgColor="1F3A4D")
DAY_FILL = PatternFill("solid", fgColor="D9E7F0")
TOUR_FILL = PatternFill("solid", fgColor="F3F6F8")
COUNT_FILL = PatternFill("solid", fgColor="FFF4D6")
THIN = Side(style="thin", color="C9D3DA")


def build_workbook(report):
    wb = Workbook()
    _report_sheet(wb.active, report)
    _details_sheet(wb.create_sheet("Details"), report)
    _about_sheet(wb.create_sheet("About"), report)
    return wb


def workbook_bytes(report):
    buffer = BytesIO()
    build_workbook(report).save(buffer)
    return buffer.getvalue()


def _report_sheet(ws, report):
    ws.title = "Report"
    first_visit_col = 4                                   # D
    count_col = first_visit_col + report.max_previous     # right after the longest history
    notes_col, name_col = count_col + 1, count_col + 2

    headers = {1: "Arrival date", 2: "Tour", 3: "ITS / Flight details",
               count_col: "Total visits (incl. this one)", notes_col: "Notes", name_col: "Name"}
    for i in range(report.max_previous):
        headers[first_visit_col + i] = f"Previous visit {i + 1}"
    for col, text in headers.items():
        cell = ws.cell(row=1, column=col, value=text)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    ws.row_dimensions[1].height = 32
    ws.freeze_panes = "D2"

    row = 2
    for day in report.days:
        cell = ws.cell(row=row, column=1, value=day.day)
        cell.number_format = DAY_FMT
        cell.font = Font(bold=True, size=12)
        for col in range(1, name_col + 1):
            ws.cell(row=row, column=col).fill = DAY_FILL
        row += 1
        for tour in day.tours:
            ws.cell(row=row, column=2, value=tour.number).font = Font(bold=True)
            ws.cell(row=row, column=3, value=tour.flight_details).font = Font(bold=True)
            ws.cell(row=row, column=notes_col,
                    value=" · ".join(x for x in (tour.reference,
                                                 f"Package: {tour.package}" if tour.package else "",
                                                 f"{len(tour.people)} adults") if x))
            for col in range(2, name_col + 1):
                ws.cell(row=row, column=col).fill = TOUR_FILL
            row += 1
            for person in tour.people:
                ws.cell(row=row, column=3, value=person.its_value).alignment = Alignment(horizontal="left")
                for i, visit in enumerate(person.previous):
                    cell = ws.cell(row=row, column=first_visit_col + i, value=visit.arrival.date())
                    cell.number_format = DATE_FMT
                count = ws.cell(row=row, column=count_col, value=person.total_visits)
                count.font = Font(bold=True)
                count.fill = COUNT_FILL
                count.alignment = Alignment(horizontal="center")
                ws.cell(row=row, column=notes_col, value="\n".join(person.notes)).alignment = \
                    Alignment(wrap_text=True, vertical="top")
                ws.cell(row=row, column=name_col, value=person.name)
                for col in range(1, name_col + 1):
                    ws.cell(row=row, column=col).border = Border(bottom=THIN)
                row += 1

    widths = {1: 11, 2: 9, 3: 58, count_col: 13, notes_col: 60, name_col: 34}
    for i in range(report.max_previous):
        widths[first_visit_col + i] = 13
    for col, width in widths.items():
        ws.column_dimensions[get_column_letter(col)].width = width


def _details_sheet(ws, report):
    headers = ["Arrival date", "Tour reference", "Tour no.", "ITS", "Name", "Gender", "Age at arrival",
               "Tour arrival", "Tour departure", "Arrival flight", "Arrival flight time",
               "Departure flight", "Departure flight time", "Package", "Previous visits",
               "Previous visit dates (earliest → latest)", "Previous visit tours",
               "Total visits (incl. this one)", "Notes"]
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = HEADER_FILL
    for day in report.days:
        for tour in day.tours:
            for p in tour.people:
                ws.append([
                    day.day, tour.reference, tour.number, p.its_value, p.name, p.gender, p.age,
                    tour.arrival, tour.departure, p.arrival_code, p.arrival_time, p.departure_code,
                    p.departure_time, p.package, len(p.previous),
                    ", ".join(fmt_day(v.arrival) for v in p.previous),
                    ", ".join(f"{v.reference} ({v.office})" for v in p.previous),
                    p.total_visits, " | ".join(p.notes),
                ])
    for row in ws.iter_rows(min_row=2):
        row[0].number_format = DATE_FMT
        for idx in (7, 8, 10, 12):
            row[idx].number_format = "dd-mmm-yyyy hh:mm"
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    for i, width in enumerate([12, 22, 9, 11, 32, 8, 8, 17, 17, 12, 17, 12, 17, 30, 9, 40, 60, 12, 70], 1):
        ws.column_dimensions[get_column_letter(i)].width = width


def _about_sheet(ws, report):
    rows = [
        ("Report", "FHMUM Kun Safar history"),
        ("Office", report.office),
        ("Arrivals from", fmt_day(report.date_from)),
        ("Arrivals to", fmt_day(report.date_to)),
        ("Minimum age", f"{report.min_age} (age on the tour's arrival date; infants excluded)"),
        ("Generated", fmt_dt(report.generated_at)),
        ("Tours", report.tour_count),
        ("Adults listed", report.people_count),
        ("", ""),
        ("Rules", "Previous visits = every other NKERP tour of the same ITS that arrived before this tour "
                  "(any office), earliest to latest."),
        ("", "Deleted or cancelled tours, and tours the person was removed from, are not counted "
             "(listed in Notes)."),
        ("", "Total visits = previous visits + this visit."),
        ("", "Tour flight details are the flights most of the tour's passengers have; a person with "
             "different flights gets an 'Own flights' note."),
        ("", ""),
        ("Left out of the report", ""),
    ]
    rows += [(f"  {reason}", count) for reason, count in sorted(report.skipped.items())]
    for r in rows:
        ws.append(list(r))
    for cell in ws["A"]:
        cell.font = Font(bold=True)
    ws.column_dimensions["A"].width = 26
    ws.column_dimensions["B"].width = 110
