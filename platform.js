const dgram = require('dgram');
const devices = require('./devices.json');
const YeeBulb = require('./bulbs/bulb');
const Brightness = require('./bulbs/brightness');
const MoonlightMode = require('./bulbs/moonlight');
const Color = require('./bulbs/color');
const Temperature = require('./bulbs/temperature');
const Alert = require('./bulbs/alert');
const Backlight = require('./bulbs/backlight/bulb');
const BacklightBrightness = require('./bulbs/backlight/brightness');
const BacklightColor = require('./bulbs/backlight/color');
const switches = require('./switches');
const {
  getDeviceId,
  getName,
  blacklist,
  deviceEntry,
  resolveAlert,
  resolveMoonlight,
  resolvePowerOn,
  sleep,
  pipe,
} = require('./utils');

// Lamps re-announce themselves unprompted, so the active search only has to
// cover the gap right after a restart instead of running forever.
const SEARCH_INTERVAL = 15000;
const SEARCH_ROUNDS = 40;

class YeePlatform {
  constructor(log, config, api) {
    if (!api) return;
    log.debug(`starting YeePlatform using homebridge API v${api.version}`);

    this.searchMessage = Buffer.from(
      ['M-SEARCH * HTTP/1.1', 'MAN: "ssdp:discover"', 'ST: wifi_bulb'].join(
        global.EOL
      )
    );
    this.addr = '239.255.255.250';
    this.port = 1982;
    this.log = log;
    this.config = config;
    this.sock = dgram.createSocket('udp4');
    this.devices = {};
    this.bulbs = {};
    // Alert switches live on their own accessories, keyed by the same device
    // id as the lamp they belong to.
    this.alerts = {};

    this.sock.bind(this.port, () => {
      this.sock.setBroadcast(true);
      this.sock.setMulticastTTL(128);
      this.sock.addMembership(this.addr);
      const multicastInterface = config?.multicast?.interface;
      if (multicastInterface) {
        this.sock.setMulticastInterface(multicastInterface);
      }
    });

    if (config && config.alert) {
      log.warn(
        'The platform-level `alert` block no longer does anything. Move it into ' +
          'the lamp it belongs to, under `devices`, or configure the alert from ' +
          "the plugin's settings page."
      );
    }

    this.api = api;
    this.api.on('didFinishLaunching', async () => {
      this.sock.on('message', this.handleMessage.bind(this));
      this.reviveKnownDevices();
      log(`Searching for known devices...`);

      let round = 0;
      do {
        this.search();
        round += 1;
        // eslint-disable-next-line no-await-in-loop
        await sleep(SEARCH_INTERVAL);
      } while (
        round < SEARCH_ROUNDS &&
        Object.values(this.devices).some((accessory) => !accessory.initialized)
      );

      const missing = Object.values(this.devices).filter(
        (accessory) => !accessory.initialized
      );

      if (missing.length) {
        log.warn(
          `Giving up the proactive search; still waiting on ${missing
            .map((accessory) => accessory.displayName)
            .join(', ')}. They will be picked up from their own announcements.`
        );
      } else {
        log(`All known devices found. Stopping proactive search.`);
      }
    });
  }

  // A lamp used to come into being only when its announcement arrived, and one
  // of these lamps answers no search at all - so after a restart its accessory
  // sat in HomeKit with nothing behind it: writes were accepted and dropped on
  // the floor, reads returned whatever was in the cache. Everything needed to
  // rebuild it was already saved from last time, so it is rebuilt at once and
  // then asked what state it is actually in.
  reviveKnownDevices() {
    Object.values(this.devices).forEach((accessory) => {
      const { did, endpoint, support } = accessory.context;
      if (!did || !endpoint || !support) return;

      const bulb = this.buildDevice(endpoint, {
        id: did,
        model: accessory.context.model,
        support,
        ...this.rememberedState(accessory),
      });
      if (bulb) bulb.refreshState();
    });
  }

