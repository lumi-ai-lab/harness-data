#!/usr/bin/env python3
from __future__ import annotations

import sys


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] != "business-overview":
        sys.stderr.write("usage: before-report-signal.py business-overview\n")
        return 2
    sys.stdout.write("QDM_BEFORE_REPORT_SIGNAL business-overview\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
