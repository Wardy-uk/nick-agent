#!/usr/bin/env python3
"""SARA room sensor - one Pi, one room, passive Apple Watch BLE proximity.

Replaces the single-threshold `watch-presence-service.py`. Three things changed,
each of them a bug that actually bit (31 Aug 2026):

1. A SCAN THAT HEARS NOTHING IS `unknown`, NEVER `away`.
   The old service reported `away` every few seconds for FIFTEEN DAYS from a
   scan that had silently stopped delivering, and nothing noticed - a dead
   sensor and an empty room read identically. So the health signal is the
   background: `backgroundAdverts` counts EVERY device, not just the watch. A
   household has two dozen BLE devices chattering; zero of them means the radio
   is deaf, not that the house is empty. This is `ambient.standStillness` using
   heartRate to tell "sitting" from "watch on charge", one floor down.

2. PRESENCE IS RATE OVER A WINDOW, NOT A PER-SAMPLE THRESHOLD.
   Measured at Nick's usual seat, 2m from the Pi: RSSI spans -84..-43, a 26 dB
   spread WITHOUT MOVING, and adverts arrive with gaps of up to 3.8s. The old
   rule marked each 0.5s slot near/far against one threshold and counted a slot
   with no advert as "far" - so a single silent gap manufactured seven "far"
   samples and the state flapped present/away every few seconds while he sat
   still. No threshold can fix that rule; the rule is what is wrong. A rate and
   a median over a 20s window are stable against both the spread and the gaps.

3. THE ADAPTER GETS STUCK, SO THE SENSOR RESETS IT - AND A HANG COUNTS AS STUCK.
   BlueZ can end up refusing every new scan with `InProgress` while reporting
   `Discovering: no` - a phantom scan that survives the client dying AND an
   `hciconfig down/up`. Worse, and seen on pi5 at 49 days uptime: `start()` does
   not always raise, it simply NEVER RETURNS. systemd then reports the unit
   `active`, the log stops after one line, and nothing is wrong anywhere you
   would look. So the start is bounded by a timeout - an unbounded await is the
   same silent death in a new costume - and recovery ESCALATES: cycle the
   adapter first, restart bluetoothd if that was not enough.

The IRK is read from the environment, which systemd fills from a ROOT-ONLY
EnvironmentFile. Never pass it on a command line: argv is world-readable through
/proc, so `sudo env WATCH_IRK=... python ...` leaks the key to every user.

Reports are PUSHED. A pull would make an unreachable Pi look exactly like an
absent watch, which is the whole failure above wearing a different hat; pushed,
silence ages into staleness and the consumer can see it.
"""

import asyncio
import json
import os
import statistics
import time
from collections import deque
from datetime import datetime, timezone

import aiohttp
from bleak import BleakScanner
from bluetooth_data_tools import get_cipher_for_irk, resolve_private_address

# Passive scanning, for the Pi 3B+ only.
#
# ⚠ WHY IT EXISTS: the Pi 3B+ runs WiFi and Bluetooth through ONE combo chip on
# ONE antenna. Measured 31 Aug 2026: with Bluetooth up it dropped to 4/8 pings;
# with Bluetooth down, 10/10. The Pi 4 and Pi 5 have far better coexistence and
# are unaffected, so this is opt-in per sensor rather than the default.
#
# An ACTIVE scan transmits a scan request for every advert it hears, and on a
# shared antenna that transmission is what wrecks the WiFi. Passive is
# receive-only. We lose scan-response data and never used it: the IRK is
# resolved from the advertising ADDRESS, and RSSI comes with the advert.
#
# ⚠ BlueZ passive scanning requires `--experimental` AND at least one
# advertisement-data pattern - bleak will not start a passive scan with an empty
# filter. So the patterns below must be broad enough to keep hearing the
# BACKGROUND, not just the watch: the background is the health signal that tells
# a deaf radio from an empty room, and narrowing it to Apple would quietly
# destroy that check while appearing to work.
try:
    from bleak.args.bluez import BlueZScannerArgs, OrPattern
    from bleak.assigned_numbers import AdvertisementDataType
    PASSIVE_AVAILABLE = True
except Exception:  # older bleak
    PASSIVE_AVAILABLE = False

IRK_HEX = os.environ.get("WATCH_IRK", "").strip()
if not IRK_HEX:
    raise SystemExit("WATCH_IRK is required (root-only EnvironmentFile, never argv)")
