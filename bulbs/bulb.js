const net = require('net');
const { id: nextCmdId, sleep } = require('../utils');

const MINUTE = 60000;
// A single stray chunk should never be able to grow the read buffer forever.
const MAX_BUFFER = 65536;
// How long after HomeKit switches a lamp off a write that would wake it is
// read as the tail of the same gesture rather than a new request. On
// 2026-10-10 a drag to zero reached the plugin as an Off followed, within the
// same second, by the 41% the finger had passed on the way down; the Off went
// out, then the 41% lit the lamp again - while the Home app, having sent the
// Off last, showed it as off at 41%.
const OFF_TAIL = 2000;
// A reply slower than this is worth a line in the log: the lamps answer in
// 30-240 ms when they are well.
const SLOW_REPLY = 500;

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
    // How long a command that went unanswered keeps waiting for its lamp to
    // come back before it is given up. A lamp sometimes takes a command, drops
    // off Wi-Fi without carrying it out, and rejoins the access point 6-8 s
    // later - in the logs, about one wake from off in five. A retry that gave
    // up at 7 s lost the command every time.
    this.recoverWithin = (this.config.connection || {}).recoverWithin ?? 15000;
    // The lamp announces every change it makes, our own included. Handing that
    // echo back to HomeKit is how a slider gets pulled out from under a
    // finger: the lamp confirms the value it has reached while the person is
    // still moving towards a later one, and the tile snaps backwards. What we
    // asked for is recorded here so the confirmation can be recognised.
    this.commanded = new Map();
    this.echoWindow = (this.config.connection || {}).echoWindow ?? 4000;
    // Commands go out one at a time: a burst of parallel writes is exactly
    // what the quota counts.
    this.queue = Promise.resolve();
    // State HomeKit has asked for but that has not been sent yet.
    this.desired = null;
    this.pending = null;
    this.settle = null;
    this.flushTimer = null;
    // The flush whose commands are on the wire. Only one at a time: a slider
    // streams writes faster than a lamp on Wi-Fi answers them, and queueing
    // every step behind the last is how the lamp ended up seconds behind the
    // finger. What arrives meanwhile gathers in `desired` and goes out as one.
    this.inflight = null;
    // Set by the moonlight mixin while a write that ends night mode is
    // gathering; read and cleared by the flush that sends it.
    this.leavingNightMode = false;
    // When HomeKit last asked for this lamp to be off - see OFF_TAIL.
    this.offAt = 0;
    // When HomeKit last wrote anything, so the log can show the gaps.
    this.lastHeard = 0;

    // The advertisement we were built from already carries the live state.
    this.power = props.power;
    // Whether `power` is the lamp's own word, heard on a socket that has been
    // open ever since. The lamp reports every change to every open connection,
    // so while that holds the cache cannot be wrong and an On for a lamp that
    // is already on needs no command. A closed socket may have missed a
    // change, and the next explicit On goes to the lamp again.
    this.powerSure = false;

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
        this.heard('On', value);
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

  // One line per write from HomeKit, with the gap since the previous one.
  // Homebridge stamps its log to the second, and the order and spacing of
  // writes within a second is exactly what a gesture is made of.
  heard(characteristic, value) {
    const now = Date.now();
    const gap = this.lastHeard ? now - this.lastHeard : 0;
    this.lastHeard = now;
    this.log.info(
      `${this.tag}: HomeKit set ${characteristic}=${value} (+${gap} ms).`
    );
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

  // At most one refresh a minute, and never one that HomeKit waits on. Opening
  // the Home app reads every switch on the lamp at once; each of them asking
  // separately used to put two commands ahead of whatever the finger did next.
  refreshPowerInBackground() {
    const now = Date.now();
    if (now - this.lastPowerRead < this.staleAfter) return;
    this.lastPowerRead = now;
    const props = this.backgroundProps();
    this.getProperty(props)
      .then((values) => {
        props.forEach((prop, i) => {
          if (values[i] === undefined || values[i] === '') return;
          this.updateStateFromProp(prop, values[i]);
        });
      })
      .catch((err) => {
        this.log.debug(
          `${this.tag}: background power refresh failed: ${err.message || err}.`
        );
      });
  }

  // Extended by the moonlight mixin.
  backgroundProps() {
    return ['power'];
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
      // A bedside lamp never reports active_mode - the spec marks it ceiling
      // only - so nl_br is the only sign that its night mode is on.
      'nl_br',
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
          this.powerSure = false;
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
    this.powerSure = false;
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

    const took = Date.now() - cmd.at;
    if (took > SLOW_REPLY) {
      this.log.info(`${this.tag}: cmd ${message.id} answered in ${took} ms.`);
    }

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
    this.powerSure = this.connected;
    if (!this.publishable('power', value)) return;
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
    const deadline = Date.now() + this.recoverWithin;

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
          `${this.tag}: cmd ${cmd.id} failed (${code}), waiting for the lamp to come back.`
        );
        // An unreachable host used to drop the command on the spot. It is
        // what a lamp looks like while it rejoins the access point, so it is
        // waited out like any other failure.
        // eslint-disable-next-line no-await-in-loop
        await this.reconnectBefore(deadline, cmd.id);
      }
    }

    throw new Error(`${this.tag}: cmd ${cmd.id} exhausted its retries`);
  }

  // Connection attempts cost nothing against the command quota, so the lamp
  // is knocked on until it answers or the deadline passes. The command goes
  // out again once, on the connection that answered.
  async reconnectBefore(deadline, id) {
    const started = Date.now();
    for (;;) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.connect();
        this.log.info(
          `${this.tag}: back after ${Date.now() - started} ms, resending cmd ${id}.`
        );
        return;
      } catch (err) {
        this.reset();
        if (Date.now() + 500 >= deadline) return;
        // eslint-disable-next-line no-await-in-loop
        await sleep(500);
      }
    }
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
      this.cmds[cmd.id] = { resolve, reject, timeout, at: Date.now() };
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

  // One command that replaces everything we think we know. Used when a lamp is
  // rebuilt from the accessory cache rather than from an announcement, where
  // the starting state is however the lamp was last seen - possibly yesterday.
  refreshState() {
    const props = [
      'power',
      'bright',
      'ct',
      'hue',
      'sat',
      'color_mode',
      'nl_br',
    ];
    return this.getProperty(props)
      .then((values) => {
        props.forEach((prop, i) => {
          const value = values[i];
          if (value === undefined || value === '') return;
          this.updateStateFromProp(prop, value);
        });
      })
      .catch((err) => {
        this.log.warn(
          `${this.tag}: could not read the lamp's state: ${err.message || err}.`
        );
      });
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

    // Nor may one that lands just after it, when the Off has already gone
    // out - see OFF_TAIL. The values are kept; only the waking is dropped.
    const sinceOff = Date.now() - this.offAt;
    if (next.power === true && !next.force && sinceOff < OFF_TAIL) {
      delete next.power;
      this.log.info(
        `${this.tag}: ${JSON.stringify(
          next
        )} came ${sinceOff} ms after HomeKit switched the lamp off - not waking it.`
      );
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

  // What is still waiting for the coalescing window to close, and a way to take
  // it back. A mode change can make a value that arrived a moment earlier wrong
  // before it has ever been sent: an Adaptive Lighting nudge and the night-mode
  // switch landing in the same instant is exactly that, and the nudge would go
  // out 80 ms later and end the mode the switch had just started.
  pendingState() {
    return this.desired || {};
  }

  discardPending(keys) {
    const { desired } = this;
    if (!desired) return;
    keys.forEach((key) => delete desired[key]);
    // Power was in that patch only to carry the values just dropped. An
    // explicit On or Off from HomeKit carries `force` and stays; without this
    // the flush would wake the lamp at its power-on brightness instead.
    if (desired.power === true && !desired.force) delete desired.power;
  }

  flush() {
    this.flushTimer = null;
    // Still waiting on the lamp: everything asked for since keeps gathering
    // and goes out the moment the flush on the wire lands. However fast the
    // writes come, the lamp is never more than one round-trip behind the last
    // of them, and the values a finger has already moved past are never sent.
    if (this.inflight) return;

    const { desired, settle } = this;
    this.desired = null;
    this.pending = null;
    this.settle = null;

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
    const runs = steps.map(({ cmd, commit, echo }) => {
      // Recorded at enqueue time, not on commit: the lamp's announcement can
      // arrive in the same read as the reply that resolves the command, and
      // is handled before the commit's microtask ever runs.
      if (echo) this.noteCommanded(echo);
      return this.enqueue(cmd).then(commit);
    });
    runs.forEach((run) => run.catch(() => {}));
    const inflight = Promise.all(runs);
    this.inflight = inflight;
    const landed = () => {
      this.inflight = null;
      // Whatever gathered meanwhile and has no timer of its own goes now.
      if (this.pending && !this.flushTimer) this.flush();
    };
    inflight.then(
      () => {
        settle.resolve();
        landed();
      },
      (err) => {
        settle.reject(err);
        landed();
      }
    );
  }

  noteCommanded(values) {
    const at = Date.now();
    Object.entries(values).forEach(([prop, value]) => {
      if (value === undefined || value === null) return;
      this.commanded.set(prop, { value: String(value), at });
    });
  }

  // Whether a property change is news for HomeKit. Our own echo is not: the
  // controller already holds the value it asked for, and pushing the lamp's
  // confirmation on top of it only fights whoever is still dragging. A change
  // from anywhere else - the lamp's own button, the Yeelight app, a scene
  // running on the lamp - does not match anything we asked for and goes
  // through.
  publishable(prop, value) {
    // A newer value for the same property has not been sent yet, so what the
    // lamp is reporting is already out of date.
    if (this.desired && this.desired[prop] !== undefined) return false;

    const commanded = this.commanded.get(prop);
    if (!commanded) return true;
    if (Date.now() - commanded.at > this.echoWindow) return true;
    return String(value) !== commanded.value;
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
          echo: { power: 'off' },
          commit: () => this.poweredBy('off'),
        },
      ];
    }

    desired = this.applyPowerOnDefaults(desired);

    const wantsOn = desired.power === true;
    const hasColor = desired.hue !== undefined || desired.sat !== undefined;
    const hasTemperature = desired.ct !== undefined;
    const hasBrightness = desired.bright !== undefined;

    // A lamp that is off and is not being woken has nothing to take: the
    // spec accepts set_bright, set_ct_abx and set_hsv only while it is on. The
    // values are kept for when it is.
    if (!wantsOn && !this.power) {
      this.remember(desired);
      return [];
    }

    // Leaving night mode is done by set_ct_abx and set_bright, which are
    // verified to end it on these lamps; set_scene is not, so it is kept out.
    const leavingNight = this.leavingNightMode;
    this.leavingNightMode = false;

    // One set_scene where there would be several commands. Waking a lamp it
    // carries power, colour and brightness together. On a lamp that is lit it
    // replaces set_ct_abx plus set_bright - which is every step of a
    // brightness slider while Adaptive Lighting is on, since HAP answers each
    // brightness change with a colour temperature write of its own. Half the
    // commands is half the time the lamp spends behind the finger.
    const wake =
      wantsOn && !this.power && (hasColor || hasTemperature || hasBrightness);
    const combined =
      !leavingNight && hasBrightness && (hasColor || hasTemperature);
    if (wake || combined) {
      const scene = this.sceneFor(desired);
      if (scene) return [scene];
    }

    const steps = [];

    // An explicit On is still sent to a lamp the cache believes is on, unless
    // the lamp itself said so on a socket that has stayed open since. The
    // Home app sends On with many brightness writes, and each of those used
    // to cost a set_power the lamp did not need.
    if (wantsOn && (!this.power || (desired.force && !this.powerSure))) {
      steps.push({
        cmd: { method: 'set_power', params: ['on', 'smooth', powerTransition] },
        echo: { power: 'on' },
        commit: () => this.poweredBy('on'),
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
          echo: { hue, sat },
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
        echo: { ct: kelvin },
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
        echo: { bright },
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
        echo: { power: 'on', hue, sat, bright: level },
        commit: () => {
          this.poweredBy('on');
          this._hue = hue;
          this._sat = sat;
          this._bright = level;
        },
      };
    }

    const mired = desired.ct === undefined ? this.temperature : desired.ct;
    if (!Number.isFinite(mired)) return null;

    const kelvin = Math.round(10 ** 6 / mired);
    return {
      cmd: { method: 'set_scene', params: ['ct', kelvin, level] },
      echo: { power: 'on', ct: kelvin, bright: level },
      commit: () => {
        this.poweredBy('on');
        this._temperature = mired;
        this._bright = level;
        this.colorMode = 2;
        this.onTemperatureApplied(mired);
      },
    };
  }

  // Overridden by the temperature mixin.
  onTemperatureApplied() {}

  // Overridden by the moonlight mixin. Every mixin that writes to the lamp asks
  // this before it does: night mode is a state the firmware drops on its own
  // the moment a brightness or temperature command lands.
  get nightMode() {
    return false;
  }

  // Overridden by the moonlight mixin, which uses it to take its switch down
  // when a write it cannot stop is about to end the mode.
  nightModeEnded() {}

  // updateValue, never setValue: the first is how a plugin reports a change it
  // made itself, the second reads as a HomeKit write and takes Adaptive
  // Lighting down with it.
  reflect(values) {
    Object.entries(values).forEach(([characteristic, value]) => {
      if (value === undefined || value === null) return;
      this.service
        .getCharacteristic(global.Characteristic[characteristic])
        .updateValue(value);
    });
  }

  // A command of ours changed the lamp's power. HomeKit hears about it here,
  // because it will not hear it from the lamp: the lamp's announcement is our
  // own echo and is held back. That is right when HomeKit asked for the change
  // with On, and wrong when it came from Brightness - a drag to zero switched
  // the lamp off while the tile went on showing it lit, and a brightness write
  // that woke a lamp left the tile saying "Powered Off" over a lamp that was
  // on. updateValue sends nothing when the value is already the same.
  poweredBy(state) {
    this.power = state;
    this.powerSure = this.connected;
    this.reflect({ On: this.power });
  }

  // Values for a lamp that is off and staying off, kept for when it wakes.
  remember(desired) {
    if (desired.bright !== undefined) this._bright = Number(desired.bright);
    if (desired.ct !== undefined) this._temperature = desired.ct;
    if (desired.hue !== undefined) this._hue = Number(desired.hue);
    if (desired.sat !== undefined) this._sat = Number(desired.sat);
  }

  setPower(power) {
    // A later write that would wake the lamp is weighed against this - see
    // OFF_TAIL. An explicit On ends that at once.
    this.offAt = power ? 0 : Date.now();
    // `force` keeps an explicit HomeKit write authoritative even when our
    // cached state disagrees with the lamp.
    return this.applyState({ power: !!power, force: true });
  }
}

module.exports = YeeBulb;
