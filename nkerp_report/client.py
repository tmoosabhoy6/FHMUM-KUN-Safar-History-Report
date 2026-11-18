"""Read-only NKERP API client.

Only two endpoints are ever called:
  * POST api/accounts/Login                 - start a session (cookie based)
  * POST api/tours/GeneralSearchPassengers  - the "General Search -> Passengers" list

GeneralSearchPassengers returns one row per person per tour, with ITS, date of birth,
office, package, tour reference, tour arrival/departure and the person's flight codes and
times.  Filtered by ITSIds (newline separated) and a wide arrival range it returns every
tour those ITS numbers were ever on - the same history the Discount Demarcation /
Kun Ziyarat screens show.

Nothing in this module can write to NKERP: any other path raises before a request is made.
"""
import json
import time
from datetime import datetime, timezone
from http.cookiejar import CookieJar
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, Request, build_opener

BASE_URL = "https://to.najafkarbala.com/NKERPApi/"
ORIGIN = "https://to.najafkarbala.com"
LOGIN = "api/accounts/Login"
SEARCH_PASSENGERS = "api/tours/GeneralSearchPassengers"
ALLOWED = {LOGIN, SEARCH_PASSENGERS}
ROWS_KEY = "lstGeneralSearchPassengersDTO"

# History covers every tour NKERP holds (records start in 2016).
HISTORY_FROM = "2000-01-01"
HISTORY_TO = "2100-12-31"


class NKERPError(RuntimeError):
    pass


class NKERPClient:
    def __init__(self, login_id, password, *, timeout=120, retries=5, base_url=BASE_URL):
        if not login_id or not password:
            raise NKERPError("NKERP login ID and password are required")
        self._login_id = str(login_id).strip()
        self._password = password
        self.timeout = timeout
        self.retries = retries
        self.base_url = base_url
        self._cookies = CookieJar()
        self._opener = build_opener(HTTPCookieProcessor(self._cookies))
        self.logged_in = False
        self.requests_made = 0

    # ------------------------------------------------------------------ transport
    def _post(self, path, body):
        if path not in ALLOWED:
            raise NKERPError(f"{path} is not on the read-only allowlist")
        request = Request(
            self.base_url + path,
            data=json.dumps(body).encode(),
            headers={"Accept": "application/json", "Content-Type": "application/json",
                     "Origin": ORIGIN, "Referer": ORIGIN + "/"},
        )
        for attempt in range(self.retries + 1):
            try:
                self.requests_made += 1
                with self._opener.open(request, timeout=self.timeout) as response:
                    return json.load(response)
            except HTTPError as exc:
                if exc.code == 401 and path != LOGIN and attempt == 0:
                    self.login()
                    continue
                detail = ""
                try:
                    payload = json.loads(exc.read() or b"{}")
                    detail = " ".join(payload.get("ReturnMessage") or [])
                except Exception:
                    pass
                raise NKERPError(f"NKERP returned HTTP {exc.code} for {path}. {detail}".strip()) from None
            except (URLError, ConnectionError, TimeoutError, OSError) as exc:
                # Both endpoints are reads (Login only opens a session), so retrying is safe.
                if attempt == self.retries:
                    raise NKERPError(f"Could not reach NKERP ({exc})") from None
                time.sleep(min(2 * (attempt + 1), 10))
        raise NKERPError("NKERP request failed")

    def login(self):
        result = self._post(LOGIN, {
            "LocalUTCTime": datetime.now(timezone.utc).isoformat(),
            "LoginId": self._login_id,
            "Password": self._password,
        })
        if not result.get("ReturnStatus") or not result.get("IsAuthenicated"):
            raise NKERPError("NKERP login failed - check the login ID and password")
        self.logged_in = True
        return {"user_id": result.get("UserId")}

    # ------------------------------------------------------------------ reads
    def search_passengers(self, filters, *, page_size=100):
        """Every row of a GeneralSearchPassengers search, with a census check."""
        if not self.logged_in:
            self.login()
        rows, seen, page, total = [], set(), 1, None
        while total is None or len(rows) < total:
            body = {
                "IsPaging": True, "clientTimeZoneOffset": -180, "sortBy": "StartDateTimeZone",
                "currentPage": page, "itemsPerPage": page_size, "maxSize": 10,
                "totalItems": total or 0, "reverse": False,
            }
            body.update(filters)
            data = self._post(SEARCH_PASSENGERS, body)
            if data.get("IsError") or data.get("ReturnStatus") is False:
                raise NKERPError("NKERP rejected the passenger search: "
                                 + " ".join(data.get("ReturnMessage") or []))
            chunk = data.get(ROWS_KEY) or []
            total = int(data.get("TotalRows") or 0)
            if not chunk:
                break
            for row in chunk:
                key = row.get("Id"), row.get("TourId"), row.get("ITSID")
                if key not in seen:
                    seen.add(key)
                    rows.append(row)
            page += 1
            if page > 500:
                raise NKERPError("Passenger search did not finish paging")
        if total and len(rows) < total:
            raise NKERPError(f"NKERP said {total} passengers but only {len(rows)} came back; try again")
        return rows

    def arrivals(self, date_from, date_to, office_name):
        """Passengers of one office whose tour arrives between two dates (inclusive)."""
        return self.search_passengers({
            "ArrivalFrom": date_from, "ArrivalTo": date_to, "OfficeName": office_name,
        })

    def history(self, its_numbers, *, batch_size=40, progress=None):
        """{ITS: [rows of every tour that ITS was ever on]} for numeric ITS numbers."""
        wanted = sorted({str(i).strip() for i in its_numbers if str(i).strip().isdigit()})
        out = {its: [] for its in wanted}
        for start in range(0, len(wanted), batch_size):
            batch = wanted[start:start + batch_size]
            rows = self.search_passengers({
                # Newline separated: NKERP returns nothing for comma separated lists here.
                "ITSIds": "\n".join(batch), "ArrivalFrom": HISTORY_FROM, "ArrivalTo": HISTORY_TO,
            }, page_size=1000)
            for row in rows:
                its = str(row.get("ITSID") or "").strip()
                if its in out:
                    out[its].append(row)
            # Every ITS has at least its current tour, so an empty result means the batch
            # lookup missed it: ask for that ITS on its own.
            for its in batch:
                if not out[its]:
                    out[its] = [r for r in self.search_passengers({
                        "ITSIds": its, "ArrivalFrom": HISTORY_FROM, "ArrivalTo": HISTORY_TO,
                    }, page_size=1000) if str(r.get("ITSID") or "").strip() == its]
            if progress:
                progress(min(start + batch_size, len(wanted)), len(wanted))
        return out
