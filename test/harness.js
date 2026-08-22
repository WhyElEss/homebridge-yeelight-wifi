/* Fake HAP + fake Yeelight, to prove what actually goes on the wire. */
const net = require('net');

global.EOL = '\r\n';

class FakeCharacteristic {
  constructor(id) {
    this.id = id;
    this.handlers = {};
    this.value = null;
    // Anything that would count as a HomeKit write, which is what takes
    // Adaptive Lighting down. The plugin must never do this itself.
    this.hapWrites = [];
  }
  setValue(v) {
    this.hapWrites.push(v);
    this.value = v;
    return this;
  }
  removeAllListeners(ev) {
    delete this.handlers[ev];
    return this;
  }
  on(ev, fn) {
    this.handlers[ev] = fn;
    return this;
  }
  updateValue(v) {
    this.value = v;
    return this;
  }
  setProps(props) {
    this.props = props;
    return this;
  }
  write(value, context) {
    return new Promise((resolve, reject) => {
      this.handlers.set(
        value,
        (err) => {
          if (err) return reject(err);
          // HAP-NodeJS stores the written value once the handler accepts it,
          // which is what makes a later updateValue visible as a correction.
          this.value = value;
          resolve();
        },
        context
      );
    });
  }
  read() {
    return new Promise((resolve, reject) => {
      this.handlers.get((err, v) => (err ? reject(err) : resolve(v)));
    });
  }
}

class FakeService {
  constructor(name, subtype) {
    this.displayName = name;
    this.subtype = subtype;
    this.chars = new Map();
  }
  getCharacteristic(id) {
    if (!this.chars.has(id)) this.chars.set(id, new FakeCharacteristic(id));
    return this.chars.get(id);
  }
  addCharacteristic(id) {
    return this.getCharacteristic(id);
  }
  addOptionalCharacteristic(id) {
    return this.getCharacteristic(id);
  }
  setCharacteristic() {
    return this;
  }
  setPrimaryService() {
    return this;
  }
}

const mkService = (tag) =>
  class extends FakeService {
    constructor(name, subtype) {
      super(name, subtype);
      this.tag = tag;
    }
  };

global.Service = {
  AccessoryInformation: mkService('info'),
  Lightbulb: mkService('lightbulb'),
  Switch: mkService('switch'),
};

global.Characteristic = {
  On: 'On',
  Brightness: 'Brightness',
  Hue: 'Hue',
  Saturation: 'Saturation',
  ColorTemperature: 'ColorTemperature',
  Manufacturer: 'Manufacturer',
  Model: 'Model',
  SerialNumber: 'SerialNumber',
};

class FakeAccessory {
  constructor(name) {
    this.displayName = name;
    this.context = {};
    this.services = [];
    this.info = new global.Service.AccessoryInformation(name);
  }
  getService(type) {
    if (type === global.Service.AccessoryInformation) return this.info;
    if (typeof type === 'string') {
      return this.services.find((s) => s.subtype === type);
    }
    return this.services.find((s) => s instanceof type);
  }
  addService(service) {
    this.services.push(service);
    return service;
  }
  on() {
    return this;
  }
  configureController() {}
}

const quiet = process.env.VERBOSE !== '1';
const log = Object.assign((...a) => !quiet && console.log('   log ', ...a), {
  info: (...a) => !quiet && console.log('   info', ...a),
  warn: (...a) => !quiet && console.log('   warn', ...a),
  error: (...a) => !quiet && console.log('   err ', ...a),
  debug: () => {},
});

// --- fake lamp -------------------------------------------------------------
class FakeLamp {
  constructor(opts = {}) {
    this.received = [];
    this.connections = 0;
    this.live = 0;
    this.delay = opts.delay === undefined ? 20 : opts.delay;
    this.silent = !!opts.silent;
    this.sockets = new Set();
    this.server = net.createServer((sock) => {
      this.connections += 1;
      this.live += 1;
      this.sockets.add(sock);
      sock.on('close', () => {
        this.live -= 1;
        this.sockets.delete(sock);
      });
      sock.on('error', () => {});
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\r\n');
        buf = lines.pop();
        lines.filter(Boolean).forEach((line) => {
          const msg = JSON.parse(line);
          this.received.push(msg);
          if (this.silent) return;
          setTimeout(() => {
            if (!sock.destroyed) {
              sock.write(
                JSON.stringify({ id: msg.id, result: ['ok'] }) + '\r\n'
              );
            }
          }, this.delay);
        });
      });
    });
  }
  listen() {
    return new Promise((r) => this.server.listen(0, '127.0.0.1', r));
  }
  get port() {
    return this.server.address().port;
  }
  close() {
    // server.close() waits for live connections, so drop them first.
    this.sockets.forEach((sock) => sock.destroy());
    this.sockets.clear();
    return new Promise((r) => this.server.close(() => r()));
  }
  methods() {
    return this.received.map((m) => m.method);
  }
  reset() {
    this.received = [];
  }
}

// --- bulb construction, mirroring platform.js -----------------------------
const YeeBulb = require('../bulbs/bulb');
const Brightness = require('../bulbs/brightness');
const MoonlightMode = require('../bulbs/moonlight');
const Color = require('../bulbs/color');
const Temperature = require('../bulbs/temperature');
const Alert = require('../bulbs/alert');
const { pipe } = require('../utils');

async function makeBulb(lamp, config = {}, props = {}) {
  const accessory = new FakeAccessory('Lamp');
  accessory.context.did = '0xtest';
  // Alert last, mirroring platform.js: its setTemperature override has to sit
  // outside the temperature mixin's.
  const Bulb = class extends pipe(
    MoonlightMode,
    Brightness,
    Color,
    Temperature,
    Alert
  )(YeeBulb) {};
  const bulb = new Bulb(
    {
      id: '0xtest',
      model: 'bslamp3',
      endpoint: `127.0.0.1:${lamp.port}`,
      accessory,
      limits: { colorTemperature: [154, 588] },
      power: 'off',
      bright: '50',
      ct: '2702',
      hue: '10',
      sat: '20',
      ...props,
    },
    { log, config, api: {} }
  );
  // Let the moonlight probe finish so it does not pollute the counters.
  await new Promise((r) => setTimeout(r, 300));
  lamp.reset();
  return { bulb, service: bulb.service, accessory };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { FakeLamp, makeBulb, sleep, log };
