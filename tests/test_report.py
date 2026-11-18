import unittest
from datetime import date
from io import BytesIO

from openpyxl import load_workbook

from nkerp_report.client import NKERPClient, NKERPError
from nkerp_report.excel import workbook_bytes
from nkerp_report.generate import generate
from nkerp_report.report import build_report, tour_number

OFFICE = "Fayz E Husayni Trust Mumbai"


def row(its, tour_id, ref, start, *, office=OFFICE, dob="1960-01-01", infant=False, status="Approved",
        active=True, cancelled=False, applicant_active=True, package=None, arr=("IA 442", "2026-12-01T07:00:00"),
        dep=("IA 441", "2026-12-10T21:30:00"), name="Person"):
    return {"Id": hash((its, tour_id)) & 0xFFFFFF, "ITSID": its, "TourId": tour_id, "ReferenceNo": ref,
            "StartDate": start, "EndDate": "2026-12-10T19:00:00", "OfficeName": office,
            "DateOfBirth": dob, "Age": None, "IsInfant": infant, "Status": status, "IsActive": active,
            "IsCancellation": cancelled, "IsApplicantActive": applicant_active, "PackageName": package,
            "ArrivalCode": arr[0], "FlightArrivalTime": arr[1], "DepartureCode": dep[0],
            "FlightDepartureTime": dep[1], "ApplicantName": name, "Gender": "Male"}


CUR = dict(tour_id=1, ref="NKERP/TOUR/2026/2696", start="2026-12-01T11:00:00")


def current(its, **kw):
    return row(its, CUR["tour_id"], CUR["ref"], CUR["start"], **kw)


class BuildReportTests(unittest.TestCase):
    def build(self, arrivals, history, **kw):
        return build_report(arrivals, history, office=OFFICE, date_from=date(2026, 12, 1),
                            date_to=date(2026, 12, 7), **kw)

    def test_history_counts_previous_visits_plus_this_one(self):
        arrivals = [current("20359107")]
        history = {"20359107": [
            current("20359107"),
            row("20359107", 9, "NKERP/TOUR/2024/10", "2024-05-05T11:00:00", office="Other"),
            row("20359107", 8, "NKERP/TOUR/2019/5", "2019-02-12T11:00:00", package="Permanent KUN Safar 1440"),
        ]}
        report = self.build(arrivals, history)
        person = report.days[0].tours[0].people[0]
        self.assertEqual([v.arrival.date() for v in person.previous], [date(2019, 2, 12), date(2024, 5, 5)])
        self.assertEqual(person.total_visits, 3)
        self.assertIn("Past packages: 12-Feb-2019 via Permanent KUN Safar 1440", person.notes)
        self.assertEqual(report.max_previous, 2)

    def test_deleted_cancelled_removed_and_later_tours_are_not_counted(self):
        arrivals = [current("1")]
        history = {"1": [
            row("1", 2, "R/2020/1", "2020-01-01T00:00:00", status="Deleted", active=False, cancelled=True),
            row("1", 3, "R/2021/1", "2021-01-01T00:00:00", cancelled=True),
            row("1", 4, "R/2022/1", "2022-01-01T00:00:00", applicant_active=False),
            row("1", 5, "R/2027/1", "2027-01-01T00:00:00"),
            row("1", 6, "R/2018/1", "2018-01-01T00:00:00", status="NA"),  # office tours: counted
        ]}
        person = self.build(arrivals, history).days[0].tours[0].people[0]
        self.assertEqual([v.reference for v in person.previous], ["R/2018/1"])
        self.assertEqual(person.total_visits, 2)
        notes = "\n".join(person.notes)
        self.assertIn("R/2020/1 (01-Jan-2020, tour deleted)", notes)
        self.assertIn("R/2021/1 (01-Jan-2021, tour cancelled)", notes)
        self.assertIn("R/2022/1 (01-Jan-2022, removed from tour)", notes)
        self.assertIn("Also booked later: R/2027/1", notes)

    def test_only_adults_of_the_office_who_are_on_the_tour(self):
        arrivals = [
            current("1", dob="2008-12-01"),          # turns 18 on arrival day -> included
            current("2", dob="2008-12-02"),          # 17 on arrival -> excluded
            current("3", infant=True, dob="2026-01-01"),
            current("4", applicant_active=False),
            row("5", 7, "R/2026/7", "2026-12-02T11:00:00", office="Hakimi Tours And Travels"),
            row("6", 8, "R/2026/8", "2026-12-09T11:00:00"),  # outside range
        ]
        report = self.build(arrivals, {})
        people = [p.its for d in report.days for t in d.tours for p in t.people]
        self.assertEqual(people, ["1"])
        self.assertEqual(report.skipped["under 18"], 1)
        self.assertEqual(report.skipped["infant"], 1)

    def test_flight_details_use_the_majority_and_note_differences(self):
        arrivals = [current("1"), current("2"),
                    current("3", arr=("FZ 221", "2026-12-01T15:05:00"))]
        tour = self.build(arrivals, {}).days[0].tours[0]
        self.assertEqual(tour.flight_details, "Arr IA 442 · 01-Dec-2026 07:00   |   Dep IA 441 · 10-Dec-2026 21:30")
        odd = [p for p in tour.people if p.its == "3"][0]
        self.assertTrue(any(n.startswith("Own flights: Arr FZ 221") for n in odd.notes))
        self.assertEqual(tour_number(tour.reference), 2696)

    def test_missing_its_is_listed_with_a_note(self):
        person = self.build([current("N/A")], {}).days[0].tours[0].people[0]
        self.assertEqual(person.total_visits, 1)
        self.assertIn("No ITS number", person.notes[-1])