  // The last values HomeKit was told, which Homebridge has already persisted
  // with the accessory. Good enough to start from, and corrected a moment
  // later by the lamp itself.
  rememberedState(accessory) {
    const service = accessory.getService(global.Service.Lightbulb);
    if (!service) return {};

    const { Characteristic } = global;
    const value = (characteristic) => {
      if (!service.testCharacteristic(characteristic)) return undefined;
      return service.getCharacteristic(characteristic).value;
    };

    // HomeKit holds a colour temperature in mired; the lamp, and every path
    // that starts from `props.ct`, speaks Kelvin. Handing the mired straight
    // over had it inverted a second time on the way in - a remembered 385
    // came back as 10^6/385 = 2597, which HomeKit then refused as far outside
    // the 140-500 the characteristic allows.
    const mired = value(Characteristic.ColorTemperature);
    const state = {
      power: value(Characteristic.On) ? 'on' : 'off',
      bright: value(Characteristic.Brightness),
      // Rounded, because that is the shape the lamp itself reports a colour
      // temperature in; an unrounded 2597.4 floors back to 384 mired and the
      // lamp drifts a step every restart.
      ct:
        Number.isFinite(mired) && mired > 0
          ? Math.round(10 ** 6 / mired)
          : undefined,
      hue: value(Characteristic.Hue),
      sat: value(Characteristic.Saturation),
    };

    Object.keys(state).forEach((key) => {
      if (state[key] === undefined || state[key] === null) delete state[key];
    });
    return state;
  }

  configureAccessory(accessory) {
    this.log(`Loaded accessory ${accessory.displayName}.`);
    accessory.initialized = false;
    // Both accessories of a lamp carry the same did, so the role decides which
    // shelf they belong on.
    if (accessory.context.role === 'alert') {
      this.alerts[accessory.context.did] = accessory;
      return;
    }
    this.devices[accessory.context.did] = accessory;
  }

  search() {
    this.log.debug('Sending search request...');
    this.sock.send(
      this.searchMessage,
      0,
      this.searchMessage.length,
      this.port,
      this.addr
    );
  }

  handleMessage(message) {
    let headers;
    let endpoint;

    try {
      headers = {};
      const [method, ...kvs] = message.toString().split(global.EOL);

      if (method.startsWith('M-SEARCH')) return;

      kvs.forEach((kv) => {
        const separator = kv.indexOf(': ');
        if (separator === -1) return;
        headers[kv.slice(0, separator)] = kv.slice(separator + 2);
      });

      // Anything without an id or a location is not a lamp talking to us.
      if (!headers.id || !headers.Location) return;
      endpoint = headers.Location.split('//')[1];
      if (!endpoint) return;
    } catch (err) {
      this.log.debug(`Ignoring malformed advertisement: ${err.message}`);
      return;
    }

    this.log.debug(`Received advertisement from ${getDeviceId(headers.id)}.`);

    const bulb = this.bulbs[headers.id];
    if (bulb) {
      // Announcements are how we hear about a new DHCP lease, and they carry
      // the full state, so following them costs no commands.
      bulb.relocate(endpoint);
      bulb.sync(headers);
      return;
    }

    this.buildDevice(endpoint, headers);
  }