IRK = bytes.fromhex(IRK_HEX)

ROOM = os.environ.get("SARA_ROOM", "").strip()
if not ROOM:
    raise SystemExit("SARA_ROOM is required - a sensor with no room cannot be placed")

# Where to push. Unset is allowed: the sensor still writes its local status file,
# so a Pi can be proven on the bench before it has anywhere to report to.
PUSH_URL = os.environ.get("SARA_SENSOR_URL", "").strip()
PUSH_TOKEN = os.environ.get("SARA_SENSOR_TOKEN", "").strip()

STATUS_FILE = os.environ.get("SARA_SENSOR_STATUS_FILE", "/run/sara-room-sensor.json")
WINDOW_S = float(os.environ.get("SARA_WINDOW_S", "20"))       # presence memory
REPORT_S = float(os.environ.get("SARA_REPORT_S", "3"))        # how often we speak
# Below this rate the watch is not considered heard at all. Measured: 2.3-2.4/sec
# at the desk; a distant room gives a trickle. 0.2/s = 4 adverts in a 20s window,
# comfortably above noise and far below anything seen in-room.
MIN_RATE = float(os.environ.get("SARA_MIN_RATE", "0.2"))
# Is he in THIS room, as opposed to merely audible from it?
#
# ⚠ PER SENSOR, AND THAT IS THE WHOLE POINT. The first design compared rooms by
# RSSI and picked the loudest, which silently compared a Pi 4's radio with a Pi
# 5's THROUGH NICK'S BODY: measured 31 Aug 2026, sat still in the living room
# with the watch on the arm shielded from the Pi 4 and a clear line to the Pi 5,
# the KITCHEN read 9 dB stronger and took the room. A body attenuates 2.4 GHz by
# 5-15 dB and a plasterboard wall by 3-5, so his own arm outweighed a wall.
# Nothing here compares rooms; each sensor answers only about its own.
#
# ⚠ THE TEST IS RSSI, AND RATE WAS TRIED FIRST AND WAS WRONG. On four samples
# rate looked like a clean 4x separation; over a real hour of Nick moving around
# the house it was not:
#   living-room rate, him UPSTAIRS    0.4 0.8 0.9 1.05 1.25 1.55 1.65 1.9
#   living-room rate, him DOWNSTAIRS  2.2 2.25 2.35 2.45 2.65
# 1.9 against 2.2 is not a gap, and the screen flapped four times across it.
#
# ⚠ WORSE, IN PASSIVE MODE RATE IS INVERTED. The bedroom sensor:
#   watch IN the bedroom   -51/0.08  -53/0.03  -58/0.05  -62/0.03
#   watch downstairs       -80/0.25  -85/0.25  -86/0.48  -71/0.35
# Nearer gives FEWER callbacks, because AdvertisementMonitor reports found/lost
# churn rather than advert volume: a marginal device flaps and generates events,
# a strong one is found once and goes quiet. Rate there is not weak, it is
# backwards.
#
# RSSI within ONE sensor separates cleanly, which is the distinction that
# matters - it is only comparison BETWEEN sensors that is invalid (different
# radios, and a body in the way):
#   living-room sensor  downstairs -62..-74   upstairs -84..-88   (10 dB)
#   bedroom sensor      upstairs   -51..-65   downstairs -80..-86 (15 dB)
#
# So: per sensor, measured from that sensor's own readings. The default errs
# towards saying he IS here, which shows the screen rather than hiding it.
IN_ROOM_RSSI = float(os.environ.get("SARA_IN_ROOM_RSSI", "-80"))
# Health: the background must be audible. Measured: 24-27 distinct devices and
# ~3700 adverts per minute in this house.
HEALTH_WINDOW_S = float(os.environ.get("SARA_HEALTH_WINDOW_S", "45"))
# "active" (default) or "passive" — see the block above. Only the Pi 3B+ needs
# passive; asking for it where bleak cannot do it is a hard failure rather than a
# silent downgrade, because a sensor quietly running active on a Pi 3 takes the
# WiFi down and looks like a network fault.
SCAN_MODE = os.environ.get("SARA_SCAN_MODE", "active").strip().lower()
if SCAN_MODE == "passive" and not PASSIVE_AVAILABLE:
    raise SystemExit("SARA_SCAN_MODE=passive needs a bleak with BlueZ passive support")

