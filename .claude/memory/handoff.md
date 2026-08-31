# Handoff — SARA room presence (Apple Watch BLE), 31 Aug 2026

## Where this came from

The kiosk's watch presence lock was switched off on 30 Aug for "incorrectly
locking SARA". Nick's spec for the rebuild: **watch seen → SARA fully visible;
watch not seen → just the clock; not in the home geofence → fully locked.** Only
the Pi 4 has a screen, so only it locks. He then raised the bar twice: it must
**infer which room he is actually in** ("as we build more automation around
NEURO, that will become more important"), and it must show **At Work** when he
is at the office.

## The state at the end of the day

| Room | Host | Scan | Notes |
|---|---|---|---|
| living-room | pi-dev (Pi 4) | active | the kiosk screen + the backlight agent |
| kitchen | pi5 | active | HA's `bluetooth` integration DISABLED here to free the radio |
| bedroom | pi3 (Pi 3B+) | **passive** | tailnet as `pi3-1` |

All three calibrated (152 / 159 / 165 samples, every sensor in every profile).
Verified on a walk bedroom → kitchen → living room: tracked every leg, then held
`living-room / sure` for sixteen consecutive polls at 0.36–0.83 against 3.1 and
4.5.

**Surfaces:** Pi 4 kiosk (full/clock/locked), NEURO topbar chip, VESTA for
helen/isaac/test. NEURO backend 1916 tests green; sara/backend 138.

## ⚠ The findings, in the order they cost time

**A scan that hears nothing is `unknown`, never `absent`.** Health is the
*background* (24–29 devices here). Zero means the radio is deaf, not the house
empty. Without it a dead sensor and an empty room are one reading — the exact
15-day failure below.

**The 15-day blackout was Home Assistant.** BlueZ held a phantom scan (every new
scan `InProgress` while `Discovering: no`) because HA's `bluetooth` integration
was stuck in a setup-retry loop on pi5's adapter, taking the radio on each retry.
It needs `bluetoothd --experimental` for passive scanning, never had it, and was
delivering zero BLE entities. Disabled.

**`scanner.start()` HANGS rather than raising.** systemd reports `active`, one
line in the log, nothing wrong anywhere you'd look. Starts are bounded by a
timeout; recovery cycles the adapter, then restarts bluetoothd.

**⚠ RSSI is NOT comparable between sensors.** pi5 out-read pi-dev by 9 dB with
Nick sat still in the living room — his watch was on the arm shielded by his own
body, with a clear line to pi5 through one wall. A body costs 5–15 dB, a
plasterboard wall 3–5. Ranking rooms by raw RSSI measures the hardware and the
body, not the location.

**⚠ RSSI within ONE sensor separates cleanly** (10–15 dB). That distinction is
the whole design: never compare across sensors, always within one.

**⚠ Rate was tried twice as the in-room test and was wrong both times.** Looked
like a 4× gap on four samples; over a real hour, upstairs reached 1.9 against 2.2
downstairs. And **in PASSIVE mode rate is INVERTED** — bedroom read -51/0.08 with
the watch in the room against -86/0.48 with it downstairs, because
AdvertisementMonitor reports found/lost churn, not advert volume. Never use rate
on a passive sensor.

**The Pi 3B+ cannot do WiFi and active BLE at once** (one combo chip, one
antenna): 4/8 pings active, 20/20 passive, 10/10 with BT off. Passive fixed it,
but samples ~6% as often. A USB dongle would restore parity if it ever misbehaves.

**⚠ `zone.home` is a 100 m circle centred 90 m from where Nick sits**, so HA
reports `not_home` while he is at home. He declined to move it. Consequences,
both load-bearing: the **watch refuses a lock that geolocation cannot justify**
(and a watch that cannot be *heard* does NOT rescue it — "audible somewhere" is
too weak, caught the moment he left the house), and **`home`/`not_home` render
NOTHING anywhere**. A *named* zone is trusted — the office one is 150 m wide and
twenty miles away.

**⚠ It tracks the WATCH, not Nick.** Confirmed live: he showered while the watch
sat in the bedroom and it reported `bedroom` confidently for eight minutes.
`subject: 'watch'` travels with every reading so nothing can quietly promote it.

## The architecture, and why

`sara/backend` holds the sensors, the fingerprint profiles and the
classification. **NEURO reads it as a SENSOR FEED, never a second opinion** —
that distinction is what `sara/backend/src/state/inference.js` was retired for.
SARA measures, NEURO reasons.

- `sara/sensor/sara-room-sensor.py` — one Pi, one room. `SARA_SCAN_MODE`,
  `SARA_IN_ROOM_RSSI` per sensor.
- `sara/sensor/sara-display-agent.py` — pi-dev only, the only thing that can do
  `locked` (a page cannot write `/sys/class/backlight`, and painting black is
  not off). **Fails towards LIGHT** on every error path.
- `sara/backend/src/presence/{rooms,store,history,fingerprint,profiles}.js`
- `backend/services/{room-presence,whereabouts}.js` — NEURO's readers.

**Fingerprint beats threshold only when `sure`**; `unsure`/`none` fall back to
the per-sensor RSSI threshold, so an uncalibrated house behaves as before.
`decidedBy` (fingerprint/threshold/ranking) rides on the payload.

## Deployment traps

- **⚠ VESTA does NOT auto-deploy from git.** Directory upload, not linked to the
  repo — a push to main deploys nothing. Use the Netlify MCP `deploy-site`
  command from `vesta/`. I got this wrong once today and said otherwise.
- sara/frontend is built ON pi5 and served by `sara-backend`; the Pi 4 is only a
  browser pointed at `100.100.28.58:3005`.
- Nick runs 2–3 Claude sessions on this repo. `server.js` is often held open —
  the room endpoint was hung off `routes/signals.js` for that reason. Expect
  push rejections and rebase.

## Next

1. **"At Work" is UNTESTED** — nobody has been to the office since it existed.
   First workday is its first real run.
2. **The bedroom profile was taught in the evening.** If it misbehaves at night,
   re-run that calibration.
3. **Delete the ghost `pi3` node** in the Tailscale admin console, then rename
   `pi3-1` → `pi3`.
4. **Nick has no VESTA account** — he said he would create his own.
5. ⚠ The IRK went on a command line once today and is in that session's
   transcript — see `mistakes.md`. Rotating it means re-pairing the watch.
