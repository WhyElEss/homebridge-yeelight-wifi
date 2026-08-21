# Homebridge YeeLight Wi-Fi

[Homebridge](https://github.com/homebridge/homebridge) plugin for [YeeLight](https://www.yeelight.com) Wi-Fi lighting devices — bulbs, strips, ceiling lights, bedside lamps — exposing them to [HomeKit](https://www.apple.com/ios/home) and Siri.

Implements the [Yeelight WiFi Light Inter-Operation Specification](https://www.yeelight.com/download/Yeelight_Inter-Operation_Spec.pdf).

> **This is a fork of [vieira/homebridge-yeelight-wifi](https://github.com/vieira/homebridge-yeelight-wifi).** Upstream has had no functional changes since January 2025 and does not carry the fixes below. It is not published to npm — install it from GitHub.

## Why this fork exists

Lamps would go dead in the middle of an automation. Not offline — the plugin polled them happily for hours — but at the moment a scene fired, a lamp would blink and refuse to light, and stay that way until it was physically unplugged for a few seconds.

The cause was the plugin talking faster than the firmware allows. Every lamp has a hard budget in the specification: at most **4 simultaneous TCP connections**, **60 commands per minute** on each, and **144 per minute** in total. Past that, the firmware closes the connection.

Three things stacked up to blow through it:

1. **The retry timeout was shorter than the lamp.** The default was 100 ms. Measured against real hardware, a cold TCP handshake alone takes **79–155 ms**, and a `get_prop` round-trip averages **~90 ms** and peaks at **163 ms**. The first attempt could not succeed — not on a bad day, but by construction.
2. **Every retry re-wrote the same command to the same socket** instead of waiting longer, on a ladder of 100/200/400/800/1600/3200 ms — six writes and 6.3 s per command.
3. **A scene sent the same command twice.** HomeKit writes `On`, `Brightness` and `ColorTemperature` as separate calls in the same instant. Brightness and ColorTemperature each awaited `setPower(true)` first, and both read the cached power state before either had updated it, so both sent `set_power`.

Together, one scene reached as many as two dozen writes per lamp within six seconds — roughly 240 commands/minute against a budget of 60. The lamp's answer is visible in the log, always exactly one backoff ladder after the burst:

```
20:18:47  set_power on ×6, set_bright ×2, set_ct_abx ×3     <- one scene, three lamps
20:18:53  0x...53de61: failed to send cmd 80 after 5 retries.
20:18:53  0x...53de61: failed to send cmd 81 after 5 retries.
20:18:53  192.168.2.217 closed. error? false.               <- a clean FIN: the lamp hung up
```

### What it costs now

Measured end to end, with the real plugin code driving a real lamp:

| Metric | Before | After |
| --- | --- | --- |
| Commands on the wire for one scene | as many as **24** writes over 6.3s | **1** |
| Time to apply | up to 6.3 s, then failure | **195 ms** |
| Duplicate `set_power` per scene | 2 per lamp | none, by construction |
| Cost of a lost command | 6 writes to the same socket | 1 retry on a fresh connection |

```
wire: [["set_scene",["ct",2703,20]]]
commands on wire: 1
lamp after: [ 'on', '20', '2703', '2' ]
```

## What changed

**Staying inside the lamp's budget**

- **Coalescing.** Characteristic writes landing within `coalesce` ms are merged into a single desired state. Waking a lamp is now one `set_scene` carrying power, colour and brightness together, instead of `set_power` + `set_ct_abx` + `set_bright`. The duplicate `set_power` is gone by construction, rather than by a check-then-act that never held under concurrency.
- **Serialisation.** One command in flight per lamp. Parallel writes are what the quota counts.
- **Pacing.** A sliding one-minute window holds commands back before the lamp has to defend itself.
- **Cheap retries.** A lost command is retried once, on a new connection, and is never re-written to a socket that already has it.

**Reliability fixes**

- Lamps were pinned to the address they were discovered at, so a new DHCP lease left one unreachable until Homebridge restarted. Announcements now update the endpoint — and the cached state, which costs nothing since the announcement already carries it.
- A reply split across two TCP reads threw `JSON.parse` straight out of the data handler. The stream is now buffered by line.
- Commands pending on a socket that closed were left to their own timeout instead of failing immediately.
- TCP keep-alive, so a half-open socket is noticed instead of silently swallowing commands.
- `active_mode` was stored as a string from property updates but compared against the number `1`, so moonlight mode never registered that way.
- The colour mixins kept `hue`/`sat` in module scope: the pair leaked between calls and stuck permanently once a send failed.
- The device limits table is keyed by family (`bslamp`) but models report a variant (`bslamp3`), so the lookup never matched and every bedside lamp fell back to the default colour temperature range.
- `isAdaptiveLightingActive` was called on a controller that stays an empty object on older Homebridge.

**Diagnostics**

- Log lines now name the lamp and its address. Previously a failure could not be attributed to a device.
- Routine discovery chatter moved to debug level, where it no longer drowns the log.
- The proactive search gives up after ten minutes instead of broadcasting every 15 s forever when a lamp is gone. Lamps announce themselves anyway and are picked up when they return.

## Requirements

- Node.js >= 16.16.0
- Homebridge >= 1.3.0
- A network where the host and the lamps can exchange UDP multicast on port 1982. Discovery is SSDP; lamps are then driven over TCP on port 55443.

## Installation

Not on npm — install straight from this repository.

Inside a Homebridge Docker container:

```bash
docker exec homebridge sh -c "cd /homebridge && npm install homebridge-yeelight-wifi@github:WhyElEss/homebridge-yeelight-wifi"
```

On a bare-metal install:

```bash
sudo npm install -g github:WhyElEss/homebridge-yeelight-wifi
```

Restart Homebridge afterwards. Accessory UUIDs are unchanged, so nothing needs re-pairing when migrating from upstream.

To take an update later, re-run the same command — npm re-fetches the branch.

## Setting up devices

Devices that already have the API enabled are autodiscovered with no further action.

Out of the factory the API is disabled. Open the YeeLight app, go to the device's settings and enable **Developer Mode** (also called LAN Control).

## Configuration

The plugin ships a `config.schema.json`, so the Homebridge UI renders a settings form for everything below — the alert colour, the per-lamp entries under **Devices**, and the connection budget.

Minimal — every option below has a working default:

```json
{
  "platforms": [
    {
      "platform": "yeelight",
      "name": "Yeelight"
    }
  ]
}
```

Full, with defaults shown:

```json
{
  "platforms": [
    {
      "platform": "yeelight",
      "name": "Yeelight",
      "transitions": {
        "power": 400,
        "brightness": 400,
        "color": 400,
        "temperature": 400
      },
      "connection": {
        "retries": 1,
        "timeout": 2000,
        "connectTimeout": 5000,
        "quota": 55,
        "coalesce": 80,
        "keepAlive": 30000
      },
      "multicast": {
        "interface": "0.0.0.0"
      },
      "devices": [
        {
          "id": "0x000000001778cb4e",
          "name": "Kitchen",
          "alert": { "enabled": true, "hue": 240, "saturation": 100 }
        }
      ]
    }
  ]
}
```

### `transitions`

How long, in milliseconds, the lamp takes to fade to a new value. Applies to the individual `set_power` / `set_bright` / `set_hsv` / `set_ct_abx` commands. Waking a lamp from off uses `set_scene`, which the firmware applies without a transition.

### `connection`

| Key | Default | What it does |
| --- | --- | --- |
| `timeout` | `2000` | How long to wait for a reply before treating a command as lost. Lamps on Wi-Fi routinely need 100–200 ms, so anything under ~1000 ms mostly measures the network. |
| `retries` | `1` | Extra attempts after a failure. Each runs on a **fresh** connection; a command is never written twice to the same socket. |
| `connectTimeout` | `5000` | How long to wait for the TCP handshake. |
| `quota` | `55` | Commands per minute per lamp. The firmware allows 60 and hangs up when that is exceeded, so this leaves a margin. |
| `coalesce` | `80` | Window, in ms, over which characteristic writes are merged into one command. Raising it merges more; lowering it makes the lamp react sooner. |
| `keepAlive` | `30000` | TCP keep-alive interval, so a half-open socket is noticed instead of swallowing commands. |

### `devices`

Per-lamp settings. A lamp that is not listed still works, on the platform defaults.

- `id` — how the lamp is identified. Any of the three forms it answers to: the full id (`0x000000001778cb4e`), its last six characters (`78cb4e`, which is what the log prints as `Received advertisement from 78cb4e`), or the `<model>-<id>` name (`bslamp3-78cb4e`). Case-insensitive.
- `name` — the name shown in HomeKit. Defaults to `<model>-<id>`.
- `hidden` — `true` keeps the lamp out of HomeKit entirely.
- `blacklist` — capabilities to keep out of HomeKit for this lamp. Edited in the JSON editor rather than the settings form, which has no widget that renders a list like this legibly. The values are the lamp's own method names, which the settings form shows under readable titles: `set_bright` brightness, `set_hsv` colour, `set_ct_abx` colour temperature (hiding it also removes Adaptive Lighting), `active_mode` moonlight mode, `bg_set_power` / `bg_set_bright` / `bg_set_hsv` the backlight.
- `alert` — gives this lamp an alert switch and sets its colour. See [`devices[].alert`](#devicesalert).

A rename here is applied on every launch, not only when the accessory is first created.

### `defaultValue` (legacy)

The map this plugin used before `devices`, keyed the same three ways. Still read, and still supported, but `devices` takes precedence and is the one the Homebridge UI can render as a form.

### `devices[].alert`

An alert belongs to a lamp: it is configured on the lamp that gets it, and there is no platform-wide default to inherit or to argue with. See [Alert switch](#alert-switch-flash-and-restore-without-losing-adaptive-lighting).

| Key | Default | What it does |
| --- | --- | --- |
| `enabled` | `false` | Whether this lamp gets an alert switch. |
| `hue` | `0` | Alert colour, 0–360. The default is red. |
| `saturation` | `100` | Alert saturation, 0–100. |
| `brightness` | `0` | Alert brightness, 0–100. Zero keeps whatever brightness the lamp already had, which is also one command less on the wire. |

`"alert": true` is shorthand for an alert switch in the default red.

The colour fields appear only once the switch is ticked. Unticking it and ticking it again puts them back at their defaults: the settings form destroys a hidden field and rebuilds it from the schema, and a plugin's schema cannot ask it to do otherwise. Known, harmless, and only ever costs a value you had just typed.

### `multicast`

Set `interface` to a specific address when the host has several and discovery binds to the wrong one.

## Alert switch: flash and restore without losing Adaptive Lighting

A lamp configured with `alert.enabled` gains a second accessory, a switch named after it, for automations like _"turn the lamp red while the front door is open, then put it back to whatever it was doing"_.

- Switching it **on** snapshots the lamp's power, colour, colour temperature and brightness, then takes it to the alert colour. A lamp that was off is lit by a single `set_scene`.
- Switching it **off** puts the snapshot back: the colour or the colour temperature it was on, and off again if that is how it started. The colour is restored before the power, so a lamp that was off does not come back red the next time anything switches it on.

Two ordinary single-action automations in the Home app drive it — _door opens_ → switch on, _door closes_ → switch off. Neither has anything to sequence or wait on, so any home hub can run them, with no phone present and no Shortcuts involved.

**On Adaptive Lighting.** This is the reason the alert lives inside the plugin rather than in some separate service that would drive the lamp over HomeKit. HAP-NodeJS switches an active Adaptive Lighting transition off on any characteristic change whose reason is a write — so an outside process setting Hue or Saturation would silently end Adaptive Lighting for that lamp, and only the Home app can arm it again. Everything here goes to the lamp over its own LAN protocol and is reported back to HomeKit with `updateValue`, which is not a write. The transition stays armed across the whole flash-and-restore cycle; there is a test that asserts no characteristic is ever written.

While a lamp is flashing, Adaptive Lighting's background nudges are held back, so the alert colour is not washed out within the minute — but their values are still recorded, so the restore puts the lamp on the curve where it stands at that moment rather than where it was when the alert began.

Cost on the wire: one command to flash, one to restore — two if the lamp was off, or if an alert brightness is set.

An `alert` block at the platform level, which earlier versions of this fork read as a default for every lamp, no longer does anything; the plugin says so in the log if it finds one.

## Tests

```bash
npm test
```

Runs the real bulb classes against a fake HAP and a fake lamp, asserting on what actually reaches the socket: that a scene is one `set_scene`, that `Hue` and `Saturation` merge, that an unanswered command costs one retry rather than six writes, that the quota gate holds, that a reply split across two TCP reads still parses, and that a lamp hanging up mid-command is recovered from.

The alert has its own group: that flashing a lit lamp is a single `set_hsv`, that the restore reproduces the snapshot exactly and sends the power off in its own flush after the colour, that an Adaptive Lighting nudge arriving mid-alert never reaches the lamp but is still remembered for the restore, and that no characteristic is ever written — the one thing that would take Adaptive Lighting down.

It earns its keep — it caught a socket being closed after it had already been replaced, which failed the command in flight on its successor and produced exactly the duplicate write this fork set out to remove.

## Developing

Run Homebridge locally in debug mode, in the plugin directory, so it does not disturb a real installation:

```bash
yarn start
```

Add it as a separate bridge in Home.app (+ Add Accessory). When finished: Home → 🏠 → Hubs & Bridges → "Yeelight Platform Development" → Remove Bridge From Home.

## Bugs and feature requests

Please report anything you find in [this fork's issues](https://github.com/WhyElEss/homebridge-yeelight-wifi/issues). For problems that also reproduce upstream, [vieira/homebridge-yeelight-wifi](https://github.com/vieira/homebridge-yeelight-wifi/issues) is the better home.

## Credits

Original plugin and architecture by [vieira](https://github.com/vieira), with contributions from [banzalik](https://github.com/banzalik) and [okonet](https://github.com/okonet). MIT licensed, as is this fork.
