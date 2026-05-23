#!/usr/bin/env python3
from __future__ import annotations

import sys


def main() -> int:
    allowed_reports = {"business-overview", "store-overview", "member-overview"}
    if len(sys.argv) != 2 or sys.argv[1] not in allowed_reports:
        sys.stderr.write("usage: before-report-signal.py business-overview|store-overview|member-overview\n")
        return 2
    sys.stdout.write(f"QDM_BEFORE_REPORT_SIGNAL {sys.argv[1]}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
