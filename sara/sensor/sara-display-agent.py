#!/usr/bin/env python3
"""SARA display agent - the backlight half of the three states.

Runs on the Pi that HAS the screen (pi-dev). The browser renders `full` and
`clock`; only this can do `locked`, because a page cannot write
/sys/class/backlight - and painting the screen black is not the same thing:
an LCD showing black still glows, still burns power, and still lights a dark
room. Backlight to 0 is genuinely off.

⚠ ON BURN-IN, since it is the obvious worry with a clock on screen all day:
this panel has a real backlight with a 0-31 range, and an OLED has no backlight
at all - so it is an IPS LCD, which does not burn in the way an OLED does. At
worst it gets temporary image persistence. The clock does not need to move.
The backlight is used because it is honest and saves power, not to protect the
panel.

⚠ IT FAILS TOWARDS LIGHT. Every error path - unreachable backend, bad JSON,
a state it does not recognise - restores the backlight. A bug here that fails
dark leaves Nick tapping at a screen that looks broken, with no way to tell
that from a dead Pi; a bug that fails bright is merely a screen that stayed on.
That asymmetry decides every branch below.

The brightness to restore TO is whatever was set at startup, not a hardcoded
number: Nick may have dimmed the panel to suit the room, and a display agent
that resets his brightness every time he walks past is its own small annoyance.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

BACKLIGHT = os.environ.get("SARA_BACKLIGHT", "/sys/class/backlight/panel_backlight@1")
ROOM = os.environ.get("SARA_ROOM", "").strip()
BASE = os.environ.get("SARA_DISPLAY_URL", "").strip()
POLL_S = float(os.environ.get("SARA_DISPLAY_POLL_S", "5"))
# A verdict older than this is not trusted. The backend answers in milliseconds;
# if we cannot reach it at all we light the screen rather than guess.
TIMEOUT_S = float(os.environ.get("SARA_DISPLAY_TIMEOUT_S", "8"))

if not ROOM:
    raise SystemExit("SARA_ROOM is required")
if not BASE:
    raise SystemExit("SARA_DISPLAY_URL is required")


def read_int(path):
    try:
        with open(path) as f:
            return int(f.read().strip())
    except Exception:
        return None


def set_brightness(value):
    try:
        with open(os.path.join(BACKLIGHT, "brightness"), "w") as f:
            f.write(str(int(value)))
        return True
    except Exception as e:
        print("[display] cannot set brightness: " + str(e), flush=True)
        return False


def fetch_state():
    """The backend's verdict, or None if we could not get one."""
    url = BASE + ("&" if "?" in BASE else "?") + "room=" + urllib.parse.quote(ROOM)
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_S) as r:
            d = json.loads(r.read())
        state = d.get("state")
        if state not in ("full", "clock", "locked"):
            # An unrecognised state is a version skew, not a reason to go dark.
            print("[display] unrecognised state " + repr(state) + " - staying lit", flush=True)
            return None
        return d
    except Exception as e:
        print("[display] no verdict (" + str(e) + ") - staying lit", flush=True)
        return None


def main():
    max_b = read_int(os.path.join(BACKLIGHT, "max_brightness")) or 31
    # Whatever Nick had it on when this started is "on".
    on_level = read_int(os.path.join(BACKLIGHT, "brightness"))
    if not on_level:
        on_level = max_b
    print("[display] room=" + ROOM + " on=" + str(on_level) + "/" + str(max_b), flush=True)

    last = None
    while True:
        d = fetch_state()
        # None (unreachable / unparseable / unknown) is treated as lit, never dark.
        state = d.get("state") if d else "clock"

        want = 0 if state == "locked" else on_level
        if state != last:
            note = ""
            if d and d.get("contradiction"):
                note = " [" + d["contradiction"] + "]"
            print("[display] -> " + state + " (backlight " + str(want) + ")" + note, flush=True)
            last = state
        set_brightness(want)
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
