#!/usr/bin/env python3
"""Command-line version of the report.

    export NKERP_LOGIN_ID=...  NKERP_PASSWORD=...
    python cli.py --from 2026-12-01 --to 2026-12-07 --out kun-safar.xlsx
"""
import argparse
import getpass
import sys
from datetime import date, timedelta

from nkerp_report.client import NKERPError
from nkerp_report.excel import workbook_bytes
from nkerp_report.generate import credentials_from_env, generate
from nkerp_report.report import DEFAULT_MIN_AGE, DEFAULT_OFFICE


def main(argv=None):
    today = date.today()
    parser = argparse.ArgumentParser(description="FHMUM Kun Safar history report from NKERP")
    parser.add_argument("--from", dest="date_from", default=today.isoformat(), help="first arrival date, YYYY-MM-DD")
    parser.add_argument("--to", dest="date_to", default=(today + timedelta(days=6)).isoformat(),
                        help="last arrival date, YYYY-MM-DD")
    parser.add_argument("--office", default=DEFAULT_OFFICE, help=f'office name (default "{DEFAULT_OFFICE}")')
    parser.add_argument("--min-age", type=int, default=DEFAULT_MIN_AGE, help="minimum age on arrival (default 18)")
    parser.add_argument("--out", default=None, help="output .xlsx path")
    args = parser.parse_args(argv)

    login_id, password = credentials_from_env()
    if not login_id:
        login_id = input("NKERP login ID: ").strip()
    if not password:
        password = getpass.getpass("NKERP password: ")
    out = args.out or f"kun-safar-history_{args.date_from}_to_{args.date_to}.xlsx"
    try:
        report = generate(args.date_from, args.date_to, login_id=login_id, password=password,
                          office=args.office, min_age=args.min_age,
                          progress=lambda m: print(m, file=sys.stderr))
    except NKERPError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    with open(out, "wb") as fh:
        fh.write(workbook_bytes(report))
    print(f"Saved {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
