# SARA room sensors — Apple Watch BLE proximity

One Pi, one room. Each sensor answers *"is Nick in THIS room?"* and reports it;
nothing here decides what SARA does about it.

## Why it was rebuilt (31 Aug 2026)

The original `watch-presence-service.py` on pi5 was demoted to unused on 30 Aug
because it "incorrectly locked SARA". Measured, it had **three separate faults**,
and only the first was the one anybody had noticed:

1. **It was in the wrong room.** pi5 moved next to the router. The thresholds had
   been tuned at the desk in June (RSSI -52..-57); from the router the same seat
   reads -65..-76. Nothing was wrong with the tuning — the sensor had moved.

2. **The rule could not work at any threshold.** It marked each 0.5s slot
   near/far against a single RSSI threshold, and counted *a slot with no advert*
   as "far". At Nick's usual seat RSSI spans **-84..-43 without him moving** and
   adverts arrive with gaps of up to **3.8s** — so one silent gap manufactured
   seven consecutive "far" samples. The log for 16 Aug shows it flipping
   present/away every 5-30 seconds while he sat still.

3. **It went deaf on 16 Aug and reported `away` for fifteen days.** BlueZ had a
   phantom scan — every new scan refused with `InProgress` while
   `bluetoothctl` reported `Discovering: no`, surviving both the client dying and
   an `hciconfig down/up`. The culprit was Home Assistant's `bluetooth`
   integration on the same adapter, stuck in a setup-retry loop (it needs
   `bluetoothd --experimental` for passive scanning and does not have it), taking
   the radio on every retry and never giving it back.

## The three rules that came out of that

**A scan that hears nothing is `unknown`, never `absent`.** The health signal is
the *background*: every BLE device in earshot, not just the watch. This house has
24-29 of them chattering ~3700 adverts a minute. Zero means the radio is deaf,
not that the house is empty. Without this rule a dead sensor and an empty room
are the same reading — which is precisely how fifteen days went by.

**Presence is advert RATE over a window, not per-sample RSSI.** The watch either
chatters at you (~2.3/sec in-room) or it does not. RSSI is reported because it is
useful for *comparing rooms*, but it never decides present/absent — it is far too
noisy at a fixed distance to be a trigger.

**A hang counts as stuck.** `scanner.start()` does not always raise; on pi5 at 49
days uptime it simply never returned, and systemd reported the unit `active` with
one line in the log. Every start is bounded by a timeout, and recovery escalates:
cycle the adapter, then restart `bluetoothd`.

## Deploying another room

```bash
# On the Pi:
sudo rfkill unblock bluetooth && sudo hciconfig hci0 up
python3 -m venv ~/watch-irk/venv
~/watch-irk/venv/bin/pip install bleak bluetooth_data_tools aiohttp
# copy sara-room-sensor.py to ~/watch-irk/

# The IRK, root-only, never on a command line:
sudo install -m 600 -o root -g root /dev/null /etc/sara-watch.env
sudo tee /etc/sara-watch.env <<< 'WATCH_IRK=<hex>'   # from a secure copy

echo 'SARA_ROOM=bedroom' | sudo tee /etc/sara-room.env
sudo install -m 644 sara-room-sensor.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sara-room-sensor
```

Verify with `sudo cat /run/sara-room-sensor.json`. `healthy: true` with a
plausible `backgroundDevices` count is the check that matters — a sensor
reporting `absent` with `backgroundDevices: 0` is broken, not lonely.

## The Pi 3B+ needs passive scanning (31 Aug 2026)

The Pi 3B+ runs WiFi and Bluetooth through **one combo chip on one antenna**, and
an active scan transmits a scan request for every advert it hears. Measured:

```
active  scan running:  4/8  pings   (~50% packet loss — scp failed outright)
passive scan running: 20/20 pings   (clean)
bluetooth off:        10/10 pings
```

The Pi 4 and Pi 5 have far better coexistence and are unaffected, so passive is
opt-in per sensor via `SARA_SCAN_MODE=passive`, and needs `bluetoothd
--experimental` on that host (a drop-in at
`/etc/systemd/system/bluetooth.service.d/experimental.conf`).

⚠ **Passive is not just a quieter active scan — it samples far less.** BlueZ
passive scanning with patterns goes through the AdvertisementMonitor API, which
reports found/lost events plus periodic RSSI samples rather than a raw advert
stream. Measured over the same spot with the watch present:

```
active   adverts=2407  devices=26  watch=80  rate=2.00/s  rssi_med=-67
passive  adverts=24    devices=18  watch=5   rate=0.12/s  rssi_med=-66
```

Same RSSI, **6% of the callbacks**. So a passive sensor needs its own
`SARA_MIN_RATE` (0.05) and a longer `SARA_WINDOW_S` (60) to gather enough
samples. `passive-probe.py` runs both modes back to back over one spot and is
the thing to reach for before blaming distance.

⚠ The filter is NOT the reason for the reduction, and this was checked rather
than assumed: every one of 59 consecutive watch adverts carried Apple
manufacturer data (`0x004C`, an Apple Continuity Nearby Info message), so the
`or_patterns` match all of them. Do not go hunting for a better pattern.

⚠ **A passive room's RSSI median rests on a handful of samples where an active
room's rests on forty**, so cross-mode comparison in the arbitration is less
sure than like-for-like. It works here because the gaps between rooms are large
(-84 from the bedroom against -71 in the living room), but a USB Bluetooth
dongle on the Pi 3 would restore parity and remove the caveat.

## Deployed

| Room | Host | Scan | Notes |
|---|---|---|---|
| living-room | pi-dev (Pi 4) | active | also the kiosk display + the backlight agent |
| kitchen | pi5 | active | HA's `bluetooth` integration disabled here to free the radio |
| bedroom | pi3 (Pi 3B+) | **passive** | LAN only — no Tailscale, so it pushes to pi5's `192.168.1.16` |

## Room inference (fingerprinting)

Ranking rooms by RSSI does not work, and it failed twice on the day it was
built. `sara/backend/src/presence/fingerprint.js` replaces it: a room is
identified by the WHOLE PATTERN across every sensor, so "the kitchen hears me
9 dB louder than the living room does" stops being an error and becomes part of
what the living room LOOKS like. A constant hardware offset appears in every
profile and cancels; body shadowing is learned if calibration spans a few
orientations.

Calibrate a room by standing in it for ~2 minutes, **turning round several
times** — that is what teaches it the watch being on the shielded arm:

```bash
curl -X POST http://100.100.28.58:3005/api/presence/calibrate/start \
     -H 'Content-Type: application/json' -d '{"room":"living-room"}'
# ... move about, turn, sit, stand ...
curl -X POST http://100.100.28.58:3005/api/presence/calibrate/finish
```

Profiles persist to disk. A run under 10 samples is REFUSED rather than saved:
near-zero deviation makes one sensor overwhelming and produces confident
nonsense.

`GET /api/presence/room` is what automation should read — `sure` / `unsure` /
`none`, with every candidate's score. `GET /api/presence/history` records every
room change **with the RSSI of every room at that moment**, because a switch at
15 dB and one at 1 dB are indistinguishable afterwards if only the winner is
kept.
