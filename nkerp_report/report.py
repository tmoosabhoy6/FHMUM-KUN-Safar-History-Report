"""Turn NKERP passenger rows into the Kun Safar history report.

Report rules
------------
* Only passengers whose tour Office Name is exactly the selected office (default
  "Fayz E Husayni Trust Mumbai") and whose tour arrives inside the date range.
* Only people who are on the tour: tour active, not cancelled/deleted, applicant active.
* Only adults: age on the tour's arrival date >= the minimum age (default 18). Infants
  are always excluded.
* Previous visits: every other NKERP tour of the same ITS that arrived before this tour,
  any office, earliest to latest. Deleted / cancelled tours and tours the person was
  removed from are not counted (they are listed in Notes instead).
* Total visits = previous visits + this one.
"""
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime

DEFAULT_OFFICE = "Fayz E Husayni Trust Mumbai"
DEFAULT_MIN_AGE = 18


# ---------------------------------------------------------------------- helpers
def parse_dt(value):
    """NKERP timestamps -> datetime, or None for blanks and the 0001-01-01 placeholder."""
    if not value:
        return None
    text = str(value).strip()
    if text.startswith("0001-01-01"):
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "")[:26])
    except ValueError:
        return None


def age_on(dob, day):
    if dob is None or day is None:
        return None
    return day.year - dob.year - ((day.month, day.day) < (dob.month, dob.day))


def tour_number(reference):
    """'NKERP/TOUR/2026/2696' -> 2696 (falls back to the reference text)."""
    tail = str(reference or "").rstrip("/").rsplit("/", 1)[-1]
    return int(tail) if tail.isdigit() else str(reference or "")


def clean(text):
    return " ".join(str(text or "").split())


def fmt_day(value):
    return value.strftime("%d-%b-%Y") if value else ""


def fmt_dt(value):
    if not value:
        return ""
    return value.strftime("%d-%b-%Y %H:%M")


def is_on_tour(row):
    """True when the person is really on this tour (not deleted, cancelled or removed)."""
    return (row.get("IsActive") is not False
            and not row.get("IsCancellation")
            and row.get("IsApplicantActive") is not False
            and str(row.get("Status") or "").strip().lower() != "deleted")


def why_not_counted(row):
    if str(row.get("Status") or "").strip().lower() == "deleted" or row.get("IsActive") is False:
        return "tour deleted"
    if row.get("IsCancellation"):
        return "tour cancelled"
    if row.get("IsApplicantActive") is False:
        return "removed from tour"
    return "not counted"


def flights_of(row):
    return (clean(row.get("ArrivalCode")), parse_dt(row.get("FlightArrivalTime")),
            clean(row.get("DepartureCode")), parse_dt(row.get("FlightDepartureTime")))


def flight_text(flights):
    arr_code, arr_time, dep_code, dep_time = flights
    arr = f"Arr {arr_code or '—'}" + (f" · {fmt_dt(arr_time)}" if arr_time else "")
    dep = f"Dep {dep_code or '—'}" + (f" · {fmt_dt(dep_time)}" if dep_time else "")
    return f"{arr}   |   {dep}"


# ---------------------------------------------------------------------- model
@dataclass
class Visit:
    tour_id: int
    reference: str
    arrival: datetime
    office: str
    package: str


@dataclass
class Person:
    its: str
    name: str
    age: int
    gender: str
    arrival_code: str
    arrival_time: datetime
    departure_code: str
    departure_time: datetime
    package: str
    previous: list = field(default_factory=list)
    notes: list = field(default_factory=list)
    history_checked: bool = True

    @property
    def total_visits(self):
        return len(self.previous) + 1

    @property
    def its_value(self):
        return int(self.its) if self.its.isdigit() else self.its


@dataclass
class Tour:
    tour_id: int
    reference: str
    arrival: datetime
    departure: datetime
    package: str
    flights: tuple
    people: list = field(default_factory=list)

    @property
    def number(self):
        return tour_number(self.reference)

    @property
    def flight_details(self):
        return flight_text(self.flights)


@dataclass
class Day:
    day: date
    tours: list = field(default_factory=list)


@dataclass
class Report:
    office: str
    date_from: date
    date_to: date
    min_age: int
    days: list
    skipped: Counter
    generated_at: datetime

    @property
    def max_previous(self):
        return max((len(p.previous) for d in self.days for t in d.tours for p in t.people), default=0)

    @property
    def people_count(self):
        return sum(len(t.people) for d in self.days for t in d.tours)

    @property
    def tour_count(self):
        return sum(len(d.tours) for d in self.days)


