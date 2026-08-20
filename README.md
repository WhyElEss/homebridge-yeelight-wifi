# Homebridge YeeLight Wi-Fi

[YeeLight](https://www.yeelight.com) plugin for [Homebridge](https://github.com/nfarina/homebridge) supporting Wi-Fi lighting devices.

This allows you to control your YeeLight Wi-Fi devices, such as the YeeLight Bulb, Stripe, Ceiling Lights, Star Lamp, etc. with [HomeKit](https://www.apple.com/ios/home) and Siri.

Implements [Yeelight WiFi Light Inter-Operation Specification](https://www.yeelight.com/download/Yeelight_Inter-Operation_Spec.pdf).

## Requirements

- Node.js >= 16.16.0
- Avahi

## Installation

1. Install homebridge, `sudo npm install -g homebridge`
2. Install this plugin using, `npm install -g homebridge-yeelight-wifi`

## Setting up devices

Devices that already have the API enabled should be autodiscovered without any other actions on your part.

However, out of the factory, the YeeLight devices do come with the API disabled, and you will have to enable it for them to work with Homebridge. To do so, go to settings and enable **Developer Mode**.

## Configuration (minimal)

Add the following to your homebridge config:

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

## Configuration (Optional)

The following parameters can be changed in case you need to change the defaults. The `blacklist` key can be an array of capabilities you do not want to expose to HomeKit or `true` to not expose the device at all.

```json
{
  "bridge": {
    "name": "Raspberry Pi"
  },
  "accessories": [{}],
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
      "defaultValue": {
        "aed78s": {
          "name": "Kitchen",
          "blacklist": ["set_hsv"]
        }
      }
    }
  ]
}
```

### `connection` options

| Key | Default | What it does |
| --- | --- | --- |
| `timeout` | `2000` | How long to wait for a reply before treating a command as lost. Lamps on Wi-Fi routinely need 100-200 ms, so anything under ~1000 ms mostly measures the network. |
| `retries` | `1` | Extra attempts after a failure. Each one runs on a **fresh** connection; a command is never written twice to the same socket. |
| `connectTimeout` | `5000` | How long to wait for the TCP handshake. |
| `quota` | `55` | Commands per minute per lamp. The firmware allows 60 and hangs up when that is exceeded, so this leaves a margin. Set it to `0` at your own risk. |
| `coalesce` | `80` | Window, in ms, over which characteristic writes are merged into one command. Raising it merges more; lowering it makes the lamp react sooner. |
| `keepAlive` | `30000` | TCP keep-alive interval, so a half-open socket is noticed instead of swallowing commands. |

## Motivation

When I got my first YeeLight bulb, there was already a homebridge plugin supporting it, however, it did not deal with transient failures. Frequently I would turn on a lamp, it would report it as _On_ but no sign of light could be seen. Manually turning the lamp off and on would solve the issue but was a nuisance.

This plugin was born to solve this issue and end up being a complete rewrite fixing a lot of other bugs and minor problems and also implementing a cleaner architecture.

This plugin keeps track of all your commands until a successful response is received from the lamp.

It also keeps track of known lamps and will continue to ocasionally look for them if they suddenly disappear. This is useful when you accidentally power off a lamp and later turn it on.

## Staying inside the lamp's limits

The [specification](https://www.yeelight.com/download/Yeelight_Inter-Operation_Spec.pdf) gives every lamp a hard budget: at most 4 simultaneous TCP connections, 60 commands per minute on each of them, and 144 per minute in total. Go past it and the firmware closes the connection; some lamps then stay deaf until they are physically power cycled.

A HomeKit scene is exactly the traffic that trips this. HomeKit writes `On`, `Brightness` and `ColorTemperature` as separate calls in the same instant, and each of the last two has to make sure the lamp is powered on first — so one scene used to become six or more commands per lamp, before any retry.

Three things keep that in budget:

- **Coalescing.** Characteristic writes landing within `coalesce` ms are merged into one desired state. Waking a lamp becomes a single `set_scene` carrying power, colour and brightness together, instead of `set_power` + `set_ct_abx` + `set_bright`.
- **Serialisation.** Each lamp has one command in flight at a time. Parallel writes are what the quota counts.
- **Pacing.** A sliding one-minute window holds commands back before the lamp has to defend itself.

Retries are deliberately cheap: a lost command is retried once, on a new connection, and never re-written to a socket that already has it.

## Bugs and feature requests

Please report any issues you might find, on [GitHub](https://github.com/vieira/homebridge-yeelight-wifi/issues).

Feature requests and specially pull requests are very welcome.

## Developing

During development run Homebridge locally in debug mode using the following command:

```bash
yarn start
```

This will run testing instance of Homebridge in the plugin directory, so it won't mess up your normal Homebridge installation.

Add it as a separate bridge in the Home.app (+ Add Accessory).

After you're done with development, you can remove the bridge from Home.app: Home -> 🏠 -> Hubs & Bridges. Choose "Yeelight Platform Development" and then "Remove Bridge From Home".
