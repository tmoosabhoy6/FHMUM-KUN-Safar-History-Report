"""One call that logs in, reads NKERP and builds the report."""
import os
from datetime import date

from .client import NKERPClient, NKERPError
from .report import DEFAULT_MIN_AGE, DEFAULT_OFFICE, build_report, clean, is_on_tour, parse_dt


def credentials_from_env():
    return os.environ.get("NKERP_LOGIN_ID", ""), os.environ.get("NKERP_PASSWORD", "")


def generate(date_from, date_to, *, login_id=None, password=None, office=DEFAULT_OFFICE,
             min_age=DEFAULT_MIN_AGE, progress=None, client=None):
    if isinstance(date_from, str):
        date_from = date.fromisoformat(date_from)
    if isinstance(date_to, str):
        date_to = date.fromisoformat(date_to)
    if date_to < date_from:
        raise NKERPError("The 'to' date is before the 'from' date")
    say = progress or (lambda message: None)

    if client is None:
        env_id, env_pw = credentials_from_env()
        client = NKERPClient(login_id or env_id, password or env_pw)
    say("Logging in to NKERP…")
    client.login()

    say(f"Reading {office} arrivals {date_from:%d-%b-%Y} to {date_to:%d-%b-%Y}…")
    rows = client.arrivals(date_from.isoformat(), date_to.isoformat(), office)
    office_key = clean(office).lower()
    wanted = {clean(r.get("ITSID")) for r in rows
              if clean(r.get("OfficeName")).lower() == office_key and is_on_tour(r)
              and not r.get("IsInfant") and parse_dt(r.get("StartDate"))}
    say(f"{len(rows)} passenger rows found; looking up visit history for {len(wanted)} ITS numbers…")
    history = client.history(wanted, progress=lambda done, total: say(f"History: {done}/{total} ITS"))
    report = build_report(rows, history, office=office, date_from=date_from, date_to=date_to,
                          min_age=min_age)
    say(f"Done: {report.people_count} adults on {report.tour_count} tours.")
    return report
