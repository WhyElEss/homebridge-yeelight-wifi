const net = require('net');
const { id: nextCmdId, sleep } = require('../utils');

const MINUTE = 60000;
// A single stray chunk should never be able to grow the read buffer forever.
const MAX_BUFFER = 65536;

class YeeBulb {
  constructor(props, platform) {
    const { id, model, endpoint, accessory } = props;
    this.did = id;
    this.name = accessory.displayName;
    this.model = model;
    this.log = platform.log;
    this.cmds = {};
    this.sock = null;
    this.connected = false;
    this.connecting = null;
    this.buffer = '';
    this.accessory = accessory;
    this.config = platform.config || {};
    this.endpoint = endpoint;

    const {
      retries = 1,
      timeout = 2000,
      connectTimeout = 5000,
      quota = 55,
      coalesce = 80,
      keepAlive = 30000,
    } = this.config.connection || {};

    this.retries = retries;
    this.timeout = timeout;
    this.connectTimeout = connectTimeout;
    this.quota = quota;
    this.coalesce = coalesce;
    this.keepAlive = keepAlive;

    // When a lamp exceeds its per-minute LAN quota the firmware hangs up and
    // stays deaf until it is power cycled, so we pace ourselves instead.
    this.sent = [];
    // The lamp announces itself every few minutes and pushes property changes
    // on an open socket, so the cache rarely needs help; this is the floor
    // between the reads that ask for it anyway.
    this.lastPowerRead = 0;
    this.staleAfter = (this.config.connection || {}).staleAfter ?? 60000;
    // Commands go out one at a time: a burst of parallel writes is exactly
    // what the quota counts.
    this.queue = Promise.resolve();
    // State HomeKit has asked for but that has not been sent yet.
    this.desired = null;
    this.pending = null;
    this.settle = null;
    this.flushTimer = null;

    // The advertisement we were built from already carries the live state.
    this.power = props.power;

    // What a bare "on" means for this lamp - see applyPowerOnDefaults.
    this.powerOn = props.powerOn || {};

    this.accessory
      .getService(global.Service.AccessoryInformation)
      .setCharacteristic(global.Characteristic.Manufacturer, 'YeeLight')
      .setCharacteristic(global.Characteristic.Model, this.model)
      .setCharacteristic(global.Characteristic.SerialNumber, this.did);

    this.service =
      this.accessory.getService(global.Service.Lightbulb) ||
      this.accessory.addService(new global.Service.Lightbulb(this.name));

    // Carries a rename through to the service HomeKit actually shows.
    this.service.setCharacteristic(global.Characteristic.Name, this.name);
    this.service.setPrimaryService();

    this.accessory.on('identify', async (_, callback) => {
      await this.identify();
      callback();
    });

    this.service
      .getCharacteristic(global.Characteristic.On)
      .on('set', (value, callback) => {
        this.accepted(this.setPower(value), () =>
          this.service
            .getCharacteristic(global.Characteristic.On)
            .updateValue(this.power)
        );
        callback(null);
      })
      // Answered from memory, never from the lamp. HomeKit reads this often -
      // opening the accessory, building a widget, configuring Adaptive
      // Lighting - and a read that goes to the lamp costs a command out of the
      // per-minute budget and blocks HomeKit for a LAN round-trip while it
      // does. A burst of reads used to queue behind each other and leave the
      // Home app spinning. The cache is kept honest by the lamp's own
      // announcements and property notifications, plus a refresh started in
      // the background when a read finds it stale.
      .on('get', (callback) => {
        callback(null, this.power);
        this.refreshPowerInBackground();
      })
      .updateValue(this.power);

    this.accessory.initialized = true;

    this.log(`Initialized device ${this.name} (${this.endpoint}).`);
  }

  get tag() {
    return `${this.name} (${this.host})`;
  }

  // HomeKit is told a write was accepted as soon as it is queued, rather than
  // when the lamp confirms it. Homebridge's own guidance is to "return the
  // callback() instantly, and call updateValue once the action has completed":
  // a handler that thinks for too long gets a warning at three seconds and is
  // abandoned at nine, and a colour wheel streams writes far faster than a
  // lamp on Wi-Fi can answer. If the command never lands, the cached value is
  // pushed back so the tile stops showing something that never happened.
  accepted(promise, revert) {
    promise.catch((err) => {
      this.log.warn(
        `${this.tag}: ${
          err.message || err
        } - putting HomeKit back to the lamp's state.`
      );
      if (revert) revert();
    });
  }