# ---------------------------------------------------------------------- builder
def build_report(arrival_rows, history, *, office=DEFAULT_OFFICE, date_from, date_to,
                 min_age=DEFAULT_MIN_AGE, generated_at=None):
    """arrival_rows: GeneralSearchPassengers rows for the range.
    history: {ITS: [rows of every tour of that ITS]} (see NKERPClient.history)."""
    skipped = Counter()
    office_key = clean(office).lower()
    tours, tour_rows, seen = {}, defaultdict(list), set()

    for row in arrival_rows:
        arrival = parse_dt(row.get("StartDate"))
        if clean(row.get("OfficeName")).lower() != office_key:
            skipped["other office"] += 1
            continue
        if arrival is None or not (date_from <= arrival.date() <= date_to):
            skipped["arrival outside range"] += 1
            continue
        if not is_on_tour(row):
            skipped["cancelled / removed"] += 1
            continue
        tour_id = row.get("TourId")
        tour_rows[tour_id].append(row)
        if tour_id not in tours:
            tours[tour_id] = Tour(
                tour_id=tour_id, reference=clean(row.get("ReferenceNo")), arrival=arrival,
                departure=parse_dt(row.get("EndDate")), package=clean(row.get("PackageName")),
                flights=(), people=[])

        dob = parse_dt(row.get("DateOfBirth"))
        age = age_on(dob, arrival.date())
        if age is None:
            age = row.get("Age") if isinstance(row.get("Age"), int) else None
        if row.get("IsInfant"):
            skipped["infant"] += 1
            continue
        if age is None or age < min_age:
            skipped[f"under {min_age}" if age is not None else "no date of birth"] += 1
            continue
        its = clean(row.get("ITSID"))
        if (tour_id, its) in seen and its.isdigit():
            skipped["duplicate row"] += 1
            continue
        seen.add((tour_id, its))
        arr_code, arr_time, dep_code, dep_time = flights_of(row)
        tours[tour_id].people.append(Person(
            its=its, name=clean(row.get("ApplicantName")), age=age, gender=clean(row.get("Gender")),
            arrival_code=arr_code, arrival_time=arr_time, departure_code=dep_code,
            departure_time=dep_time, package=clean(row.get("PackageName"))))

    # Tour flight details = the flights most of its (active) passengers have.
    for tour_id, tour in tours.items():
        counts = Counter(flights_of(r) for r in tour_rows[tour_id])
        tour.flights = counts.most_common(1)[0][0] if counts else ("", None, "", None)

    for tour in tours.values():
        for person in tour.people:
            _fill_history(person, tour, history)
        tour.people.sort(key=lambda p: (not p.its.isdigit(), p.its))

    days = defaultdict(list)
    for tour in tours.values():
        if tour.people:
            days[tour.arrival.date()].append(tour)
        else:
            skipped["tours with no adults"] += 1
    ordered = [Day(day=d, tours=sorted(days[d], key=lambda t: (t.arrival, str(t.reference))))
               for d in sorted(days)]
    return Report(office=office, date_from=date_from, date_to=date_to, min_age=min_age,
                  days=ordered, skipped=skipped, generated_at=generated_at or datetime.now())


def _fill_history(person, tour, history):
    notes = person.notes
    if person.package:
        notes.append(f"Package: {person.package}")
    if (person.arrival_code, person.arrival_time, person.departure_code, person.departure_time) != tour.flights:
        notes.append("Own flights: " + flight_text(
            (person.arrival_code, person.arrival_time, person.departure_code, person.departure_time)))
    if not person.its.isdigit():
        person.history_checked = False
        notes.append("No ITS number in NKERP - past visits could not be looked up")
        return

    previous, not_counted, later = {}, [], []
    for row in history.get(person.its, []):
        if row.get("TourId") == tour.tour_id:
            continue
        arrival = parse_dt(row.get("StartDate"))
        if arrival is None:
            continue
        ref = clean(row.get("ReferenceNo"))
        if arrival >= tour.arrival:
            if is_on_tour(row):
                later.append(f"{ref} ({fmt_day(arrival)})")
            continue
        if not is_on_tour(row):
            not_counted.append(f"{ref} ({fmt_day(arrival)}, {why_not_counted(row)})")
            continue
        previous.setdefault(row.get("TourId"), Visit(
            tour_id=row.get("TourId"), reference=ref, arrival=arrival,
            office=clean(row.get("OfficeName")), package=clean(row.get("PackageName"))))
    person.previous = sorted(previous.values(), key=lambda v: v.arrival)

    packaged = [f"{fmt_day(v.arrival)} via {v.package}" for v in person.previous if v.package]
    if packaged:
        notes.append("Past packages: " + "; ".join(packaged))
    if not_counted:
        notes.append("Not counted: " + "; ".join(sorted(set(not_counted))))
    if later:
        notes.append("Also booked later: " + "; ".join(sorted(set(later))))
