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

## Deployed

| Room | Host | Notes |
|---|---|---|
| living-room | pi-dev (Pi 4) | also the kiosk display |
| kitchen | pi5 | HA's `bluetooth` integration disabled here to free the radio |
| bedroom | Pi 3 | not yet deployed |