  // At most one refresh a minute, and never one that HomeKit waits on.
  refreshPowerInBackground() {
    const now = Date.now();
    if (now - this.lastPowerRead < this.staleAfter) return;
    this.lastPowerRead = now;
    this.getProperty(['power'])
      .then(([value]) => {
        if (value === undefined) return;
        this.updateStateFromProp('power', value);
      })
      .catch((err) => {
        this.log.debug(
          `${this.tag}: background power refresh failed: ${err.message || err}.`
        );
      });
  }

  get endpoint() {
    return `${this.host}:${this.port}`;
  }

  set endpoint(endpoint) {
    const [host, port] = endpoint.split(':');
    this.host = host;
    this.port = Number(port);
  }

  get power() {
    return !!this._power;
  }

  set power(state) {
    this._power = state === 'on' || state === true;
  }

  // Lamps re-announce themselves every few minutes. Following the announcement
  // is the only way we ever learn about a new DHCP lease.
  relocate(endpoint) {
    if (!endpoint || endpoint === this.endpoint) return;
    this.log.info(
      `${this.tag}: moved to ${endpoint}, dropping the old socket.`
    );
    this.endpoint = endpoint;
    this.reset();
  }

  // Advertisements carry the whole state, so refreshing from them costs no
  // commands and keeps an automation from turning into a silent no-op.
  sync(props) {
    [
      'power',
      'bright',
      'ct',
      'hue',
      'sat',
      'color_mode',
      'active_mode',
    ].forEach((prop) => {
      if (props[prop] === undefined || props[prop] === '') return;
      this.updateStateFromProp(prop, props[prop]);
    });
  }

  connect() {
    if (this.connected && this.sock && !this.sock.destroyed) {
      return Promise.resolve();
    }
    if (this.connecting) return this.connecting;

    const attempt = new Promise((resolve, reject) => {
      let settled = false;
      const sock = net.connect(this.port, this.host);
      this.sock = sock;
      this.connected = false;
      this.buffer = '';

      const timer = setTimeout(() => {
        const err = new Error(`connection to ${this.host} timed out`);
        err.code = 'ETIMEDOUT';
        sock.destroy(err);
      }, this.connectTimeout);

      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      sock.once('connect', () => {
        if (this.sock !== sock) {
          sock.destroy();
          finish(new Error('superseded by a newer connection'));
          return;
        }
        this.connected = true;
        sock.setNoDelay(true);
        // Without keep-alive a half-open socket (lamp rebooted, AP dropped it)
        // looks usable forever and every command silently times out.
        sock.setKeepAlive(true, this.keepAlive);
        this.log.debug(`${this.tag}: connected.`);
        finish();
      });

      sock.on('data', (chunk) => this.onData(chunk));

      sock.on('error', (error) => {
        this.log.debug(
          `${this.tag}: socket error ${error.code || error.message}.`
        );
        finish(error);
      });

      sock.on('close', () => {
        // Only the socket that still owns the pending commands may fail them.
        // A superseded socket closing must not kill a command that has already
        // gone out on its replacement.
        if (this.sock === sock) {
          this.sock = null;
          this.connected = false;
          this.failPending(new Error(`${this.host} closed the connection`));
        }
        finish(new Error('connection closed'));
      });
    });

    this.connecting = attempt;
    attempt
      .catch(() => {})
      .then(() => {
        if (this.connecting === attempt) this.connecting = null;
      });
    return attempt;
  }

  reset() {
    const { sock } = this;
    this.sock = null;
    this.connected = false;
    this.connecting = null;
    if (sock && !sock.destroyed) sock.destroy();
    // Done here rather than from the close handler, which can no longer tell
    // that this socket was the current one.
    this.failPending(new Error('connection reset'));
  }

