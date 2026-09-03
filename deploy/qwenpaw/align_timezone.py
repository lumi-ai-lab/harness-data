#!/usr/bin/env python3
"""Align QwenPaw's stored user_timezone with the container's TZ.

Only replaces values that were never explicitly chosen (empty or the UTC
defaults produced by `qwenpaw init` in an unset-TZ image), so a timezone set
through the config API is preserved across restarts. config.json keeps its
exact formatting: it is rewritten with the same serialisation QwenPaw itself
uses, and the file is left untouched whenever that cannot be proven.
"""

from __future__ import annotations

import json
import re
import sys
from zoneinfo import ZoneInfo

# Values `detect_system_timezone()` yields when it finds nothing better.
UNTUNED = {"", "UTC", "Etc/UTC", "GMT", "Etc/GMT"}

KEY_RE = re.compile(r'"user_timezone"\s*:\s*("(?:[^"\\]|\\.)*"|null)')


def rewrite(path: str, raw: str, config: dict, wanted: str) -> bool:
    """Write `wanted` into config.json; return whether the file changed."""
    if json.dumps(json.loads(raw), indent=2, ensure_ascii=False) == raw:
        # The file is exactly QwenPaw's own serialisation, so re-dumping the
        # patched document changes nothing but the value.
        config["user_timezone"] = wanted
        updated = json.dumps(config, indent=2, ensure_ascii=False)
    else:
        # Unknown formatting (indent, key order or trailing newline). Substitute
        # the value in place, and refuse to guess when the key is ambiguous.
        matches = list(KEY_RE.finditer(raw))
        if len(matches) != 1:
            print(
                f"warning: {len(matches)} user_timezone keys in {path}, not editing",
                file=sys.stderr,
            )
            return False
        match = matches[0]
        value = match.group(0)
        updated = (
            raw[: match.start()]
            + value[: value.index(":", 1) + 1]
            + ' "'
            + wanted
            + '"'
            + raw[match.end() :]
        )
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(updated)
    return True


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(f"usage: {argv[0]} <config.json> <iana-timezone>", file=sys.stderr)
        return 2

    path, wanted = argv[1], argv[2]
    try:
        ZoneInfo(wanted)
    except Exception:
        print(f"warning: ignoring invalid TZ={wanted!r}", file=sys.stderr)
        return 0

    try:
        with open(path, encoding="utf-8") as handle:
            raw = handle.read()
    except OSError as error:
        print(f"warning: cannot read {path}: {error}", file=sys.stderr)
        return 0

    try:
        config = json.loads(raw)
    except ValueError:
        # QwenPaw itself will report a broken config; do not mask that here.
        print(f"warning: {path} is not valid JSON", file=sys.stderr)
        return 0

    if not isinstance(config, dict):
        print(f"warning: {path} has no object at its root", file=sys.stderr)
        return 0

    current = config.get("user_timezone")
    if current is None:
        current = ""
    elif not isinstance(current, str):
        print("warning: user_timezone is not a string, keeping it", file=sys.stderr)
        return 0
    current = current.strip()

    if current and current not in UNTUNED:
        return 0
    if current == wanted:
        return 0

    try:
        if not rewrite(path, raw, config, wanted):
            return 0
    except OSError as error:
        print(f"warning: cannot write {path}: {error}", file=sys.stderr)
        return 0

    print(f"user_timezone: {current or '<unset>'} -> {wanted}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