# A scan start that has not returned in this long is wedged, not slow.
START_TIMEOUT_S = float(os.environ.get("SARA_START_TIMEOUT_S", "30"))
# Consecutive failed starts before escalating from an adapter cycle to a
# bluetoothd restart.
HARD_RESET_AFTER = int(os.environ.get("SARA_HARD_RESET_AFTER", "2"))


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class Sensor:
    def __init__(self):
        self.watch = deque()       # (monotonic, rssi)
        self.background = deque()  # monotonic, ANY device
        self.addresses = {}        # address -> last seen, for a distinct count
        self.last_watch_at = None
        self.started = time.monotonic()
        self.resets = 0

    def on_advert(self, device, adv):
        t = time.monotonic()
        self.background.append(t)
        self.addresses[device.address] = t
        try:
            if resolve_private_address(get_cipher_for_irk(IRK), device.address):
                self.watch.append((t, adv.rssi))
                self.last_watch_at = t
        except Exception:
            pass

    def _trim(self, t):
        while self.watch and t - self.watch[0][0] > WINDOW_S:
            self.watch.popleft()
        while self.background and t - self.background[0] > HEALTH_WINDOW_S:
            self.background.popleft()
        for addr, seen in list(self.addresses.items()):
            if t - seen > HEALTH_WINDOW_S:
                del self.addresses[addr]

    def reading(self):
        """The whole judgement, as data. No boolean invented out of silence."""
        t = time.monotonic()
        self._trim(t)

        warming = (t - self.started) < WINDOW_S
        healthy = len(self.background) > 0
        rssis = [r for _, r in self.watch]
        rate = len(rssis) / WINDOW_S

        if not healthy:
            # The load-bearing line. Deaf is not empty.
            status = "unknown"
            why = "no BLE traffic at all - the radio is deaf, not the room empty"
        elif warming:
            status = "unknown"
            why = "still filling the first window"
        elif rate >= MIN_RATE:
            status = "present"
            why = None
        else:
            status = "absent"
            why = None

        # Heard at all, and heard NEAR, are different questions. `status` answers
        # the first (is the watch within earshot of this Pi); `inRoom` answers the
        # one a screen in this room actually cares about. Null when unknown -
        # never False, which would read as "he is not here" on a deaf radio.
        median = int(statistics.median(rssis)) if rssis else None
        # ⚠ Null ONLY when the radio could not answer. A HEALTHY sensor hearing
        # nothing is a real answer — "he is not in this room" — not an absence
        # of one, and returning null there makes the screen fall back to the
        # cross-room ranking exactly when its own sensor has the better
        # information. Deaf (`unknown`) is the only genuine "I could not tell".
        if status == "unknown":
            in_room = None
        else:
            in_room = median is not None and median >= IN_ROOM_RSSI

        return {
            "room": ROOM,
            "status": status,                      # present | absent | unknown
            "inRoom": in_room,                     # true | false | null
            "inRoomRssi": IN_ROOM_RSSI,
            "why": why,
            "healthy": healthy,
            "rate": round(rate, 2),
            "adverts": len(rssis),
            "rssiMedian": median,
            "rssiMax": max(rssis) if rssis else None,
            "backgroundAdverts": len(self.background),
            "backgroundDevices": len(self.addresses),
            "lastSeenS": round(t - self.last_watch_at, 1) if self.last_watch_at else None,
            "windowS": WINDOW_S,
            "resets": self.resets,
            "at": now_iso(),
        }


def write_status(reading):
    tmp = STATUS_FILE + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(reading, f)
        os.replace(tmp, STATUS_FILE)
    except Exception as e:
        print("[sensor] status write failed: " + str(e), flush=True)


async def push(session, reading):
    if not PUSH_URL:
        return
    headers = {"Content-Type": "application/json"}
    if PUSH_TOKEN:
        headers["X-Sara-Sensor-Token"] = PUSH_TOKEN
    try:
        async with session.post(PUSH_URL, json=reading, headers=headers,
                                timeout=aiohttp.ClientTimeout(total=5)) as r:
            if r.status >= 400:
                print("[sensor] push rejected " + str(r.status), flush=True)
    except Exception as e:
        # A consumer that cannot be reached must never stop the sensor. Its
        # silence becomes staleness at the other end, which is visible there.
        print("[sensor] push failed: " + str(e), flush=True)


