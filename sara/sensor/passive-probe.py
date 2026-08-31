#!/usr/bin/env python3
"""Does a PASSIVE scan still hear the watch, and still hear the background?

Answers the one question that decides whether the Pi 3B+ can be a sensor at all:
passive scanning is what stops BLE wrecking that Pi's WiFi, but it is useless if
the advertisement-data filter it requires happens to exclude the Apple Watch.

Run it where the watch demonstrably IS, so `not heard` means the filter, never
distance. Prints both modes back to back over the same spot.
"""

import asyncio
import os
import statistics
import sys
import time

from bleak import BleakScanner
from bleak.args.bluez import BlueZScannerArgs, OrPattern
from bleak.assigned_numbers import AdvertisementDataType
from bluetooth_data_tools import get_cipher_for_irk, resolve_private_address

IRK = bytes.fromhex(os.environ["WATCH_IRK"].strip())
SECONDS = float(sys.argv[1]) if len(sys.argv) > 1 else 45

PATTERNS = [
    OrPattern(0, AdvertisementDataType.FLAGS, b"\x02"),
    OrPattern(0, AdvertisementDataType.FLAGS, b"\x06"),
    OrPattern(0, AdvertisementDataType.FLAGS, b"\x1a"),
    OrPattern(0, AdvertisementDataType.MANUFACTURER_SPECIFIC_DATA, b"\x4c\x00"),
]


async def run(mode):
    tot = {"n": 0}
    addrs = set()
    rssi = []

    def cb(d, a):
        tot["n"] += 1
        addrs.add(d.address)
        try:
            if resolve_private_address(get_cipher_for_irk(IRK), d.address):
                rssi.append(a.rssi)
        except Exception:
            pass

    if mode == "passive":
        s = BleakScanner(cb, scanning_mode="passive", bluez=BlueZScannerArgs(or_patterns=PATTERNS))
    else:
        s = BleakScanner(cb)

    await s.start()
    await asyncio.sleep(SECONDS)
    await s.stop()

    print("%-8s adverts=%-6d devices=%-3d watch=%-4d rate=%.2f/s rssi_med=%s" % (
        mode, tot["n"], len(addrs), len(rssi), len(rssi) / SECONDS,
        int(statistics.median(rssi)) if rssi else "none"))
    return len(rssi)


async def main():
    active = await run("active")
    await asyncio.sleep(3)
    passive = await run("passive")
    print()
    if passive == 0 and active > 0:
        print("VERDICT: passive hears the background but NOT the watch — the filter excludes it.")
    elif passive > 0:
        print("VERDICT: passive hears the watch. Usable on the Pi 3.")
    else:
        print("VERDICT: neither mode heard the watch — it is out of range, test again nearer.")


asyncio.run(main())