class WorkbookTests(unittest.TestCase):
    def test_layout_matches_the_template(self):
        arrivals = [current("20359107"), current("20000001")]
        history = {"20359107": [
            row("20359107", 8, "R/2019/5", "2019-02-12T11:00:00"),
            row("20359107", 9, "R/2024/10", "2024-05-05T11:00:00"),
            row("20359107", 10, "R/2025/10", "2025-05-05T11:00:00")]}
        report = build_report(arrivals, history, office=OFFICE, date_from=date(2026, 12, 1),
                              date_to=date(2026, 12, 1))
        ws = load_workbook(BytesIO(workbook_bytes(report)))["Report"]
        self.assertEqual(ws["A2"].value.date(), date(2026, 12, 1))       # arrival date row
        self.assertEqual(ws["B3"].value, 2696)                            # tour row
        self.assertTrue(ws["C3"].value.startswith("Arr IA 442"))          # flight details
        self.assertEqual(ws["C4"].value, 20000001)                        # first ITS, no history
        self.assertEqual(ws["F4"].value, None)
        self.assertEqual(ws["G4"].value, 1)                               # count column = D + 3
        self.assertEqual(ws["C5"].value, 20359107)
        self.assertEqual(ws["D5"].value.date(), date(2019, 2, 12))
        self.assertEqual(ws["F5"].value.date(), date(2025, 5, 5))
        self.assertEqual(ws["G5"].value, 4)
        self.assertEqual(ws["G1"].value, "Total visits (incl. this one)")


class ClientSafetyTests(unittest.TestCase):
    def test_only_read_endpoints_are_allowed(self):
        client = NKERPClient("x", "y")
        with self.assertRaises(NKERPError):
            client._post("api/VisitingPoint/saveZiyaratSchedule", {})

    def test_generate_with_a_fake_client(self):
        class Fake:
            def login(self):
                return {}

            def arrivals(self, *a):
                return [current("1")]

            def history(self, its, progress=None):
                return {"1": [row("1", 5, "R/2019/1", "2019-01-01T00:00:00")]}

        report = generate("2026-12-01", "2026-12-07", client=Fake())
        self.assertEqual(report.days[0].tours[0].people[0].total_visits, 2)


if __name__ == "__main__":
    unittest.main()