async def _run(cmd):
    p = await asyncio.create_subprocess_shell(cmd)
    await p.wait()


async def reset_adapter(hard=False):
    """BlueZ wedges. Cycle the adapter; if that was not enough, restart the daemon.

    Escalation is deliberate. An adapter cycle is cheap and usually sufficient,
    but a phantom scan can outlive it - proven on pi5, where only a bluetoothd
    restart cleared it. Going straight to the daemon restart every time would
    take the radio away from anything else on the box for no reason.
    """
    for cmd in ("hciconfig hci0 down", "hciconfig hci0 up"):
        await _run(cmd)
        await asyncio.sleep(2)
    if hard:
        print("[sensor] adapter cycle was not enough - restarting bluetoothd", flush=True)
        await _run("systemctl restart bluetooth")
        await asyncio.sleep(6)
        await _run("hciconfig hci0 up")
        await asyncio.sleep(3)


def build_scanner(on_advert):
    if SCAN_MODE != "passive":
        return BleakScanner(on_advert)
    # Broad on purpose. Flags is the one AD type almost every advertiser emits,
    # and matching its common values keeps the whole background audible; the
    # Apple manufacturer id is added so the watch is caught even in the sweep
    # where it omits Flags.
    patterns = [
        OrPattern(0, AdvertisementDataType.FLAGS, b"\x02"),
        OrPattern(0, AdvertisementDataType.FLAGS, b"\x06"),
        OrPattern(0, AdvertisementDataType.FLAGS, b"\x1a"),
        OrPattern(0, AdvertisementDataType.MANUFACTURER_SPECIFIC_DATA, b"\x4c\x00"),
    ]
    return BleakScanner(on_advert, scanning_mode="passive",
                        bluez=BlueZScannerArgs(or_patterns=patterns))


async def main():
    sensor = Sensor()
    last_state = None
    failures = 0
    print("[sensor] scan mode: " + SCAN_MODE, flush=True)
    async with aiohttp.ClientSession() as session:
        while True:
            scanner = build_scanner(sensor.on_advert)
            try:
                # Bounded: `start()` has been observed to hang forever rather
                # than raise, which systemd reports as a perfectly healthy unit.
                await asyncio.wait_for(scanner.start(), timeout=START_TIMEOUT_S)
                failures = 0
            except Exception as e:
                failures += 1
                why = ("scan start timed out after %gs" % START_TIMEOUT_S
                       if isinstance(e, asyncio.TimeoutError)
                       else "scan start failed: " + str(e))
                print("[sensor] " + why + " (attempt " + str(failures) + ")", flush=True)
                sensor.resets += 1
                stuck = sensor.reading()
                stuck["status"] = "unknown"
                stuck["why"] = why
                write_status(stuck)
                await push(session, stuck)
                try:
                    await asyncio.wait_for(scanner.stop(), timeout=5)
                except Exception:
                    pass
                await reset_adapter(hard=failures >= HARD_RESET_AFTER)
                await asyncio.sleep(5)
                continue

            sensor.started = time.monotonic()
            print("[sensor] scanning for room '" + ROOM + "'", flush=True)
            deaf_since = None
            try:
                while True:
                    await asyncio.sleep(REPORT_S)
                    reading = sensor.reading()
                    write_status(reading)
                    await push(session, reading)

                    if reading["status"] != last_state:
                        print("[sensor] -> " + reading["status"]
                              + " (rate=" + str(reading["rate"]) + "/s"
                              + " rssi=" + str(reading["rssiMedian"])
                              + " bg=" + str(reading["backgroundDevices"]) + " devices)", flush=True)
                        last_state = reading["status"]

                    # Watchdog: a healthy house is never silent.
                    if reading["healthy"]:
                        deaf_since = None
                    else:
                        deaf_since = deaf_since or time.monotonic()
                        if time.monotonic() - deaf_since > HEALTH_WINDOW_S:
                            print("[sensor] deaf - restarting scan", flush=True)
                            sensor.resets += 1
                            raise RuntimeError("deaf")
            except RuntimeError:
                try:
                    await scanner.stop()
                except Exception:
                    pass
                await reset_adapter()
            except Exception as e:
                print("[sensor] scan loop error: " + str(e), flush=True)
                try:
                    await scanner.stop()
                except Exception:
                    pass
                await asyncio.sleep(5)


if __name__ == "__main__":
    asyncio.run(main())