  buildDevice(endpoint, { id, model, support, ...props }) {
    const deviceId = getDeviceId(id);
    // A lamp answers to all three of these, so a config entry may use whichever
    // its author finds readable.
    const keys = [`${model}-${deviceId}`, deviceId, id];
    const name = getName(this.config, keys);
    const hidden = blacklist(this.config, keys);
    let accessory = this.devices[id];

    if (hidden === true) {
      this.log.debug(`Device ${name} is blacklisted, ignoring...`);
      switches.removeLegacyAlert(this, id, name);
      try {
        delete this.devices[id];
        delete this.bulbs[id];
        this.api.unregisterPlatformAccessories(
          'homebridge-yeelight',
          'yeelight',
          [accessory]
        );
        this.log(`Device ${name} was unregistered`);
        // eslint-disable-next-line no-empty
      } catch (_) {}
      return;
    }

    const features = support
      .split(' ')
      .concat(Object.keys(props))
      .filter((f) => !hidden.includes(f));

    if (!accessory) {
      this.log(`Initializing new accessory ${id} with name ${name}...`);
      const uuid = global.UUIDGen.generate(id);
      accessory = new global.Accessory(name, uuid);
      accessory.context.did = id;
      accessory.context.model = model;
      this.devices[id] = accessory;
      this.api.registerPlatformAccessories('homebridge-yeelight', 'yeelight', [
        accessory,
      ]);
    }

    // Kept so the next launch can rebuild this lamp without waiting to be told
    // it exists. The endpoint may be stale by then; an announcement relocates
    // it, and until one arrives a stale address fails loudly instead of
    // silently swallowing everything HomeKit sends.
    if (
      accessory.context.endpoint !== endpoint ||
      accessory.context.support !== support
    ) {
      accessory.context.endpoint = endpoint;
      accessory.context.support = support;
      this.api.updatePlatformAccessories([accessory]);
    }

    // A name from the config only ever reached a freshly created accessory, so
    // renaming a lamp that HomeKit already knew about did nothing at all.
    if (accessory.displayName !== name) {
      this.log(`Renaming ${accessory.displayName} to ${name}.`);
      accessory.displayName = name;
      accessory
        .getService(global.Service.AccessoryInformation)
        .setCharacteristic(global.Characteristic.Name, name);
      this.api.updatePlatformAccessories([accessory]);
    }

    // Both switches used to be somewhere else - the alert on an accessory of
    // its own, the moonlight switch on a service with no subtype. Cleared here,
    // on the first launch that sees them, before anything is built.
    switches.removeLegacySwitches(this, accessory, id, name);

    if (accessory?.initialized) return;

    const mixins = [];
    const limits = this.limitsFor(model);

    if (features.includes('set_bright')) {
      this.log(`Device ${name} supports brightness`);
      mixins.push(Brightness);
    }

    if (features.includes('set_hsv')) {
      this.log(`Device ${name} supports color`);
      mixins.push(Color);
    }

    if (features.includes('set_ct_abx')) {
      this.log(`Device ${name} supports color temperature`);
      mixins.push(Temperature);
    }

    // After brightness and temperature, so its overrides wrap theirs: night
    // mode is a state the lamp drops on any brightness or temperature command,
    // and it has to see them coming. It also has to read a property before
    // either of them does, which the same order gives.
    if (this.moonlightFor(keys, hidden)) {
      mixins.push(MoonlightMode);
    } else if (switches.removeSwitch(accessory, switches.MOONLIGHT)) {
      this.log(`Removed the moonlight switch from ${name}.`);
    }

    if (features.includes('bg_set_power')) {
      this.log(`Device ${name} supports backlight`);
      mixins.push(Backlight);
    }

    if (features.includes('bg_set_bright')) {
      this.log(`Device ${name} supports backlight brightness`);
      mixins.push(BacklightBrightness);
    }

    if (features.includes('bg_set_hsv')) {
      this.log(`Device ${name} supports backlight color`);
      mixins.push(BacklightColor);
    }

    const alert = this.alertFor(keys, features, name);
    const powerOn = resolvePowerOn(deviceEntry(this.config, keys));

    // Applied last so its setTemperature override wraps the temperature
    // mixin's, which is what lets it swallow background Adaptive Lighting
    // nudges while the lamp is flashing.
    if (alert.enabled) {
      this.log(`Device ${name} gets an alert switch`);
      mixins.push(Alert);
    }

    const Bulb = class extends pipe(...mixins)(YeeBulb) {};
    const bulb = new Bulb(
      { id, model, endpoint, accessory, limits, alert, powerOn, ...props },
      this
    );
    this.bulbs[id] = bulb;
    switches.configureAlert(this, bulb, name);
    return bulb;
  }

  // Offered to every lamp that turns out to have the mode, and switched off
  // per lamp from the settings form. `blacklist: ['active_mode']`, the older
  // spelling, still says the same thing.
  moonlightFor(keys, hidden) {
    if (hidden.includes('active_mode')) return false;
    return resolveMoonlight(deviceEntry(this.config, keys));
  }

  // A lamp's own alert block. There is no platform-wide default: an alert
  // belongs to a lamp or it does not exist.
  alertFor(keys, features, name) {
    const alert = resolveAlert(deviceEntry(this.config, keys));
    if (!alert.enabled) return alert;

    // An alert is a colour, so a lamp that cannot take one has nothing to show.
    if (!features.includes('set_hsv')) {
      this.log.warn(
        `Device ${name} has no colour support, so it gets no alert switch.`
      );
      return { enabled: false };
    }

    return alert;
  }

  // Models are numbered variants of a family (bslamp1, bslamp2, bslamp3) but
  // the table is keyed by family, so an exact lookup never matched and every
  // bedside lamp silently fell back to the default range.
  limitsFor(model) {
    if (!model) return devices['default'];
    return (
      devices[model] || devices[model.replace(/\d+$/, '')] || devices['default']
    );
  }
}

module.exports = YeePlatform;
