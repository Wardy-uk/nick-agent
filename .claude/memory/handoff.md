# Handoff — SARA room presence (Apple Watch BLE), 31 Aug 2026

## Where this came from

The kiosk's watch presence lock was switched off on 30 Aug for "incorrectly
locking SARA". Nick's spec for the rebuild: **watch seen → SARA fully visible;
watch not seen → just the clock; not in the home geofence → fully locked.** Only
the Pi 4 has a screen, so only it locks. Later he raised the bar: it must
**infer which room he is actually in**, because automation will be built on it.

## The three faults in the old service (all measured)

1. **Wrong room.** pi5 moved next to the router. A seat tuned at -52..-57 in
   June read -65..-76 in August. The tuning was never wrong; the sensor moved.
2. **A rule that could not work at any threshold.** It judged each 0.5s slot
   against one RSSI value and counted a slot with no advert as "far" — but RSSI
   spans 26 dB at a fixed seat and adverts gap by up to 3.8s, so one gap made
   seven "far" samples. The 16 Aug log flips every 5–30s while Nick sits still.
3. **It went deaf on 16 Aug and reported `away` for 15 days.** BlueZ held a
   phantom scan (every new scan `InProgress` while `Discovering: no`) because
   Home Assistant's `bluetooth` integration was stuck in a setup-retry loop on
   the same adapter, taking the radio on each retry. HA's entry is now
   **disabled on pi5** — it needs `bluetoothd --experimental` for passive
   scanning, never had it, and was delivering zero BLE entities.

## What exists now

- `sara/sensor/sara-room-sensor.py` + `.service` — one Pi, one room. Deployed on
  all three, enabled at boot.
- `sara/sensor/sara-display-agent.py` + `.service` — pi-dev only. The only thing
  that can do `locked`, via `/sys/class/backlight/panel_backlight@1`.
- `sara/backend/src/presence/{rooms,store,history,fingerprint,profiles}.js`
  + routes in `src/routes/presence.js`. **133 tests green.**

| Room | Host | Scan | in-room RSSI |
|---|---|---|---|
| living-room | pi-dev (Pi 4) | active | -79 |
| kitchen | pi5 | active | -70 |
| bedroom | pi3 (Pi 3B+) | **passive** | -68 |

## ⚠ The load-bearing findings

- **A scan that hears nothing is `unknown`, never `absent`.** Health = the
  *background* (24–29 devices here). Zero means the radio is deaf, not the house
  empty. Without it a dead sensor and an empty room are one reading — the exact
  15-day failure.
- **`scanner.start()` HANGS rather than raising.** systemd reports `active`, one
  line in the log, nothing wrong anywhere you'd look. Every start is bounded by
  a timeout; recovery cycles the adapter, then restarts bluetoothd.
- **RSSI is NOT comparable between sensors.** pi5 out-read pi-dev by 9 dB with
  Nick sat still in the living room — his watch was on the arm shielded by his
  body, with a clear line to pi5 through one wall. A body costs 5–15 dB, a
  plasterboard wall 3–5. Ranking rooms by raw RSSI measures the hardware and the
  body, not the location.
- **RSSI within ONE sensor separates cleanly** (10–15 dB). That distinction is
  the whole design: never compare across sensors, always within one.
- **Rate was tried as the in-room test and was WRONG.** Looked like a 4× gap on
  four samples; over a real hour, upstairs reached 1.9 against 2.2 downstairs.
- **⚠ In PASSIVE mode rate is INVERTED** — bedroom read -51/0.08 with the watch
  in the room against -86/0.48 with it downstairs. AdvertisementMonitor reports
  found/lost churn, not advert volume. Never use rate on a passive sensor.
- **The Pi 3B+ cannot do WiFi and active BLE at once** (one combo chip, one
  antenna): 4/8 pings active, 20/20 passive, 10/10 with BT off. Passive fixed it
  — but samples ~6% as often. A USB dongle would restore parity if needed.
- **`zone.home` is a 100 m circle centred 90 m from where Nick sits**, so HA
  reports `not_home` while he is at home. He has declined to move it, so the
  **watch refuses a lock that geolocation cannot justify** and says so. A watch
  that cannot be heard does NOT rescue the lock.
- **It tracks the WATCH, not Nick.** Confirmed live: he showered while the watch
  sat in the bedroom and it confidently reported `bedroom` for eight minutes.

## Next — calibration, and it needs Nick

Fingerprinting is **built, tested and deployed but untaught** — no profiles
exist, so `GET /api/presence/room` returns `confidence: none`, which is correct.
Per-sensor RSSI thresholds are the stopgap until it is taught.

```
curl -X POST .../api/presence/calibrate/start -d '{"room":"living-room"}'
#  ~2 min moving about the room, TURNING SEVERAL TIMES (body shadowing)
curl -X POST .../api/presence/calibrate/finish
```

Repeat per room; rooms can be taught days apart. Then compare `inferred.room`
on the display payload against where he actually was **before** handing the
screen over to it.

Also outstanding:
- The kiosk never renders `clock` vs `full` — only the backlight responds, so
  `locked` works and the middle state looks like `full` on screen.
- pi3 has **no Tailscale** (the tailnet `pi3` is a ghost from a previous image);
  it pushes to pi5's LAN address `192.168.1.16`.
- ⚠ The IRK went on a command line once today and is in that session's
  transcript — see `mistakes.md`. Rotating it means re-pairing the watch.
