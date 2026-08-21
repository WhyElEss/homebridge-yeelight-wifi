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
const alertAccessory = require('./alert-accessory');
const { getDeviceId, getName, blacklist, sleep, pipe } = require('./utils');

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

    this.api = api;
    this.api.on('didFinishLaunching', async () => {
      this.sock.on('message', this.handleMessage.bind(this));
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
    const name = getName(`${model}-${deviceId}`, this.config);
    const hidden = blacklist(deviceId, this.config);
    let accessory = this.devices[id];

    if (hidden === true) {
      this.log.debug(`Device ${name} is blacklisted, ignoring...`);
      alertAccessory.remove(this, id);
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

    if (accessory?.initialized) return;

    const mixins = [];
    const limits = this.limitsFor(model);

    if (!hidden.includes('active_mode')) {
      mixins.push(MoonlightMode);
    }

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

    const alert = this.alertFor(model, deviceId, features, name);

    // Applied last so its setTemperature override wraps the temperature
    // mixin's, which is what lets it swallow background Adaptive Lighting
    // nudges while the lamp is flashing.
    if (alert.enabled) {
      this.log(`Device ${name} gets an alert switch`);
      mixins.push(Alert);
    }

    const Bulb = class extends pipe(...mixins)(YeeBulb) {};
    const bulb = new Bulb(
      { id, model, endpoint, accessory, limits, alert, ...props },
      this
    );
    this.bulbs[id] = bulb;
    alertAccessory.configure(this, bulb, { id, name });
    return bulb;
  }

  // Alert settings come from the platform block and can be overridden per
  // lamp under defaultValue, keyed either by the six-character device id or by
  // the full <model>-<id> name. `false` there switches a single lamp off.
  clamp(value, min, max) {
    if (!Number.isFinite(Number(value))) return undefined;
    return Math.min(Math.max(Number(value), min), max);
  }

  alertFor(model, deviceId, features, name) {
    const perDevice = [`${model}-${deviceId}`, deviceId]
      .map((key) => this.config?.defaultValue?.[key]?.alert)
      .find((value) => value !== undefined);

    if (perDevice === false) return { enabled: false };

    const alert = Object.assign(
      { enabled: false },
      this.config?.alert,
      perDevice === true ? { enabled: true } : perDevice
    );

    if (!alert.enabled) return { enabled: false };

    // An alert is a colour, so a lamp that cannot take one has nothing to show.
    if (!features.includes('set_hsv')) {
      this.log.warn(
        `Device ${name} has no colour support, so it gets no alert switch.`
      );
      return { enabled: false };
    }

    return {
      enabled: true,
      hue: this.clamp(alert.hue, 0, 360) ?? 0,
      saturation: this.clamp(alert.saturation, 0, 100) ?? 100,
      brightness: this.clamp(alert.brightness, 1, 100),
    };
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
