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

- The lamp announces every change it makes, our own included, and that announcement went straight to HomeKit. Mid-drag the lamp confirms the value it has reached while the finger is still moving towards a later one, so the tile snaps backwards and the gesture is cancelled: a slider dragged to 100% landed on 5%, then on 66%, and the pause each time read as the plugin being slow. Nothing was slow — HAP requests were answered in under 4 ms and no command ever timed out. What a command asks for is now recorded as it is queued, and an announcement reaches HomeKit only when it matches none of it — see [Whose change is it](#whose-change-is-it).
- A lamp existed only once its announcement arrived. One of these lamps answers no search at all, so after a restart its accessory sat in HomeKit with nothing behind it: writes were accepted and dropped on the floor — the Home app showed the light switched on while the lamp stayed dark — and reads returned whatever the cache held. Lamps are now rebuilt from the accessory cache the moment Homebridge starts, from the endpoint and capabilities saved last time, and each one is asked for its real state in a single command. An announcement still relocates a lamp that moved.

- Every write waited for the lamp to answer before telling HomeKit the write had been accepted — 105–170 ms against the 6–8 ms of a plugin that answers first and acts after. Homebridge's guidance is explicit: _return the callback instantly, and call `updateValue` once the action has completed_; a handler that thinks for too long is warned about at three seconds and abandoned at nine, and a colour wheel streams writes far faster than a lamp on Wi-Fi can answer. Handlers now accept the write, queue the command, and push the cached value back if it never lands.
- Every HomeKit read of a lamp's `On` state went to the lamp over the LAN — one command out of the per-minute budget, and HomeKit blocked for the round trip. Reads are answered from the cache the announcements and property notifications already keep, with a refresh started behind the answer when it goes stale. A burst of reads used to queue up and leave the Home app spinning; the Homebridge log had 455 of them in a day.
- Rebuilding a lamp from its accessory cache read the colour temperature out of the HomeKit characteristic, which holds mired, and handed it on as `props.ct`, which everything downstream reads as the lamp's Kelvin. The setter inverted it a second time: a remembered 385 came back as 10⁶/385 = 2597, far outside what the characteristic allows, so HomeKit rejected it and logged a warning for every lamp on every start.
- The colour temperature range was advertised as 154–588 mired, but HomeKit defines the characteristic as 140–500. Adaptive Lighting computes its curve against exactly those bounds. HomeKit is now told 154–500; the lamp itself still goes wherever it always did.

- Lamps were pinned to the address they were discovered at, so a new DHCP lease left one unreachable until Homebridge restarted. Announcements now update the endpoint — and the cached state, which costs nothing since the announcement already carries it.
- A reply split across two TCP reads threw `JSON.parse` straight out of the data handler. The stream is now buffered by line.
- Commands pending on a socket that closed were left to their own timeout instead of failing immediately.
- TCP keep-alive, so a half-open socket is noticed instead of silently swallowing commands.
- `active_mode` was stored as a string from property updates but compared against the number `1`, so moonlight mode never registered that way.
- The alert switch was an accessory of its own and the night-mode switch a service with no subtype, so a lamp could not carry both and the Home app was never asked how to draw them. Both are services on the lamp now, told apart by subtype, and the old layout is migrated on first launch — see [Where the switches live](#where-the-switches-live).
- Night mode was probed for with `active_mode` alone, a property the spec marks ceiling-light-only. Bedside lamps have the mode and answer that property with an empty string, so they never got a switch — see [Night mode](#night-mode-the-lamps-own-warm-dim-state).
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
          "powerOn": { "brightness": 100, "kelvin": 2700 },
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
| `staleAfter` | `60000` | How old the cached power state may get before a HomeKit read starts a refresh behind it. The read itself is always answered from memory. |
| `echoWindow` | `4000` | How long a value we asked for is remembered, so the lamp's confirmation of it is recognised as our own and not pushed back at HomeKit. See [Whose change is it](#whose-change-is-it). |

### `devices`

Per-lamp settings. A lamp that is not listed still works, on the platform defaults.

- `id` — how the lamp is identified. Any of the three forms it answers to: the full id (`0x000000001778cb4e`), its last six characters (`78cb4e`, which is what the log prints as `Received advertisement from 78cb4e`), or the `<model>-<id>` name (`bslamp3-78cb4e`). Case-insensitive.
- `name` — the name shown in HomeKit. Defaults to `<model>-<id>`.
- `hidden` — `true` keeps the lamp out of HomeKit entirely.
- `blacklist` — capabilities to keep out of HomeKit for this lamp. Edited in the JSON editor rather than the settings form, which has no widget that renders a list like this legibly. The values are the lamp's own method names, which the settings form shows under readable titles: `set_bright` brightness, `set_hsv` colour, `set_ct_abx` colour temperature (hiding it also removes Adaptive Lighting), `active_mode` night mode, `bg_set_power` / `bg_set_bright` / `bg_set_hsv` the backlight.
- `powerOn.brightness` — the brightness this lamp wakes at when it is switched on by hand, and `powerOn.kelvin` — the white it wakes at when no Adaptive Lighting transition is running. Zero, the default, means the last white the lamp knew; the settings form offers it alongside three named whites, 2700 K warm, 4000 K neutral and 5000 K daylight, and the JSON editor takes any value from 1700 to 6500. See [Waking a lamp](#waking-a-lamp).
- `moonlight` — `false` keeps the night-mode switch off this lamp. Defaults to `true`, which means every lamp that turns out to have the mode gets one. See [Night mode](#night-mode-the-lamps-own-warm-dim-state).
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

## Waking a lamp

Switching a lamp on without saying anything else — a tap in the Home app, an iOS widget, Siri, a scene that only writes `On` — sends a bare power-on, and the lamp comes back exactly where it was left. After an evening at 10 % in a warm colour, that is not what anyone means by "on".

A lamp that was told how to wake — `powerOn.brightness`, `powerOn.kelvin`, or both — comes up **white**, never in a colour it happens to have been left in, at:

- the current point of a running **Adaptive Lighting** transition, if there is one;
- otherwise `powerOn.kelvin`, the temperature this lamp was told to wake at;
- otherwise the last white temperature it knew.

`powerOn.brightness` is the brightness it wakes at; zero, the default, leaves the brightness alone. A lamp with a running transition wakes on the curve whether it was configured or not — that has always been this plugin's behaviour on a manual power-on.

What the plugin cannot do is _arm_ Adaptive Lighting. Only the Home app writes the transition, and HomeKit switches it off the moment anyone picks a colour by hand — so such a lamp wakes white at the temperature above, but with the transition still off until Home turns it back on.

Both ride along in the single `set_scene` that switches the lamp on, so waking a lamp still costs one command. Earlier versions put the temperature back in a second command sent after the power, with the value decremented by one mired each time to get past the "same value, skip" check — a lamp that was switched on often drifted measurably away from the curve.

This applies only when nothing else arrives in the same coalescing window. A scene that carries its own brightness or colour is left alone.

## Alert switch: flash and restore without losing Adaptive Lighting

A lamp configured with `alert.enabled` gains a switch named after it — `Entrance Night Light Alert`, on the lamp's own accessory — for automations like _"turn the lamp red while the front door is open, then put it back to whatever it was doing"_.

- Switching it **on** snapshots the lamp's power, colour, colour temperature and brightness, then takes it to the alert colour. A lamp that was off is lit by a single `set_scene`.
- Switching it **off** puts the snapshot back: the colour or the colour temperature it was on, and off again if that is how it started. The colour is restored before the power, so a lamp that was off does not come back red the next time anything switches it on.

Two ordinary single-action automations in the Home app drive it — _door opens_ → switch on, _door closes_ → switch off. Neither has anything to sequence or wait on, so any home hub can run them, with no phone present and no Shortcuts involved.

**On Adaptive Lighting.** This is the reason the alert lives inside the plugin rather than in some separate service that would drive the lamp over HomeKit. HAP-NodeJS switches an active Adaptive Lighting transition off on any characteristic change whose reason is a write — so an outside process setting Hue or Saturation would silently end Adaptive Lighting for that lamp, and only the Home app can arm it again. Everything here goes to the lamp over its own LAN protocol and is reported back to HomeKit with `updateValue`, which is not a write. The transition stays armed across the whole flash-and-restore cycle; there is a test that asserts no characteristic is ever written.

While a lamp is flashing, Adaptive Lighting's background nudges are held back, so the alert colour is not washed out within the minute — but their values are still recorded, so the restore puts the lamp on the curve where it stands at that moment rather than where it was when the alert began.

Cost on the wire: one command to flash, one to restore — two if the lamp was off, or if an alert brightness is set.

An `alert` block at the platform level, which earlier versions of this fork read as a default for every lamp, no longer does anything; the plugin says so in the log if it finds one.

## Night mode: the lamp's own warm dim state

A lamp that has one gains a second control on the same accessory — a switch called **Moonlight Mode**, next to the light itself. Night mode is not a brightness and not a colour temperature: it is a state of the firmware, the lamp at its dimmest in a fixed warm amber (`#FF9000` on a `bslamp3`) that no combination of the two reproduces.

- Switching it **on** is a single `set_power` carrying the mode parameter the spec defines as _"5: turn on and switch to Night light mode"_. It lights a lamp that was off, and remembers the brightness the lamp was lit at.
- Switching it **off** puts that brightness back, at the colour temperature the lamp should be at — the current point of a running Adaptive Lighting transition, if there is one. There is no separate command for leaving the mode: any temperature or brightness command ends it, so the restore is the way out.

**Which lamps have it.** The spec reports the mode through two properties and marks one of them ceiling-light-only: `active_mode` (`0` daylight, `1` moonlight) and `nl_br`, the night light's brightness. A bedside lamp answers `active_mode` with an empty string and `nl_br` with a real number, so both are asked for, in one command, and the lamp's answer decides which one its mode is read from. Earlier versions asked only about `active_mode` and concluded that these lamps had no night mode at all. A lamp that answers neither gets no switch.

**Why the switch is the only honest indicator.** While the mode is on, the lightbulb tile shows the lamp on at 1 %, at the white it was last at — HomeKit has no way to show amber without writing `Hue` and `Saturation`, and writing a characteristic is what takes Adaptive Lighting down. So the physical colour and the tile disagree by design, and the switch is what says which mode the lamp is in.

**Adaptive Lighting.** The mode's natural enemy: the firmware leaves night mode on any `set_ct_abx` or `set_bright`, including one that changes nothing, and a transition nudges the temperature about once a minute. Background nudges are swallowed while the mode is on — and recorded, so switching the mode off lands the lamp on the curve where it stands then. A deliberate write is a different thing and is obeyed: moving the brightness or temperature slider ends the mode, and takes the switch down with it in the same moment.

Guarding the writes that arrive after the switch is not enough on its own: one that arrived a few milliseconds earlier is already past the guard and waiting for its coalescing window to close. An automation that put three lamps into night mode at 23:00 kept only the one that happened to be switched off, because the two that were lit each had a nudge in flight that went out 80 ms behind the switch. Entering the mode now takes back whatever is still in that window, and keeps the value.

**The lamp is the authority.** `nl_br` arrives in the lamp's own property notifications, so a mode ended by the Yeelight app, by another controller or by a scene of ours takes the switch down within a second. A lamp that is switched off reports `nl_br: 0`, which means the switch clears itself when the light goes out.

**Turning it off.** Every lamp that has the mode gets the switch; `moonlight: false` on a lamp takes it away again, from the settings form or the JSON. `blacklist: ["active_mode"]`, the older spelling, still says the same thing. A lamp whose switch is turned off is not even probed for the mode, which is one command less per launch.

**With the alert switch.** An alert is a colour, so it ends night mode as it lands. The alert's snapshot records the mode, and the restore brings it back with the same `set_power` rather than trying to reproduce it as a colour.

Cost on the wire: one command in, two out — the temperature and the brightness.

## Whose change is it

A Yeelight announces every change it makes on the open socket, without being asked. That is how this plugin knows a lamp was switched at its own touch panel, from the Yeelight app, or by a scene running on the lamp itself — and it is why HomeKit reads never have to travel to the lamp.

The catch is that the lamp announces the changes _we_ asked for in exactly the same way. Handing those back to HomeKit is worse than useless: the controller already holds the value it asked for, and if someone is still moving a slider, the confirmation of a value they have already passed lands on top of the one they are heading for. The tile snaps backwards and the gesture is cancelled.

So each command records what it claims, as it is queued — not when it completes, because the announcement can arrive in the same TCP read as the reply and is handled before the completion callback ever runs. An announcement is passed on to HomeKit only when both hold:

- it does not match a value we asked for within the last `echoWindow` ms, and
- no newer value for that property is still waiting to go out.

A change from anywhere else matches nothing and goes straight through. The internal cache always follows the lamp either way; it is only the push to HomeKit that is held back.

## Where the switches live

Both switches — the alert and the night mode — are services on the lamp's own accessory, beside the light itself. That is one accessory per lamp, whatever it can do.

It matters because the layout is then the owner's to choose. The Home app groups an accessory's controls into a single tile by default and splits them with **Show as separate tiles** in the accessory's settings; a plugin that registers an accessory per switch takes that choice away, and one that hides a switch inside the lamp without saying so leaves people wondering where the light's colour picker went — a grouped accessory is drawn without it.

**What the tiles are called.** Each switch carries its own `ConfiguredName` — `Entrance Night Light Alert`, `Entrance Night Light Moonlight` — because recent iOS labels a service inside an accessory by that characteristic and falls back to the accessory's name without it, which left a lamp showing two switches both named after the lamp. It is written only when a switch does not have a name yet, so renaming a tile in the Home app sticks.

**Switching such a lamp off.** A grouped tile has no separate on/off to tap — the brightness slider is the whole control — so dragging it to the bottom is how the lamp goes off, and a brightness of zero is taken as exactly that. It has to be: the firmware has no zero, `set_bright` clamps it up to 1, and on a lamp that was already off the same request used to turn into the `set_scene` that wakes it. The lamp came back on at 1% instead of going out.

Earlier versions did both: the alert was an accessory of its own, and the night-mode switch a service with no subtype. Both are migrated on the first launch that sees them — the old accessory is unregistered, the old service removed — and the two switches now differ by subtype (`alert`, `moonlight`), which is what lets one accessory carry both.

## Tests

```bash
npm test
```

Runs the real bulb classes against a fake HAP and a fake lamp, asserting on what actually reaches the socket: that a scene is one `set_scene`, that `Hue` and `Saturation` merge, that an unanswered command costs one retry rather than six writes, that the quota gate holds, that a reply split across two TCP reads still parses, and that a lamp hanging up mid-command is recovered from.

Night mode has a group of its own: that a lamp is found to have it through `nl_br` alone, that switching it on is one `set_power` carrying mode 5, that an Adaptive Lighting nudge never reaches a lamp in the mode while a deliberate write does and ends it, that a `nl_br` of 0 arriving from the lamp takes the switch down, and that switching the mode off restores the brightness the lamp was lit at.

The alert has its own group: that flashing a lit lamp is a single `set_hsv`, that the restore reproduces the snapshot exactly and sends the power off in its own flush after the colour, that an Adaptive Lighting nudge arriving mid-alert never reaches the lamp but is still remembered for the restore, and that no characteristic is ever written — the one thing that would take Adaptive Lighting down.

The lamp's fake can be told to announce its changes the way real firmware does, which is what the slider tests need: that a finger dragging brightness from 5 to 100 is never pushed backwards, that a change the plugin did not make still reaches HomeKit, and that a colour temperature remembered across a restart comes back as the same mired it went in as.

It earns its keep — it caught a socket being closed after it had already been replaced, which failed the command in flight on its successor and produced exactly the duplicate write this fork set out to remove. The slider tests were written the same way: the fake lamp stayed silent until it was taught to answer back, and the bug appeared the moment it did.

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
