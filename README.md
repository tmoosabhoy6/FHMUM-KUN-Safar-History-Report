# FHMUM Kun Safar History Report

A small app that reads NKERP (read-only) and builds an Excel report of every **Fayz E Husayni Trust Mumbai**
zaereen arriving in a chosen date range. For each person it shows the dates of their previous visits to Iraq, and
the total number of visits including the current one.

## Run it

```bash
pip install -r requirements.txt
python app.py                 # open http://localhost:8000
```

Pick the arrival dates, enter your NKERP login ID and password, press **Generate report**, then **Download Excel**.
A week of arrivals takes about 10–20 seconds.

To skip typing the login each time, copy `.env.example` to `.env` and fill it in. `.env` is git-ignored, and the
credentials are only kept in memory for the run.

Command line:

```bash
export NKERP_LOGIN_ID=...  NKERP_PASSWORD=...
python cli.py --from 2026-12-01 --to 2026-12-07 --out kun-safar.xlsx
```

## The Excel file

**Report** sheet (same layout as the hand-made template):

| A | B | C | D, E, F … | Total | Notes | Name |
|---|---|---|---|---|---|---|
| `1-Dec` (arrival date) | | | | | | |
| | `2696` (tour no.) | `Arr IA 442 · 01-Dec-2026 07:00 \| Dep IA 441 · 10-Dec-2026 21:30` | | | tour ref · package · adults | |
| | | `20359107` (ITS) | previous visit dates, earliest → latest | `3` | packages, notes | name |

* The **Total visits** column comes right after the longest list of previous visits, so every count lines up.
* **Notes** holds the package of this trip, packages of past trips ("12-Feb-2019 via Permanent KUN Safar 1440"),
  tours that were not counted, later bookings, and the person's own flights when they differ from the tour's.

**Details** is the same data as a flat, filterable table (one row per person, with flights, age, tour references).
**About** lists the settings, the rules, and how many people were left out and why.

## Rules

* **Office:** the tour's Office Name must be exactly the selected office (default `Fayz E Husayni Trust Mumbai`).
* **Arrival date:** the tour's start date in Iraq, within the chosen range (both ends included).
* **Adults only:** age on the arrival date must be 18 or more (adjustable). Infants are always excluded.
* **Who is on the tour:** people on deleted or cancelled tours, or removed from a tour, are left out.
* **Previous visits:** every other NKERP tour of the same ITS that arrived before this one, from **any**
  office, Office Tours included. Deleted or cancelled tours, and tours the person was removed from, are not
  counted; they are listed in Notes.
* **Total visits:** previous visits + this one.
* **Tour flight details:** the arrival and departure flight codes and times most of the tour's passengers have.

## How it reads NKERP

`nkerp_report/client.py` can only call two endpoints, and any other path raises an error before a request is
made:

* `POST api/accounts/Login` starts the session.
* `POST api/tours/GeneralSearchPassengers` is NKERP's General Search › Passengers list. It returns one row per
  person per tour: ITS, date of birth, office, package, tour reference, arrival and departure, and flight codes
  and times.
  * Filtered by `ArrivalFrom` / `ArrivalTo` / `OfficeName`, it gives the arrivals.
  * Filtered by `ITSIds` (newline-separated; commas return nothing) with a wide arrival range, it gives each
    ITS's full tour history. This is the same history that the Discount Demarcation and Kun Ziyarat Status
    screens show.

## Tests

```bash
python -m unittest discover -s tests
```