  // Anything still waiting on a dead socket must fail now: leaving it to its
  // own timeout is what used to stall a whole scene.
  failPending(error) {
    const pending = Object.values(this.cmds);
    this.cmds = {};
    pending.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(error);
    });
  }

  // TCP hands us arbitrary chunks; a reply split across two reads used to
  // throw JSON.parse straight out of the data handler.
  onData(chunk) {
    this.buffer += chunk.toString();
    if (this.buffer.length > MAX_BUFFER) {
      this.log.warn(`${this.tag}: dropping an oversized reply buffer.`);
      this.buffer = '';
      return;
    }

    const lines = this.buffer.split(global.EOL);
    this.buffer = lines.pop();

    lines
      .filter((line) => line)
      .forEach((line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch (_) {
          this.log.debug(`${this.tag}: ignoring unparsable payload ${line}.`);
          return;
        }
        if (this.responseHandler(message)) return;
        this.stateHandler(message);
      });
  }

  responseHandler(message) {
    if (!('id' in message)) return false;
    const cmd = this.cmds[message.id];
    if (!cmd) return true;

    delete this.cmds[message.id];
    clearTimeout(cmd.timeout);

    if ('result' in message) {
      this.log.debug(`${this.tag}: ${JSON.stringify(message)}`);
      cmd.resolve(message.result);
    } else if ('error' in message) {
      this.log.error(`${this.tag}: ${JSON.stringify(message.error)}`);
      cmd.reject(new Error(message.error.message || 'command rejected'));
    } else {
      cmd.reject(new Error(`unexpected reply ${JSON.stringify(message)}`));
    }
    return true;
  }

  stateHandler(message) {
    if (message.method !== 'props' || !message.params) return false;
    Object.keys(message.params).forEach((param) => {
      this.updateStateFromProp(param, message.params[param]);
    });
    return true;
  }

  updateStateFromProp(prop, value) {
    if (prop !== 'power') {
      this.log.debug(`${prop} is not supported in Homekit, skipping.`);
      return;
    }
    this.power = value;
    this.service
      .getCharacteristic(global.Characteristic.On)
      .updateValue(this.power);
  }

  sendCmd(cmd) {
    return this.enqueue(cmd);
  }

  enqueue(cmd) {
    const run = () => this.throttle().then(() => this.dispatch(cmd));
    // Run on both settlements: a failed command must not stall the queue.
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  throttle() {
    const now = Date.now();
    this.sent = this.sent.filter((at) => now - at < MINUTE);
    if (this.sent.length < this.quota) return Promise.resolve();

    const wait = MINUTE - (now - this.sent[0]) + 50;
    this.log.warn(
      `${this.tag}: hit ${this.quota} commands/min, holding ${wait}ms to stay inside the LAN quota.`
    );
    return sleep(wait).then(() => this.throttle());
  }

  async dispatch(cmd) {
    cmd.id = nextCmdId.next().value;
    const msg = JSON.stringify(cmd);

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        // Sequential by design: this is a retry ladder, not a fan-out.
        // eslint-disable-next-line no-await-in-loop
        await this.connect();
        this.log.info(`${this.tag}: ${msg}`);
        // eslint-disable-next-line no-await-in-loop
        return await this.write(cmd, msg);
      } catch (err) {
        const code = (err && (err.code || err.message)) || 'unknown';

        if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
          this.log.error(`${this.tag}: unreachable, dropping cmd ${cmd.id}.`);
          throw err;
        }

        // Whatever went wrong, the socket is suspect. Re-sending on it is what
        // burned through the quota before, so always start a fresh one.
        this.reset();

        if (attempt === this.retries) {
          this.log.error(
            `${this.tag}: cmd ${cmd.id} failed after ${
              attempt + 1
            } attempt(s): ${code}.`
          );
          throw err;
        }

        this.log.warn(
          `${this.tag}: cmd ${cmd.id} failed (${code}), retrying once on a new connection.`
        );
        // eslint-disable-next-line no-await-in-loop
        await sleep(200);
      }
    }

    throw new Error(`${this.tag}: cmd ${cmd.id} exhausted its retries`);
  }

  write(cmd, msg) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        delete this.cmds[cmd.id];
        const err = new Error(
          `no reply to cmd ${cmd.id} within ${this.timeout}ms`
        );
        err.code = 'ETIMEDOUT';
        reject(err);
      }, this.timeout);

      // Registered before the write so a fast reply cannot arrive first.
      this.cmds[cmd.id] = { resolve, reject, timeout };
      this.sent.push(Date.now());

      this.sock.write(msg + global.EOL, (err) => {
        if (!err) return;
        clearTimeout(timeout);
        delete this.cmds[cmd.id];
        reject(err);
      });
    });
  }

  getProperty(properties) {
    return this.enqueue({ method: 'get_prop', params: properties });
  }

  identify() {
    // Use flash notify effect when supported
    // TODO: Check support for `start_cf`
    return this.enqueue({
      method: 'start_cf',
      params: [10, 0, '500,2,0,10,500,2,0,100'],
    });
  }

  // HomeKit writes On, Brightness and ColorTemperature as separate calls in the
  // same instant. Merging them into one flush turns a scene into a single
  // command instead of the burst the lamp answers by hanging up.
  applyState(patch) {
    const desired = this.desired || {};
    const next = Object.assign({}, patch);

    // A mixin asking for power so its colour change lands must not undo an
    // explicit Off that arrived in the same window.
    if (next.power === true && !next.force && desired.power === false) {
      delete next.power;
    }

    this.desired = Object.assign(desired, next);

    if (!this.pending) {
      this.pending = new Promise((resolve, reject) => {
        this.settle = { resolve, reject };
      });
      // A fixed window rather than a sliding one, so a stream of slider
      // updates still reaches the lamp instead of starving.
      this.flushTimer = setTimeout(() => this.flush(), this.coalesce);
    }

    return this.pending;
  }

  flush() {
    const { desired, settle } = this;
    this.desired = null;
    this.pending = null;
    this.settle = null;
    this.flushTimer = null;

    if (!settle) return;
    if (!desired) {
      settle.resolve();
      return;
    }

    const steps = this.commandsFor(desired);
    if (!steps.length) {
      settle.resolve();
      return;
    }

    // Enqueued synchronously so the whole flush takes consecutive slots and
    // cannot be interleaved with another one.
    const runs = steps.map(({ cmd, commit }) => this.enqueue(cmd).then(commit));
    runs.forEach((run) => run.catch(() => {}));
    Promise.all(runs).then(() => settle.resolve(), settle.reject);
  }

  commandsFor(desired) {
    const {
      power: powerTransition = 400,
      brightness: brightnessTransition = 400,
      color: colorTransition = 400,
      temperature: temperatureTransition = 400,
    } = this.config.transitions || {};

    // Off wins over anything else that landed in the same window.
    if (desired.power === false) {
      return [
        {
          cmd: {
            method: 'set_power',
            params: ['off', 'smooth', powerTransition],
          },
          commit: () => {
            this.power = 'off';
          },
        },
      ];
    }

    desired = this.applyPowerOnDefaults(desired);

    const wantsOn = desired.power === true;
    const hasColor = desired.hue !== undefined || desired.sat !== undefined;
    const hasTemperature = desired.ct !== undefined;
    const hasBrightness = desired.bright !== undefined;

    // Waking a lamp: one set_scene carries power, colour and brightness
    // together, where this used to cost three or four separate commands.
    if (
      wantsOn &&
      !this.power &&
      (hasColor || hasTemperature || hasBrightness)
    ) {
      const scene = this.sceneFor(desired);
      if (scene) return [scene];
    }

    const steps = [];

    if (wantsOn && (!this.power || desired.force)) {
      steps.push({
        cmd: { method: 'set_power', params: ['on', 'smooth', powerTransition] },
        commit: () => {
          this.power = 'on';
        },
      });
    }

    if (hasColor) {
      const hue = Math.round(
        desired.hue === undefined ? this.hue : desired.hue
      );
      const sat = Math.round(
        desired.sat === undefined ? this.sat : desired.sat
      );
      if (Number.isFinite(hue) && Number.isFinite(sat)) {
        steps.push({
          cmd: {
            method: 'set_hsv',
            params: [hue, sat, 'smooth', colorTransition],
          },
          commit: () => {
            this._hue = hue;
            this._sat = sat;
          },
        });
      }
    } else if (hasTemperature) {
      // Rounded like the set_scene path: set_ct_abx takes a whole Kelvin
      // value, and 1e6/300 is 3333.3333333333335 unrounded.
      const kelvin = Math.round(10 ** 6 / desired.ct);
      steps.push({
        cmd: {
          method: 'set_ct_abx',
          params: [kelvin, 'smooth', temperatureTransition],
        },
        commit: () => {
          this._temperature = desired.ct;
          this.colorMode = 2;
          this.onTemperatureApplied(desired.ct);
        },
      });
    }

    if (hasBrightness) {
      const bright = Math.min(Math.max(Math.round(desired.bright), 1), 100);
      steps.push({
        cmd: {
          method: 'set_bright',
          params: [bright, 'smooth', brightnessTransition],
        },
        commit: () => {
          this._bright = desired.bright;
        },
      });
    }

    return steps;
  }

  // Someone flicking a lamp on - from the Home app, a widget, Siri - sends a
  // bare "on" and nothing else, and the lamp comes back wherever it was left,
  // which after an evening at 10% is not what anyone means by "on". A lamp can
  // be given a brightness to wake at, and a lamp running Adaptive Lighting
  // wakes at the transition's current temperature rather than the one it was
  // switched off at.
  //
  // Decided here, at flush time, rather than in setPower: by now the
  // coalescing window has closed, so a scene that carries its own brightness
  // or colour has already landed in the same patch and is left alone.
  applyPowerOnDefaults(desired) {
    if (desired.power !== true || this.power) return desired;
    if (
      desired.bright !== undefined ||
      desired.hue !== undefined ||
      desired.sat !== undefined ||
      desired.ct !== undefined
    ) {
      return desired;
    }

    const { brightness, kelvin } = this.powerOn;
    const patch = {};
    if (brightness) patch.bright = brightness;

    // Always white, not only while a transition happens to be running: a lamp
    // last left in a colour would otherwise wake up in it, and the whole point
    // of a configured power-on is that a tap on a widget needs no follow-up.
    // A running transition's temperature is the best value there is; failing
    // that, whatever this lamp was told to wake at; failing that, the last
    // white it knew. Left unrounded - a configured 2700 K is 370.37 mired, and
    // rounding here would put 2703 K on the wire.
    // A running transition sets the temperature whether this lamp was
    // configured or not - that is what the plugin has always done on a manual
    // power-on. Without one, only a lamp that was told how to wake is taken to
    // white; the rest are left exactly where they were.
    const mired = this.adaptiveLighting
      ? this.temperature
      : brightness || kelvin
      ? kelvin
        ? 10 ** 6 / kelvin
        : this.temperature
      : undefined;
    if (Number.isFinite(mired)) patch.ct = mired;

    if (!Object.keys(patch).length) return desired;

    this.log.debug(
      `${this.tag}: waking with ${JSON.stringify(patch)} on a bare power-on.`
    );
    return Object.assign({}, desired, patch);
  }

  // set_scene turns the lamp on and applies colour plus brightness atomically.
  sceneFor(desired) {
    const bright = Math.round(
      desired.bright === undefined ? this.bright : desired.bright
    );
    // Brightness is a required parameter, so without one there is no scene.
    if (!Number.isFinite(bright)) return null;
    const level = Math.min(Math.max(bright, 1), 100);

    if (desired.hue !== undefined || desired.sat !== undefined) {
      const hue = Math.round(
        desired.hue === undefined ? this.hue : desired.hue
      );
      const sat = Math.round(
        desired.sat === undefined ? this.sat : desired.sat
      );
      if (!Number.isFinite(hue) || !Number.isFinite(sat)) return null;
      return {
        cmd: { method: 'set_scene', params: ['hsv', hue, sat, level] },
        commit: () => {
          this.power = 'on';
          this._hue = hue;
          this._sat = sat;
          this._bright = level;
        },
      };
    }

    const mired = desired.ct === undefined ? this.temperature : desired.ct;
    if (!Number.isFinite(mired)) return null;

    return {
      cmd: {
        method: 'set_scene',
        params: ['ct', Math.round(10 ** 6 / mired), level],
      },
      commit: () => {
        this.power = 'on';
        this._temperature = mired;
        this._bright = level;
        this.colorMode = 2;
        this.onTemperatureApplied(mired);
      },
    };
  }

  // Overridden by the temperature mixin.
  onTemperatureApplied() {}

  setPower(power) {
    // `force` keeps an explicit HomeKit write authoritative even when our
    // cached state disagrees with the lamp.
    return this.applyState({ power: !!power, force: true });
  }
}

module.exports = YeeBulb;
