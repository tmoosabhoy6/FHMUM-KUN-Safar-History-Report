# Kun Safar History

Live app: **https://kun-safar-history.tmoosabhoy6.workers.dev** (Cloudflare Workers, free plan)

The app reads NKERP (read-only) and does two things:

1. **Look up ITS:** search one or many ITS numbers at once, from any office (FHMUM, Office Tours, Golden,
   and so on). For each person it shows how many times they have visited, their most recent trip, every
   earlier trip, and any trip already booked. You can type ITS numbers one by one, or paste a whole message:
   numbers split by commas, full stops, spaces or new lines are all picked out. Download the result as Excel.
2. **Arrivals report:** every adult (18+) arriving with **Fayz E Husayni Trust Mumbai** in a date range,
   grouped by arrival date and tour, with each tour's flight details. Download as Excel.

The NKERP login is stored as an encrypted Cloudflare secret, so nobody types it. The app opens
straight away, with no access code.

## Excel layout

**Arrivals report** (sheet "Report"):

| A | B | C | D | E | F | G … | last |
|---|---|---|---|---|---|---|---|
| `1-Dec` | | | | | | | |
| | `2696` | `Arr IA 442 01-Dec-2026 07:00 \| Dep IA 441 10-Dec-2026 21:30` | | | | | tour ref, package, adults |
| | | ITS | Name | Times visited (incl. this one) | Most recent trip | earlier trips, newest → oldest | Notes |

**ITS lookup** (sheet "ITS lookup"): ITS, Name, Times visited, Most recent trip, earlier trips (newest →
oldest), Next booked trip, Notes. The "Trips" sheet lists every trip, one per row.

Notes include packages ("12-Feb-2019 via Permanent KUN Safar 1440"), trips that were not counted, later
bookings, and personal flights that differ from the tour's.

## Counting rules

* A trip counts unless the tour was deleted or cancelled, or the person was removed from it. Office Tours
  count.
* Arrivals report: times visited = this trip + every earlier trip, from any office. Adults only, meaning
  age 18+ on the arrival date (adjustable). Infants are always left out.
* ITS lookup: times visited = every counted trip, including a booked upcoming one. "Most recent trip" is
  the latest one that has already arrived.

## How it works

* `src/nkerp.js` is the NKERP client. It can only call `api/accounts/Login` and
  `api/tours/GeneralSearchPassengers` (General Search › Passengers). Passport numbers, phone numbers and
  addresses are dropped before anything leaves the Worker.
  * By `ArrivalFrom`/`ArrivalTo`/`OfficeName` it gives the arrivals.
  * By `ITSIds` (newline-separated) with a wide date range it gives each ITS's full history.
* `src/api.js` holds the Worker API (`/api/arrivals`, `/api/history`, `/api/unlock`). `src/worker.js` is
  the entry point.
* `public/` is the app itself. `report.js` builds the reports, `excel.js` writes the workbooks (ExcelJS,
  in the browser), and `app.js` is the interface. `scripts/embed-site.js` bundles these files into the
  Worker on every deploy.

## Develop and deploy

```bash
npm install
npm test
```

For local runs, put the secrets in `.dev.vars` (git-ignored):

```
NKERP_LOGIN_ID=...
NKERP_PASSWORD=...
```

```bash
npx wrangler dev
```

Deploy, and change a secret (e.g. a new NKERP password):

```bash
npx wrangler deploy
npx wrangler secret put NKERP_PASSWORD
```

An optional access-code screen is built in but switched off. To turn it on, set an `APP_PASSCODE`
secret (`npx wrangler secret put APP_PASSCODE`); to turn it off again, delete it.
