#!/usr/bin/env python3
"""FHMUM Kun Safar history report - small web app.

    pip install -r requirements.txt
    python app.py            # then open http://localhost:8000

NKERP credentials come from the form, or from NKERP_LOGIN_ID / NKERP_PASSWORD
(environment or a local .env file) when the form is left blank. They are only held
in memory for the run and are never written to disk or logged.
"""
import os
import threading
import time
import uuid
from datetime import date, timedelta
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request, send_file
from io import BytesIO

from nkerp_report.client import NKERPError
from nkerp_report.excel import workbook_bytes
from nkerp_report.generate import credentials_from_env, generate
from nkerp_report.report import DEFAULT_MIN_AGE, DEFAULT_OFFICE, fmt_day, fmt_dt


def load_dotenv(path=Path(__file__).with_name(".env")):
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_dotenv()
app = Flask(__name__)
JOBS = {}
JOB_TTL = 3 * 3600
LOCK = threading.Lock()


def _prune():
    cutoff = time.time() - JOB_TTL
    with LOCK:
        for key in [k for k, j in JOBS.items() if j["created"] < cutoff]:
            JOBS.pop(key, None)


def _run(job_id, params, login_id, password):
    job = JOBS[job_id]

    def progress(message):
        job["log"].append(message)

    try:
        report = generate(params["date_from"], params["date_to"], login_id=login_id, password=password,
                          office=params["office"], min_age=params["min_age"], progress=progress)
        job["report"] = report
        job["xlsx"] = workbook_bytes(report)
        job["state"] = "done"
    except NKERPError as exc:
        job["state"], job["error"] = "error", str(exc)
    except Exception as exc:  # surface anything unexpected instead of hanging the page
        job["state"], job["error"] = "error", f"Unexpected error: {exc}"


@app.get("/")
def index():
    today = date.today()
    env_id, env_pw = credentials_from_env()
    return render_template("index.html", date_from=today.isoformat(),
                           date_to=(today + timedelta(days=6)).isoformat(),
                           office=DEFAULT_OFFICE, min_age=DEFAULT_MIN_AGE,
                           server_credentials=bool(env_id and env_pw))


@app.post("/run")
def run():
    _prune()
    form = request.form
    try:
        params = {
            "date_from": date.fromisoformat(form["date_from"]),
            "date_to": date.fromisoformat(form["date_to"]),
            "office": (form.get("office") or DEFAULT_OFFICE).strip(),
            "min_age": int(form.get("min_age") or DEFAULT_MIN_AGE),
        }
    except (KeyError, ValueError):
        return jsonify(error="Please enter valid dates and age."), 400
    if params["date_to"] < params["date_from"]:
        return jsonify(error="The 'to' date is before the 'from' date."), 400
    if (params["date_to"] - params["date_from"]).days > 62:
        return jsonify(error="Please choose a range of at most 2 months."), 400
    login_id = form.get("login_id", "").strip()
    password = form.get("password", "")
    env_id, env_pw = credentials_from_env()
    if not (login_id and password) and not (env_id and env_pw):
        return jsonify(error="Enter your NKERP login ID and password."), 400

    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"state": "running", "log": [], "created": time.time(), "params": params}
    threading.Thread(target=_run, args=(job_id, params, login_id or None, password or None),
                     daemon=True).start()
    return jsonify(job=job_id)


@app.get("/status/<job_id>")
def status(job_id):
    job = JOBS.get(job_id) or abort(404)
    return jsonify(state=job["state"], log=job["log"][-6:], error=job.get("error"))


@app.get("/result/<job_id>")
def result(job_id):
    job = JOBS.get(job_id) or abort(404)
    if job["state"] != "done":
        abort(404)
    return render_template("result.html", job_id=job_id, report=job["report"],
                           fmt_day=fmt_day, fmt_dt=fmt_dt)


@app.get("/download/<job_id>")
def download(job_id):
    job = JOBS.get(job_id) or abort(404)
    if job["state"] != "done":
        abort(404)
    r = job["report"]
    name = f"kun-safar-history_{r.date_from:%Y-%m-%d}_to_{r.date_to:%Y-%m-%d}.xlsx"
    return send_file(BytesIO(job["xlsx"]), as_attachment=True, download_name=name,
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 8000)))
