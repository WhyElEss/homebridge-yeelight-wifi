const { FakeLamp, makeBulb, sleep } = require('./harness');
const {
  ALERT,
  MOONLIGHT,
  configureAlert,
  removeSwitch,
  removeLegacySwitches,
} = require('../switches');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}  -> ${detail}`);
  }
};

// A HomeKit scene: HAP dispatches every characteristic write in the same tick.
const scene = (service, writes) =>
  Promise.all(
    Object.entries(writes).map(([char, value]) =>
      service.getCharacteristic(char).write(value)
    )
  );

// Both switches sit on the lamp's own accessory and are told apart by subtype.
const moonlightSwitch = (accessory) =>
  accessory.getServiceById(global.Service.Switch, MOONLIGHT);
const alertSwitch = (accessory) =>
  accessory.getServiceById(global.Service.Switch, ALERT);

// Just enough platform for the switch wiring: a log and the shelf the legacy
// alert accessories were restored onto.
const fakePlatform = () => {
  const unregistered = [];
  return {
    log: Object.assign(() => {}, { warn: () => {}, debug: () => {} }),
    alerts: {},
    unregistered,
    api: {
      unregisterPlatformAccessories: (_p, _n, accessories) =>
        unregistered.push(...accessories),
    },
  };
};

async function run() {
  // ---------------------------------------------------------------- 1
  console.log('\n1. Automation on a lamp that is off (On + Brightness + CT)');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { bulb, service } = await makeBulb(lamp);
    await scene(service, { On: true, Brightness: 100, ColorTemperature: 370 });
    await sleep(200);
    const m = lamp.methods();
    console.log(
      '     wire:',
      JSON.stringify(lamp.received.map((r) => [r.method, r.params]))
    );
    check('one command total', m.length === 1, `${m.length}: ${m}`);
    check('it is set_scene', m[0] === 'set_scene', m[0]);
    check(
      'scene carries ct + brightness',
      JSON.stringify(lamp.received[0].params) ===
        JSON.stringify(['ct', 2703, 100]),
      JSON.stringify(lamp.received[0].params)
    );
    check(
      'no duplicate set_power',
      m.filter((x) => x === 'set_power').length === 0,
      `${m}`
    );
    check('power cached on', bulb.power === true, `${bulb.power}`);
    await lamp.close();
  }

  // ---------------------------------------------------------------- 2
  console.log('\n2. Same automation on a SLOW lamp (500ms replies)');
  {
    const lamp = new FakeLamp({ delay: 500 });
    await lamp.listen();
    const { service } = await makeBulb(lamp);
    await scene(service, { On: true, Brightness: 100, ColorTemperature: 370 });
    await sleep(300);
    const m = lamp.methods();
    check('still exactly one write', m.length === 1, `${m.length}: ${m}`);
    check(
      'no re-send of the same command',
      new Set(lamp.received.map((r) => r.id)).size === m.length,
      JSON.stringify(lamp.received.map((r) => r.id))
    );
    await lamp.close();
  }

  // ---------------------------------------------------------------- 3
  console.log('\n3. Lamp that accepts but never answers (the old storm case)');
  {
    const lamp = new FakeLamp({ silent: true });
    await lamp.listen();
    const { service } = await makeBulb(lamp, {
      connection: { timeout: 300, retries: 1 },
    });
    const started = Date.now();
    await scene(service, {
      On: true,
      Brightness: 100,
      ColorTemperature: 370,
    }).catch(() => {});
    const elapsed = Date.now() - started;
    // The handler answers HomeKit at once now, so the retry ladder runs after
    // the write has already been accepted - wait it out before counting.
    await sleep(1500);
    const m = lamp.methods();
    const scenes = m.filter((x) => x === 'set_scene');
    console.log(
      `     writes=${JSON.stringify(m)} connections=${
        lamp.connections
      } elapsed=${elapsed}ms`
    );
    check(
      'scene written at most twice (1 try + 1 retry)',
      scenes.length <= 2,
      `${scenes.length}`
    );
    check('HomeKit was never made to wait', elapsed < 50, `${elapsed}ms`);
    check(
      'retry used a fresh connection',
      lamp.connections >= 2,
      `${lamp.connections}`
    );
    check('no sockets left open', lamp.live === 0, `${lamp.live} live`);
    await lamp.close();
  }

  // ---------------------------------------------------------------- 4
  console.log('\n4. Brightness only, lamp already on');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { service } = await makeBulb(lamp, {}, { power: 'on' });
    await scene(service, { Brightness: 40 });
    await sleep(200);
    const m = lamp.methods();
    check('one command', m.length === 1, `${m.length}: ${m}`);
    check('smooth set_bright, not a scene', m[0] === 'set_bright', m[0]);
    check(
      'transition preserved',
      lamp.received[0].params[1] === 'smooth',
      JSON.stringify(lamp.received[0].params)
    );
    await lamp.close();
  }

  // ---------------------------------------------------------------- 5
  console.log('\n5. Hue + Saturation arriving as two writes');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { service } = await makeBulb(lamp, {}, { power: 'on' });
    await scene(service, { Hue: 120, Saturation: 80 });
    await sleep(200);
    const m = lamp.methods();
    check(
      'merged into one set_hsv',
      m.length === 1 && m[0] === 'set_hsv',
      `${m}`
    );
    check(
      'carries both values',
      JSON.stringify(lamp.received[0].params.slice(0, 2)) === '[120,80]',
      JSON.stringify(lamp.received[0].params)
    );
    await lamp.close();
  }

  // ---------------------------------------------------------------- 6
  console.log('\n6. Explicit Off wins over a colour write in the same window');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { service } = await makeBulb(lamp, {}, { power: 'on' });
    await scene(service, { On: false, Brightness: 100 });
    await sleep(200);
    const m = lamp.methods();
    check(
      'single set_power off',
      m.length === 1 && m[0] === 'set_power',
      `${m}`
    );
    check(
      'param is off',
      lamp.received[0].params[0] === 'off',
      JSON.stringify(lamp.received[0].params)
    );
    await lamp.close();
  }

  // ---------------------------------------------------------------- 7
  console.log('\n7. Explicit On is sent even when the cache already says on');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { service } = await makeBulb(lamp, {}, { power: 'on' });
    await scene(service, { On: true });
    await sleep(200);
    const m = lamp.methods();
    check(
      'set_power on still sent',
      m.length === 1 && m[0] === 'set_power',
      `${m}`
    );
    await lamp.close();
  }

  // ---------------------------------------------------------------- 8
  console.log('\n8. Quota guard');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { bulb } = await makeBulb(lamp, {
      connection: { quota: 5, coalesce: 0 },
    });
    bulb.sent = [];
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await bulb.getProperty(['power']);
    }
    const before = lamp.methods().length;
    let held = false;
    const blocked = bulb.getProperty(['power']).then(() => {
      held = true;
    });
    await sleep(400);
    check(
      '5 sent, 6th held back',
      before === 5 && !held,
      `sent=${before} held=${!held}`
    );
    check(
      'nothing extra reached the lamp',
      lamp.methods().length === 5,
      `${lamp.methods().length}`
    );
    blocked.catch(() => {});
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 9
  console.log('\n9. Commands are serialised, never parallel');
  {
    const lamp = new FakeLamp({ delay: 60 });
    await lamp.listen();
    const { bulb } = await makeBulb(lamp, { connection: { coalesce: 0 } });
    let maxLive = 0;
    const original = bulb.write.bind(bulb);
    let inFlight = 0;
    bulb.write = (cmd, msg) => {
      inFlight += 1;
      maxLive = Math.max(maxLive, inFlight);
      return original(cmd, msg).finally(() => {
        inFlight -= 1;
      });
    };
    await Promise.all([
      bulb.getProperty(['power']),
      bulb.getProperty(['bright']),
      bulb.getProperty(['ct']),
      bulb.getProperty(['hue']),
    ]);
    check('only one command in flight at a time', maxLive === 1, `${maxLive}`);
    check(
      'all four delivered',
      lamp.methods().length === 4,
      `${lamp.methods().length}`
    );
    check(
      'a single TCP connection reused',
      lamp.connections === 1,
      `${lamp.connections}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 10
  console.log('\n10. Split TCP reads must not crash the parser');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { bulb } = await makeBulb(lamp);
    let resolved = false;
    bulb.cmds[999] = {
      resolve: () => {
        resolved = true;
      },
      reject: () => {},
      timeout: setTimeout(() => {}, 5000),
    };
    const payload = JSON.stringify({ id: 999, result: ['ok'] }) + '\r\n';
    bulb.onData(Buffer.from(payload.slice(0, 9)));
    check('half a message resolves nothing yet', !resolved, 'resolved early');
    bulb.onData(Buffer.from(payload.slice(9)));
    check('completed message resolves', resolved, 'never resolved');
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 11
  console.log('\n11. Lamp moves to a new IP');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { bulb } = await makeBulb(lamp);
    const moved = new FakeLamp();
    await moved.listen();
    bulb.relocate(`127.0.0.1:${moved.port}`);
    await bulb.getProperty(['power']);
    check(
      'command went to the new endpoint',
      moved.methods().length === 1,
      `${moved.methods().length}`
    );
    check('old socket dropped', lamp.live === 0, `${lamp.live} live`);
    bulb.reset();
    await lamp.close();
    await moved.close();
  }

  // ---------------------------------------------------------------- 12
  console.log('\n12. Lamp hangs up mid-command (the failure seen in the logs)');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    // Armed only after setup, so it hits the command we actually measure and
    // not the moonlight probe.
    let hangUp = false;
    lamp.server.on('connection', (sock) => {
      sock.on('data', () => {
        if (!hangUp) return;
        hangUp = false;
        sock.end();
      });
    });
    const { bulb } = await makeBulb(lamp);
    lamp.reset();
    hangUp = true;
    const started = Date.now();
    const result = await bulb.getProperty(['power']).then(
      () => 'ok',
      () => 'failed'
    );
    const elapsed = Date.now() - started;
    const writes = lamp.methods().filter((x) => x === 'get_prop').length;
    console.log(`     result=${result} writes=${writes} elapsed=${elapsed}ms`);
    check('recovered on the retry', result === 'ok', result);
    check('cost exactly one extra write', writes === 2, `${writes}`);
    check('recovered fast, no 6s ladder', elapsed < 1500, `${elapsed}ms`);
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 13
  console.log('\n13. Alert on a lamp that is already lit');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { bulb } = await makeBulb(
      lamp,
      {},
      { power: 'on', alert: { enabled: true, hue: 0, saturation: 100 } }
    );
    bulb.alertService = new global.Service.Switch('Lamp Alert');
    await bulb.setAlert(true);
    await sleep(150);
    const m = lamp.methods();
    check('one command', m.length === 1, `${m.length}: ${m}`);
    check('it is set_hsv, no extra set_power', m[0] === 'set_hsv', `${m}`);
    check(
      'carries the alert colour',
      JSON.stringify(lamp.received[0].params.slice(0, 2)) === '[0,100]',
      JSON.stringify(lamp.received[0].params)
    );
    check(
      'snapshot taken from the pre-alert state',
      bulb.alertSnapshot.hue === 10 && bulb.alertSnapshot.sat === 20,
      JSON.stringify(bulb.alertSnapshot)
    );
    check(
      'switch reflects the alert',
      bulb.alertService.getCharacteristic('On').value === true,
      `${bulb.alertService.getCharacteristic('On').value}`
    );
    await lamp.close();
  }

  // ---------------------------------------------------------------- 14
  console.log('\n14. Restore puts the colour back in one command');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { bulb } = await makeBulb(
      lamp,
      {},
      { power: 'on', alert: { enabled: true, hue: 0, saturation: 100 } }
    );
    await bulb.setAlert(true);
    await sleep(150);
    lamp.reset();
    await bulb.setAlert(false);
    await sleep(150);
    const m = lamp.methods();
    check('one command', m.length === 1, `${m.length}: ${m}`);
    check('back through set_hsv', m[0] === 'set_hsv', `${m}`);
    check(
      'exactly the snapshotted colour',
      JSON.stringify(lamp.received[0].params.slice(0, 2)) === '[10,20]',
      JSON.stringify(lamp.received[0].params)
    );
    check(
      'no brightness command, since the alert never moved it',
      !m.includes('set_bright'),
      `${m}`
    );
    check('alert cleared', bulb.alertActive === false, `${bulb.alertActive}`);
    await lamp.close();
  }

  // ---------------------------------------------------------------- 15
  console.log('\n15. Alert on a lamp that was off, then restored to off');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { bulb } = await makeBulb(
      lamp,
      {},
      { power: 'off', alert: { enabled: true, hue: 0, saturation: 100 } }
    );
    await bulb.setAlert(true);
    await sleep(150);
    check(
      'lit by a single set_scene',
      lamp.methods().length === 1 && lamp.methods()[0] === 'set_scene',
      `${lamp.methods()}`
    );
    lamp.reset();
    await bulb.setAlert(false);
    await sleep(200);
    const m = lamp.methods();
    check(
      'two commands: colour, then off',
      m.length === 2,
      `${m.length}: ${m}`
    );
    check('colour goes first', m[0] === 'set_hsv', `${m}`);
    check(
      'off goes last, in its own flush',
      m[1] === 'set_power' && lamp.received[1].params[0] === 'off',
      JSON.stringify(lamp.received.map((r) => [r.method, r.params]))
    );
    check('lamp is off again', bulb.power === false, `${bulb.power}`);
    await lamp.close();
  }

  // ---------------------------------------------------------------- 16
  console.log('\n16. Adaptive Lighting nudges are swallowed while flashing');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { bulb, service } = await makeBulb(
      lamp,
      {},
      { power: 'on', alert: { enabled: true, hue: 0, saturation: 100 } }
    );
    // The real controller reports this while a transition is running.
    bulb.controller = { isAdaptiveLightingActive: () => true };
    bulb.colorMode = 2;
    await bulb.setAlert(true);
    await sleep(150);
    lamp.reset();

    // How HAP-NodeJS delivers a nudge: the SET handler, with the controller
    // in the context.
    await service
      .getCharacteristic('ColorTemperature')
      .write(300, { controller: {}, omitEventUpdate: true });
    await sleep(150);
    check(
      'nudge never reached the lamp',
      lamp.methods().length === 0,
      `${lamp.methods()}`
    );
    check(
      'but its value was remembered',
      bulb.temperature === 300,
      `${bulb.temperature}`
    );

    await bulb.setAlert(false);
    await sleep(150);
    const m = lamp.methods();
    check('restored as a temperature', m[0] === 'set_ct_abx', `${m}`);
    check(
      'lands on the current curve point, not the stale one',
      lamp.received[0].params[0] === Math.round(10 ** 6 / 300),
      JSON.stringify(lamp.received[0].params)
    );
    await lamp.close();
  }

  // ---------------------------------------------------------------- 17
  console.log('\n17. The alert never performs a HomeKit write');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { bulb, service } = await makeBulb(
      lamp,
      {},
      {
        power: 'on',
        alert: { enabled: true, hue: 0, saturation: 100, brightness: 100 },
      }
    );
    bulb.controller = { isAdaptiveLightingActive: () => true };
    await bulb.setAlert(true);
    await sleep(150);
    await bulb.setAlert(false);
    await sleep(200);
    const written = [
      'Hue',
      'Saturation',
      'ColorTemperature',
      'Brightness',
      'On',
    ]
      .map((c) => [c, service.getCharacteristic(c).hapWrites])
      .filter(([, writes]) => writes.length);
    // A write is what HAP-NodeJS reads as "the user changed this by hand", and
    // it disables the running Adaptive Lighting transition permanently.
    check(
      'no setValue on any characteristic',
      written.length === 0,
      JSON.stringify(written)
    );
    check(
      'HomeKit still told about the colour, via updateValue',
      service.getCharacteristic('Hue').value === 10,
      `${service.getCharacteristic('Hue').value}`
    );
    await lamp.close();
  }

  // ---------------------------------------------------------------- 18
  console.log('\n18. Per-lamp config: devices[], defaultValue, and the keys');
  {
    const {
      getName,
      blacklist,
      deviceEntry,
      resolveAlert,
      resolveMoonlight,
      resolvePowerOn,
    } = require('../utils');
    const full = '0x000000001778cb4e';
    const keys = ['bslamp3-78cb4e', '78cb4e', full];

    const byDevices = {
      devices: [
        { id: full, name: 'Main Bedroom', alert: { enabled: true, hue: 240 } },
        { id: 'aaaaaa', name: 'Other', alert: { enabled: true } },
      ],
    };
    const alertFor = (config) => resolveAlert(deviceEntry(config, keys));
    check(
      'a lamp is found by its full id',
      getName(byDevices, keys) === 'Main Bedroom',
      getName(byDevices, keys)
    );
    check(
      'the lamp keeps its own colour, the rest falls back to red',
      JSON.stringify(alertFor(byDevices)) ===
        JSON.stringify({ enabled: true, hue: 240, saturation: 100 }),
      JSON.stringify(alertFor(byDevices))
    );
    check(
      'a lamp with no alert block has no alert',
      resolveAlert({ name: 'Plain' }).enabled === false,
      ''
    );
    check(
      'a platform-wide alert block is ignored',
      resolveAlert(deviceEntry({ alert: { enabled: true } }, keys)).enabled ===
        false,
      ''
    );
    check(
      'brightness 0 means leave it alone',
      alertFor({
        devices: [{ id: full, alert: { enabled: true, brightness: 0 } }],
      }).brightness === undefined,
      ''
    );
    check(
      'a real brightness survives',
      alertFor({
        devices: [{ id: full, alert: { enabled: true, brightness: 40 } }],
      }).brightness === 40,
      ''
    );

    const shortKey = { devices: [{ id: '78cb4e', name: 'Short' }] };
    const modelKey = { devices: [{ id: 'BSLAMP3-78CB4E', name: 'Model' }] };
    check('found by six characters', getName(shortKey, keys) === 'Short', '');
    check(
      'found by <model>-<id>, case-insensitively',
      getName(modelKey, keys) === 'Model',
      getName(modelKey, keys)
    );

    const legacy = {
      defaultValue: { '78cb4e': { name: 'Legacy', alert: true } },
    };
    check(
      'defaultValue still works',
      getName(legacy, keys) === 'Legacy',
      getName(legacy, keys)
    );
    check(
      'alert: true is the shorthand for the default red',
      JSON.stringify(resolveAlert(deviceEntry(legacy, keys))) ===
        JSON.stringify({ enabled: true, hue: 0, saturation: 100 }),
      JSON.stringify(resolveAlert(deviceEntry(legacy, keys)))
    );

    const both = {
      devices: [{ id: '78cb4e', name: 'From devices' }],
      defaultValue: { '78cb4e': { name: 'From defaultValue' } },
    };
    check(
      'devices[] wins over defaultValue',
      getName(both, keys) === 'From devices',
      getName(both, keys)
    );

    check(
      'unlisted lamps keep the generated name',
      getName({ devices: [] }, keys) === 'bslamp3-78cb4e',
      getName({ devices: [] }, keys)
    );
    check(
      'hidden hides the lamp entirely',
      blacklist({ devices: [{ id: '78cb4e', hidden: true }] }, keys) === true,
      ''
    );
    check(
      'a capability list is passed through',
      JSON.stringify(
        blacklist({ devices: [{ id: '78cb4e', blacklist: ['set_hsv'] }] }, keys)
      ) === '["set_hsv"]',
      ''
    );
    // The moonlight switch is opted out of, not into: a lamp that has the mode
    // gets it unless its own entry says otherwise.
    const moonlightFor = (config) =>
      resolveMoonlight(deviceEntry(config, keys));
    check(
      'a lamp with no entry at all keeps its moonlight switch',
      moonlightFor({}) === true,
      ''
    );
    check(
      'and so does one that simply says nothing about it',
      moonlightFor({ devices: [{ id: '78cb4e', name: 'Main Bedroom' }] }) ===
        true,
      ''
    );
    check(
      'false is the one thing that takes it away',
      moonlightFor({ devices: [{ id: '78cb4e', moonlight: false }] }) === false,
      ''
    );
    check(
      'and it belongs to that lamp only',
      moonlightFor({ devices: [{ id: 'aaaaaa', moonlight: false }] }) === true,
      ''
    );

    check(
      'a zero wake temperature means the last white the lamp knew',
      resolvePowerOn({ powerOn: { kelvin: 0 } }).kelvin === undefined,
      String(resolvePowerOn({ powerOn: { kelvin: 0 } }).kelvin)
    );
    check(
      'a named wake temperature is kept as it was written',
      resolvePowerOn({ powerOn: { kelvin: 4000 } }).kelvin === 4000,
      String(resolvePowerOn({ powerOn: { kelvin: 4000 } }).kelvin)
    );
    check(
      'a temperature below the lamp is lifted to 1700, not to nothing',
      resolvePowerOn({ powerOn: { kelvin: 1000 } }).kelvin === 1700,
      String(resolvePowerOn({ powerOn: { kelvin: 1000 } }).kelvin)
    );

    const clamped = resolveAlert({
      alert: { enabled: true, hue: 999, saturation: -5, brightness: 200 },
    });
    check(
      'out-of-range values are clamped',
      JSON.stringify(clamped) ===
        JSON.stringify({
          enabled: true,
          hue: 360,
          saturation: 0,
          brightness: 100,
        }),
      JSON.stringify(clamped)
    );
  }

  // ---------------------------------------------------------------- 19
  console.log('\n19. A bare power-on wakes the lamp the way it was told to');
  {
    const armed = (bulb) => {
      bulb.controller = { isAdaptiveLightingActive: () => true };
      return bulb;
    };

    // a. brightness plus the Adaptive Lighting curve, in one command
    let lamp = new FakeLamp();
    await lamp.listen();
    let made = await makeBulb(lamp, {}, { powerOn: { brightness: 100 } });
    armed(made.bulb);
    await scene(made.service, { On: true });
    await sleep(200);
    let m = lamp.methods();
    check('one command', m.length === 1, `${m.length}: ${m}`);
    check('it is a scene', m[0] === 'set_scene', `${m}`);
    check(
      'carries the curve temperature and the configured brightness',
      JSON.stringify(lamp.received[0].params) ===
        JSON.stringify(['ct', 2703, 100]),
      JSON.stringify(lamp.received[0].params)
    );
    await lamp.close();

    // b. a scene brings its own brightness, which must win
    lamp = new FakeLamp();
    await lamp.listen();
    made = await makeBulb(lamp, {}, { powerOn: { brightness: 100 } });
    armed(made.bulb);
    await scene(made.service, { On: true, Brightness: 40 });
    await sleep(200);
    check(
      "the scene's own brightness is left alone",
      JSON.stringify(lamp.received[0].params) ===
        JSON.stringify(['ct', 2703, 40]),
      JSON.stringify(lamp.received[0].params)
    );
    await lamp.close();

    // c. a lamp that is already lit is not reset by a redundant On
    lamp = new FakeLamp();
    await lamp.listen();
    made = await makeBulb(
      lamp,
      {},
      { power: 'on', powerOn: { brightness: 100 } }
    );
    armed(made.bulb);
    await scene(made.service, { On: true });
    await sleep(200);
    m = lamp.methods();
    check(
      'a redundant On stays a plain set_power',
      m.length === 1 && m[0] === 'set_power',
      `${m}`
    );
    await lamp.close();

    // d. no brightness configured: the curve alone still comes back
    lamp = new FakeLamp();
    await lamp.listen();
    made = await makeBulb(lamp, {}, {});
    armed(made.bulb);
    await scene(made.service, { On: true });
    await sleep(200);
    check(
      'Adaptive Lighting wakes the lamp on the curve, in one command',
      lamp.methods().length === 1 &&
        JSON.stringify(lamp.received[0].params) ===
          JSON.stringify(['ct', 2703, 50]),
      JSON.stringify(lamp.received.map((r) => [r.method, r.params]))
    );
    await lamp.close();

    // e. a lamp left in a colour still wakes white, with no transition running
    lamp = new FakeLamp();
    await lamp.listen();
    made = await makeBulb(
      lamp,
      {},
      { powerOn: { brightness: 100, kelvin: 2700 }, hue: '120', sat: '100' }
    );
    await scene(made.service, { On: true });
    await sleep(200);
    check(
      'wakes white at the configured temperature, not in the colour',
      JSON.stringify(lamp.received[0].params) ===
        JSON.stringify(['ct', 2700, 100]),
      JSON.stringify(lamp.received[0].params)
    );
    await lamp.close();

    // f. a running transition beats the configured temperature
    lamp = new FakeLamp();
    await lamp.listen();
    made = await makeBulb(
      lamp,
      {},
      { powerOn: { brightness: 100, kelvin: 2700 } }
    );
    armed(made.bulb);
    await scene(made.service, { On: true });
    await sleep(200);
    check(
      'the curve wins while Adaptive Lighting is running',
      JSON.stringify(lamp.received[0].params) ===
        JSON.stringify(['ct', 2703, 100]),
      JSON.stringify(lamp.received[0].params)
    );
    await lamp.close();

    // g. nothing configured, no Adaptive Lighting: unchanged behaviour
    lamp = new FakeLamp();
    await lamp.listen();
    made = await makeBulb(lamp, {}, {});
    await scene(made.service, { On: true });
    await sleep(200);
    m = lamp.methods();
    check(
      'a plain lamp still just gets set_power',
      m.length === 1 && m[0] === 'set_power',
      `${m}`
    );
    await lamp.close();
  }

  // ---------------------------------------------------------------- 20
  console.log('\n20. HomeKit reads are answered from memory');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { bulb, service } = await makeBulb(lamp, {}, { power: 'on' });
    bulb.lastPowerRead = Date.now();

    const started = Date.now();
    const values = [];
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      values.push(await service.getCharacteristic('On').read());
    }
    const elapsed = Date.now() - started;
    await sleep(150);
    check(
      'five reads, nothing on the wire',
      lamp.methods().length === 0,
      `${lamp.methods()}`
    );
    check('the cached value came back', values.every(Boolean), `${values}`);
    check('and it was instant', elapsed < 50, `${elapsed}ms`);

    // A stale cache asks the lamp, but in the background.
    bulb.lastPowerRead = 0;
    await service.getCharacteristic('On').read();
    await sleep(200);
    check(
      'a stale read refreshes behind HomeKit',
      lamp.methods().length === 1 && lamp.methods()[0] === 'get_prop',
      `${lamp.methods()}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 21
  console.log('\n21. Colour temperature is advertised inside the HAP range');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { service } = await makeBulb(lamp);
    const { props } = service.getCharacteristic('ColorTemperature');
    check(
      '588 mired is narrowed to the 500 HomeKit defines',
      props.maxValue === 500,
      JSON.stringify(props)
    );
    check(
      'the warm end is left alone',
      props.minValue === 154,
      JSON.stringify(props)
    );
    await lamp.close();
  }

  // ---------------------------------------------------------------- 21b
  console.log('\n21b. The moonlight read is answered from memory too');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { bulb, accessory } = await makeBulb(lamp, {}, { power: 'on' });
    const moonlight = moonlightSwitch(accessory);
    if (!moonlight) {
      check('a moonlight switch exists to read', false, 'no switch service');
    } else {
      bulb.lastPowerRead = Date.now();
      await moonlight.getCharacteristic('On').read();
      await sleep(150);
      check(
        'no command for a read',
        lamp.methods().length === 0,
        `${lamp.methods()}`
      );
    }
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 22
  console.log('\n22. Writes are accepted at once, not when the lamp answers');
  {
    const lamp = new FakeLamp({ delay: 600 });
    await lamp.listen();
    const { service } = await makeBulb(lamp, {}, { power: 'on' });

    const started = Date.now();
    await service.getCharacteristic('Brightness').write(40);
    const elapsed = Date.now() - started;
    check('the handler returned immediately', elapsed < 50, `${elapsed}ms`);
    check(
      'nothing on the wire yet',
      lamp.methods().length === 0,
      `${lamp.methods()}`
    );
    await sleep(900);
    check(
      'and the command still went out',
      lamp.methods().length === 1 && lamp.methods()[0] === 'set_bright',
      `${lamp.methods()}`
    );
    await lamp.close();
  }

  // ---------------------------------------------------------------- 23
  console.log('\n23. A command the lamp never takes puts HomeKit back');
  {
    const lamp = new FakeLamp({ silent: true });
    await lamp.listen();
    const { service } = await makeBulb(lamp, {
      connection: { timeout: 200, retries: 0 },
    });
    service.getCharacteristic('On').updateValue(false);
    await service.getCharacteristic('On').write(true);
    check(
      'HomeKit was told yes straight away',
      service.getCharacteristic('On').value === true,
      `${service.getCharacteristic('On').value}`
    );
    await sleep(1200);
    check(
      'and corrected once the lamp never answered',
      service.getCharacteristic('On').value === false,
      `${service.getCharacteristic('On').value}`
    );
    await lamp.close();
  }

  // ---------------------------------------------------------------- 24
  console.log('\n24. A lamp rebuilt from the cache asks what state it is in');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    // As if restored after a restart: the cache said on at 50, the lamp has
    // since been switched off at the wall.
    const { bulb, service } = await makeBulb(lamp, {}, { power: 'on' });
    lamp.reply = null;
    const original = bulb.getProperty.bind(bulb);
    bulb.getProperty = (props) =>
      original(props).then(() => ['off', '30', '370', '10', '20', '2']);

    await bulb.refreshState();
    await sleep(100);
    check(
      'one command, and it is a get_prop',
      lamp.methods().length === 1 && lamp.methods()[0] === 'get_prop',
      `${lamp.methods()}`
    );
    check('power corrected', bulb.power === false, `${bulb.power}`);
    check('brightness corrected', bulb.bright === 30, `${bulb.bright}`);
    check(
      'HomeKit was told as well',
      service.getCharacteristic('On').value === false &&
        service.getCharacteristic('Brightness').value === 30,
      `${service.getCharacteristic('On').value} ${
        service.getCharacteristic('Brightness').value
      }`
    );
    bulb.reset();
    await lamp.close();
  }

  // A bedside lamp: no active_mode at all, and a real nl_br. This is the shape
  // the plugin used to miss, since it asked only about active_mode.
  const bedsideLamp = (nl = '0') =>
    new FakeLamp({ props: { active_mode: '', nl_br: nl } });

  // ---------------------------------------------------------------- 25
  console.log('\n25. Night mode is found through nl_br, not active_mode');
  {
    const lamp = bedsideLamp('0');
    await lamp.listen();
    const { bulb, accessory } = await makeBulb(lamp, {}, { power: 'on' });
    const moonlight = moonlightSwitch(accessory);
    check('the lamp gets a moonlight switch', !!moonlight, 'no switch service');
    check(
      'the mode is read from nl_br',
      bulb.moonlightProp === 'nl_br',
      `${bulb.moonlightProp}`
    );
    check(
      'and it starts off',
      !!moonlight && moonlight.getCharacteristic('On').value === false,
      `${moonlight && moonlight.getCharacteristic('On').value}`
    );
    bulb.reset();
    await lamp.close();

    const plain = new FakeLamp({ props: { active_mode: '', nl_br: '' } });
    await plain.listen();
    const { bulb: dumb, accessory: bare } = await makeBulb(plain);
    check(
      'a lamp that knows neither property gets no switch',
      !moonlightSwitch(bare),
      'a switch was added anyway'
    );
    dumb.reset();
    await plain.close();
  }

  // ---------------------------------------------------------------- 26
  console.log('\n26. Switching it on is one set_power, carrying mode 5');
  {
    const lamp = bedsideLamp('0');
    await lamp.listen();
    const { bulb, service, accessory } = await makeBulb(
      lamp,
      {},
      { power: 'off', bright: '60' }
    );
    const moonlight = moonlightSwitch(accessory);
    await moonlight.getCharacteristic('On').write(true);
    await sleep(200);
    const m = lamp.methods();
    check('one command total', m.length === 1, `${m.length}: ${m}`);
    check(
      'and it is set_power with mode 5',
      m[0] === 'set_power' &&
        JSON.stringify(lamp.received[0].params) ===
          JSON.stringify(['on', 'smooth', 400, 5]),
      JSON.stringify(lamp.received.map((r) => [r.method, r.params]))
    );
    check(
      'HomeKit shows the lamp on at the night light',
      service.getCharacteristic('On').value === true &&
        service.getCharacteristic('Brightness').value === 1,
      `${service.getCharacteristic('On').value} ${
        service.getCharacteristic('Brightness').value
      }`
    );
    check(
      'nothing was written to HomeKit, only reported',
      service.getCharacteristic('On').hapWrites.length === 0 &&
        service.getCharacteristic('Brightness').hapWrites.length === 0,
      'a characteristic was written, which takes Adaptive Lighting down'
    );
    check(
      'the brightness to come back to is remembered',
      bulb.moonlightSnapshot && bulb.moonlightSnapshot.bright === 60,
      JSON.stringify(bulb.moonlightSnapshot)
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 27
  console.log('\n27. Adaptive Lighting cannot end the mode, a person can');
  {
    const lamp = bedsideLamp('0');
    await lamp.listen();
    const { bulb, service, accessory } = await makeBulb(
      lamp,
      {},
      { power: 'on', bright: '60' }
    );
    const moonlight = moonlightSwitch(accessory);
    await moonlight.getCharacteristic('On').write(true);
    await sleep(200);
    lamp.reset();

    // The nudge the real lamp answered by dropping out of night mode.
    await service
      .getCharacteristic('ColorTemperature')
      .write(300, { controller: {} });
    await sleep(200);
    check(
      'a background nudge never reaches the lamp',
      lamp.methods().length === 0,
      `${lamp.methods()}`
    );
    check(
      'the mode is still on',
      moonlight.getCharacteristic('On').value === true,
      `${moonlight.getCharacteristic('On').value}`
    );
    check(
      'but the nudge is remembered for the way out',
      bulb.temperature === 300,
      `${bulb.temperature}`
    );

    // The same value, arriving as a deliberate write.
    await service.getCharacteristic('ColorTemperature').write(300);
    await sleep(200);
    check(
      'a deliberate write is obeyed',
      lamp.methods().length === 1 && lamp.methods()[0] === 'set_ct_abx',
      `${lamp.methods()}`
    );
    check(
      'and takes the switch down with it',
      moonlight.getCharacteristic('On').value === false,
      `${moonlight.getCharacteristic('On').value}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 28
  console.log('\n28. The brightness slider ends the mode and is obeyed');
  {
    const lamp = bedsideLamp('0');
    await lamp.listen();
    const { bulb, service, accessory } = await makeBulb(
      lamp,
      {},
      { power: 'on', bright: '60' }
    );
    const moonlight = moonlightSwitch(accessory);
    await moonlight.getCharacteristic('On').write(true);
    await sleep(200);
    lamp.reset();

    await service.getCharacteristic('Brightness').write(40);
    await sleep(200);
    check(
      'the brightness reached the lamp',
      lamp.methods().length === 1 && lamp.methods()[0] === 'set_bright',
      `${lamp.methods()}`
    );
    check(
      'the switch went down with it',
      moonlight.getCharacteristic('On').value === false,
      `${moonlight.getCharacteristic('On').value}`
    );
    check(
      'and the brightness is the one that was asked for',
      service.getCharacteristic('Brightness').value === 40,
      `${service.getCharacteristic('Brightness').value}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 29
  console.log('\n29. The lamp is the authority on the mode');
  {
    const lamp = bedsideLamp('0');
    await lamp.listen();
    const { bulb, service, accessory } = await makeBulb(
      lamp,
      {},
      { power: 'on', bright: '60' }
    );
    const moonlight = moonlightSwitch(accessory);

    // Someone used the Yeelight app: the lamp says so and nothing else does.
    bulb.stateHandler({ method: 'props', params: { nl_br: 1, bright: 1 } });
    check(
      'a night light burning turns the switch on',
      moonlight.getCharacteristic('On').value === true,
      `${moonlight.getCharacteristic('On').value}`
    );
    check(
      'and the brightness comes from nl_br',
      service.getCharacteristic('Brightness').value === 1,
      `${service.getCharacteristic('Brightness').value}`
    );

    // The only notification the real lamp sends when a set_bright ends it.
    bulb.stateHandler({ method: 'props', params: { nl_br: 0 } });
    check(
      'nl_br going out takes the switch with it',
      moonlight.getCharacteristic('On').value === false,
      `${moonlight.getCharacteristic('On').value}`
    );

    bulb.stateHandler({ method: 'props', params: { bright: 70 } });
    check(
      'and the daylight brightness is followed again',
      service.getCharacteristic('Brightness').value === 70,
      `${service.getCharacteristic('Brightness').value}`
    );
    check(
      'none of it was a HomeKit write',
      service.getCharacteristic('Brightness').hapWrites.length === 0 &&
        moonlight.getCharacteristic('On').hapWrites.length === 0,
      'a characteristic was written'
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 30
  console.log('\n30. Switching it off puts back what the lamp was lit at');
  {
    const lamp = bedsideLamp('0');
    await lamp.listen();
    const { bulb, service, accessory } = await makeBulb(
      lamp,
      {},
      { power: 'on', bright: '60', ct: '2702' }
    );
    const moonlight = moonlightSwitch(accessory);
    await moonlight.getCharacteristic('On').write(true);
    await sleep(200);
    lamp.reset();

    await moonlight.getCharacteristic('On').write(false);
    await sleep(250);
    const m = lamp.methods();
    check(
      'the temperature and the brightness, and nothing else',
      m.length === 2 && m.includes('set_ct_abx') && m.includes('set_bright'),
      `${m}`
    );
    check(
      'the brightness is the one from before the mode',
      service.getCharacteristic('Brightness').value === 60,
      `${service.getCharacteristic('Brightness').value}`
    );
    check(
      'the switch is off',
      moonlight.getCharacteristic('On').value === false,
      `${moonlight.getCharacteristic('On').value}`
    );
    check(
      'and the lamp is still on',
      service.getCharacteristic('On').value === true,
      `${service.getCharacteristic('On').value}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 31
  console.log('\n31. An alert ends night mode, and the restore brings it back');
  {
    const lamp = bedsideLamp('0');
    await lamp.listen();
    const { bulb, accessory } = await makeBulb(
      lamp,
      {},
      {
        power: 'on',
        bright: '60',
        alert: { enabled: true, hue: 0, saturation: 100 },
      }
    );
    const moonlight = moonlightSwitch(accessory);
    await moonlight.getCharacteristic('On').write(true);
    await sleep(200);

    await bulb.setAlert(true);
    check(
      'the alert colour ends the mode',
      moonlight.getCharacteristic('On').value === false,
      `${moonlight.getCharacteristic('On').value}`
    );

    lamp.reset();
    await bulb.setAlert(false);
    await sleep(200);
    const m = lamp.methods();
    check(
      'the restore is a set_power in mode 5, not a colour',
      m.length === 1 &&
        m[0] === 'set_power' &&
        JSON.stringify(lamp.received[0].params) ===
          JSON.stringify(['on', 'smooth', 400, 5]),
      JSON.stringify(lamp.received.map((r) => [r.method, r.params]))
    );
    check(
      'the switch is back on',
      moonlight.getCharacteristic('On').value === true,
      `${moonlight.getCharacteristic('On').value}`
    );
    check(
      'and the pre-alert brightness is what it will come back to',
      bulb.moonlightSnapshot && bulb.moonlightSnapshot.bright === 60,
      JSON.stringify(bulb.moonlightSnapshot)
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 32
  console.log('\n32. Both switches live on the lamp, told apart by subtype');
  {
    const lamp = bedsideLamp('0');
    await lamp.listen();
    const { bulb, accessory } = await makeBulb(
      lamp,
      {},
      { power: 'on', alert: { enabled: true, hue: 0, saturation: 100 } }
    );
    const platform = fakePlatform();
    configureAlert(platform, bulb, 'Lamp');

    const switches = accessory.services.filter(
      (s) => s instanceof global.Service.Switch
    );
    check(
      'two switches on one accessory',
      switches.length === 2,
      `${switches.length}`
    );
    check(
      'and neither is the other',
      !!alertSwitch(accessory) &&
        !!moonlightSwitch(accessory) &&
        alertSwitch(accessory) !== moonlightSwitch(accessory),
      'the subtype lookup returned the same service twice'
    );
    check(
      'each is named after the lamp',
      alertSwitch(accessory).displayName === 'Lamp Alert' &&
        moonlightSwitch(accessory).displayName === 'Lamp Moonlight',
      `${alertSwitch(accessory).displayName} / ${
        moonlightSwitch(accessory).displayName
      }`
    );
    check(
      'the light is still the primary service',
      !!accessory.getService(global.Service.Lightbulb),
      'no lightbulb service'
    );

    // The alert switch drives the lamp from its new home.
    await alertSwitch(accessory).getCharacteristic('On').write(true);
    await sleep(200);
    check(
      'the alert switch still flashes the lamp',
      bulb.alertActive === true && lamp.methods().includes('set_hsv'),
      `${bulb.alertActive} ${lamp.methods()}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 33
  console.log('\n33. The old layout is migrated, once');
  {
    const lamp = bedsideLamp('0');
    await lamp.listen();
    const { bulb, accessory } = await makeBulb(lamp, {}, { power: 'on' });
    const platform = fakePlatform();

    // What the previous version left behind: a Switch with no subtype on the
    // lamp, and an accessory of its own for the alert.
    const orphan = accessory.addService(
      new global.Service.Switch('Moonlight Mode')
    );
    const legacy = { displayName: 'Lamp Alert' };
    platform.alerts['0xtest'] = legacy;

    removeLegacySwitches(platform, accessory, '0xtest', 'Lamp');

    check(
      'the subtype-less switch is gone',
      !accessory.services.includes(orphan),
      'it is still there, with nothing behind it'
    );
    check(
      'the subtyped one is untouched',
      !!moonlightSwitch(accessory),
      'the migration took the live switch with it'
    );
    check(
      'the old alert accessory is unregistered',
      platform.unregistered.includes(legacy) && !platform.alerts['0xtest'],
      JSON.stringify(Object.keys(platform.alerts))
    );

    // Idempotent: a second launch finds nothing to do.
    removeLegacySwitches(platform, accessory, '0xtest', 'Lamp');
    check(
      'and running it again changes nothing',
      platform.unregistered.length === 1 && !!moonlightSwitch(accessory),
      `${platform.unregistered.length}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 34
  console.log('\n34. A switch turned off in the config leaves the accessory');
  {
    const lamp = bedsideLamp('0');
    await lamp.listen();
    const { bulb, accessory } = await makeBulb(
      lamp,
      {},
      { power: 'on', alert: { enabled: true, hue: 0, saturation: 100 } }
    );
    const platform = fakePlatform();
    configureAlert(platform, bulb, 'Lamp');
    check('the alert switch is there', !!alertSwitch(accessory), 'missing');

    bulb.alertEnabled = false;
    configureAlert(platform, bulb, 'Lamp');
    check(
      'turning the alert off removes its switch',
      !alertSwitch(accessory) && bulb.alertService === null,
      'the switch outlived its setting'
    );

    check(
      'and the moonlight switch can go the same way',
      removeSwitch(accessory, MOONLIGHT) === true &&
        !moonlightSwitch(accessory),
      'still there'
    );
    check(
      'the light itself is untouched',
      !!accessory.getService(global.Service.Lightbulb),
      'the lightbulb service went with them'
    );
    check(
      'removing what is not there is a no-op',
      removeSwitch(accessory, ALERT) === false,
      'it claimed to remove something'
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 35
  console.log('\n35. Brightness dragged to zero turns the lamp off');
  {
    const lamp = bedsideLamp('0');
    await lamp.listen();
    const { service } = await makeBulb(lamp, {}, { power: 'on', bright: '60' });

    await service.getCharacteristic('Brightness').write(0);
    await sleep(200);
    const m = lamp.methods();
    check(
      'one command, and it is the power going off',
      m.length === 1 &&
        m[0] === 'set_power' &&
        lamp.received[0].params[0] === 'off',
      JSON.stringify(lamp.received.map((r) => [r.method, r.params]))
    );
    check(
      'not a set_bright clamped up to 1%',
      !m.includes('set_bright'),
      `${m}`
    );

    // What the Home app actually sent: Off, and a trailing Brightness of 0 a
    // second later. The second write used to wake the lamp back up at 1%.
    lamp.reset();
    await service.getCharacteristic('Brightness').write(0);
    await sleep(200);
    check(
      'and a zero arriving at a lamp already off never wakes it',
      !lamp.methods().includes('set_scene'),
      `${lamp.methods()}`
    );
    await lamp.close();
  }

  // ---------------------------------------------------------------- 36
  console.log('\n36. The same tap arriving five times is still one command');
  {
    const lamp = bedsideLamp('0');
    await lamp.listen();
    const { accessory } = await makeBulb(lamp, {}, { power: 'on' });
    const moonlight = moonlightSwitch(accessory);

    await Promise.all(
      Array.from({ length: 5 }, () =>
        moonlight.getCharacteristic('On').write(true)
      )
    );
    await sleep(300);
    const m = lamp.methods();
    check('one set_power, not five', m.length === 1, `${m.length}: ${m}`);
    check(
      'the switch is on',
      moonlight.getCharacteristic('On').value === true,
      `${moonlight.getCharacteristic('On').value}`
    );

    // And the way back out, hit just as often.
    lamp.reset();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        moonlight.getCharacteristic('On').write(false)
      )
    );
    await sleep(300);
    check(
      'leaving it is not five either',
      lamp.methods().length <= 2,
      `${lamp.methods()}`
    );
    check(
      'and the switch is off',
      moonlight.getCharacteristic('On').value === false,
      `${moonlight.getCharacteristic('On').value}`
    );
    await lamp.close();
  }

  // ---------------------------------------------------------------- 37
  console.log('\n37. Each switch says which one it is');
  {
    const lamp = bedsideLamp('0');
    await lamp.listen();
    const { bulb, accessory } = await makeBulb(
      lamp,
      {},
      { power: 'on', alert: { enabled: true, hue: 0, saturation: 100 } }
    );
    configureAlert(fakePlatform(), bulb, 'Lamp');

    const labelOf = (service) =>
      service.getCharacteristic('ConfiguredName').value;
    check(
      'the alert switch is labelled as the alert',
      labelOf(alertSwitch(accessory)) === 'Lamp Alert',
      `${labelOf(alertSwitch(accessory))}`
    );
    check(
      'the moonlight switch as the moonlight',
      labelOf(moonlightSwitch(accessory)) === 'Lamp Moonlight',
      `${labelOf(moonlightSwitch(accessory))}`
    );

    // What the owner types in the Home app goes into the same characteristic.
    alertSwitch(accessory)
      .getCharacteristic('ConfiguredName')
      .updateValue('Front door');
    configureAlert(fakePlatform(), bulb, 'Lamp');
    check(
      'and a name the owner chose survives the next launch',
      labelOf(alertSwitch(accessory)) === 'Front door',
      `${labelOf(alertSwitch(accessory))}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 38
  console.log('\n38. A nudge already in the window cannot end the mode');
  {
    const lamp = bedsideLamp('0');
    await lamp.listen();
    const { bulb, service, accessory } = await makeBulb(
      lamp,
      {},
      { power: 'on', bright: '100', ct: '2415' }
    );
    const moonlight = moonlightSwitch(accessory);

    // The 23:00 case, in order: Adaptive Lighting writes first and its command
    // is still coalescing when the automation flips the switch a few
    // milliseconds later.
    await service
      .getCharacteristic('ColorTemperature')
      .write(300, { controller: {} });
    await moonlight.getCharacteristic('On').write(true);
    await sleep(400);

    const m = lamp.methods();
    check(
      'the temperature never reaches the lamp',
      !m.includes('set_ct_abx'),
      `${m}`
    );
    check(
      'only the mode does',
      m.length === 1 && m[0] === 'set_power',
      `${m.length}: ${m}`
    );
    check(
      'the mode is still on a second later',
      moonlight.getCharacteristic('On').value === true && bulb.nightMode,
      `${moonlight.getCharacteristic('On').value}`
    );
    check(
      'and the nudge is kept for the way out',
      bulb.temperature === 300,
      `${bulb.temperature}`
    );

    // Leaving puts the lamp on the curve as it stands now, not where it was.
    lamp.reset();
    await moonlight.getCharacteristic('On').write(false);
    await sleep(300);
    const out = lamp.received.find((r) => r.method === 'set_ct_abx');
    check(
      'the way out uses the nudge that was held back',
      !!out && out.params[0] === Math.round(10 ** 6 / 300),
      JSON.stringify(out && out.params)
    );
    check(
      'and the brightness the lamp was lit at comes back',
      lamp.received.some(
        (r) => r.method === 'set_bright' && r.params[0] === 100
      ),
      JSON.stringify(lamp.received.map((r) => [r.method, r.params]))
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 39
  console.log('\n39. A brightness in the window is taken as what to restore');
  {
    const lamp = bedsideLamp('0');
    await lamp.listen();
    const { bulb, service, accessory } = await makeBulb(
      lamp,
      {},
      { power: 'on', bright: '100' }
    );
    const moonlight = moonlightSwitch(accessory);

    await service.getCharacteristic('Brightness').write(40);
    await moonlight.getCharacteristic('On').write(true);
    await sleep(400);
    check(
      'the brightness never goes out',
      !lamp.methods().includes('set_bright'),
      `${lamp.methods()}`
    );
    check(
      'and it becomes what the lamp comes back to',
      bulb.moonlightSnapshot && bulb.moonlightSnapshot.bright === 40,
      JSON.stringify(bulb.moonlightSnapshot)
    );
    check(
      'the lamp was not woken at its power-on brightness either',
      lamp.methods().length === 1 && lamp.methods()[0] === 'set_power',
      `${lamp.methods()}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 40
  console.log(
    '\n40. A finger on the brightness slider is not fought by the lamp'
  );
  {
    const lamp = new FakeLamp({ echo: true });
    await lamp.listen();
    const { bulb, service } = await makeBulb(
      lamp,
      {},
      {
        power: 'off',
        bright: '5',
        ct: '2967',
      }
    );
    lamp.reset();

    const brightness = service.getCharacteristic('Brightness');
    const pushed = [];
    const update = brightness.updateValue.bind(brightness);
    brightness.updateValue = (v) => {
      pushed.push(v);
      return update(v);
    };

    service
      .getCharacteristic('On')
      .write(true)
      .catch(() => {});
    for (const v of [5, 20, 66, 100]) {
      brightness.value = v;
      brightness.write(v).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await sleep(150);
    }
    await sleep(700);

    const backwards = pushed.filter((v) => v !== 100);
    console.log(
      '     wire:',
      JSON.stringify(lamp.received.map((r) => [r.method, r.params]))
    );
    console.log('     pushed at HomeKit:', JSON.stringify(pushed));
    check(
      'the lamp reached the value asked for',
      lamp.received.some((r) => JSON.stringify(r.params).includes('100')),
      JSON.stringify(lamp.methods())
    );
    check(
      'no stale value pushed over the moving slider',
      backwards.length === 0,
      JSON.stringify(backwards)
    );
    check(
      'cache still followed the lamp',
      bulb.bright === 100,
      `${bulb.bright}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 41
  console.log('\n41. A change made anywhere else still reaches HomeKit');
  {
    const lamp = new FakeLamp({ echo: true });
    await lamp.listen();
    const { bulb, service } = await makeBulb(
      lamp,
      {},
      { power: 'on', bright: '50' }
    );
    lamp.reset();

    const brightness = service.getCharacteristic('Brightness');
    // Somebody presses the lamp's own button.
    bulb.updateStateFromProp('bright', '17');
    check(
      'an unsolicited change is published',
      brightness.value === 17,
      `${brightness.value}`
    );

    // Our own echo, arriving right after we commanded it, is not.
    await service.getCharacteristic('Brightness').write(80);
    await sleep(300);
    const before = brightness.value;
    bulb.updateStateFromProp('bright', '80');
    check(
      'our own echo is held back',
      brightness.value === before,
      `${before} -> ${brightness.value}`
    );
    check('but the cache took it', bulb.bright === 80, `${bulb.bright}`);
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 42
  console.log('\n42. A remembered colour temperature survives a restart');
  {
    const YeePlatform = require('../platform');
    const service = new global.Service.Lightbulb('Lamp');
    service.getCharacteristic(global.Characteristic.On).updateValue(true);
    service
      .getCharacteristic(global.Characteristic.ColorTemperature)
      .updateValue(385);

    const state = YeePlatform.prototype.rememberedState.call(
      {},
      {
        getService: () => service,
        context: {},
      }
    );

    // 385 mired is 2597 K. Everything downstream of props.ct speaks the lamp's
    // Kelvin, and handing the mired over unconverted had it inverted a second
    // time - straight past the 500 the characteristic allows.
    check(
      'ct handed on in Kelvin, not mired',
      Math.round(state.ct) === 2597,
      `${state.ct}`
    );
    check(
      'and it converts back to the mired HomeKit gave us',
      Math.floor(10 ** 6 / state.ct) === 385,
      `${Math.floor(10 ** 6 / state.ct)}`
    );
  }

  // The lamp's own word on an open socket, which is what makes the cache sure.
  const lampSays = (bulb, params) =>
    bulb.stateHandler({ method: 'props', params });

  // What HAP does with every brightness change while Adaptive Lighting is on
  // (AdaptiveLightingController.handleAdjustmentFactorChanged in HAP-NodeJS
  // 2.2.2): a colour temperature write of its own, with the controller as
  // context.
  const AL = { controller: {} };
  const alActive = (bulb) => {
    bulb.controller = { isAdaptiveLightingActive: () => true };
  };
  const dragStep = (service, bright, mired, withOn) =>
    Promise.all([
      withOn ? service.getCharacteristic('On').write(true) : null,
      service.getCharacteristic('Brightness').write(bright),
      service.getCharacteristic('ColorTemperature').write(mired, AL),
    ]);

  // ---------------------------------------------------------------- 50
  console.log('\n50. A slider step on a lit lamp is one command');
  {
    const lamp = new FakeLamp({ delay: 90 });
    await lamp.listen();
    const { bulb, service } = await makeBulb(lamp, {}, { power: 'on' });
    alActive(bulb);
    lampSays(bulb, { power: 'on' });
    // What the log showed on 2026-10-10 at 20:41:54: On + Brightness + the
    // Adaptive Lighting temperature, for every step of the drag.
    await dragStep(service, 84, 412, true);
    await sleep(300);
    const wire = lamp.received.map((r) => [r.method, r.params]);
    console.log('     wire:', JSON.stringify(wire));
    check('one command, not three', wire.length === 1, `${wire.length}`);
    check(
      'a set_scene carrying both values',
      wire[0] &&
        JSON.stringify(wire[0]) ===
          JSON.stringify(['set_scene', ['ct', 2427, 84]]),
      JSON.stringify(wire[0])
    );
    check(
      'no set_power for a lamp the lamp itself says is on',
      !lamp.methods().includes('set_power'),
      `${lamp.methods()}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 51
  console.log(
    "\n51. An On is still sent when the cache is not the lamp's word"
  );
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { bulb, service } = await makeBulb(lamp, {}, { power: 'on' });
    lampSays(bulb, { power: 'on' });
    // The socket goes; whatever happened meanwhile was not heard.
    bulb.reset();
    await scene(service, { On: true });
    await sleep(200);
    check(
      'set_power goes out after a reconnect',
      lamp.methods().join() === 'set_power',
      `${lamp.methods()}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 52
  console.log(
    '\n52. A fast drag never leaves the lamp more than a step behind'
  );
  {
    const lamp = new FakeLamp({ delay: 250 });
    await lamp.listen();
    const { bulb, service } = await makeBulb(lamp, {}, { power: 'on' });
    alActive(bulb);
    lampSays(bulb, { power: 'on' });
    const started = Date.now();
    // Twenty steps, one every 40 ms: faster than the lamp answers.
    for (let b = 100; b > 20; b -= 4) {
      // eslint-disable-next-line no-await-in-loop
      await dragStep(service, b, 300 + (100 - b), true);
      // eslint-disable-next-line no-await-in-loop
      await sleep(40);
    }
    const dragged = Date.now() - started;
    await sleep(800);
    const wire = lamp.received.map((r) => [r.method, r.params]);
    console.log(
      `     ${wire.length} commands for 20 steps over ${dragged} ms:`,
      JSON.stringify(wire.map(([, p]) => p[2]))
    );
    check(
      'the lamp got far fewer commands than steps',
      wire.length <= 6,
      `${wire.length}`
    );
    const last = wire[wire.length - 1];
    check(
      'and the last one is where the finger stopped',
      last && last[1][2] === 24,
      JSON.stringify(last)
    );
    check(
      'nothing left waiting once the lamp has answered',
      !bulb.pending && !bulb.inflight,
      `pending=${!!bulb.pending} inflight=${!!bulb.inflight}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 53
  console.log('\n53. A step that arrives after the Off does not wake the lamp');
  {
    const lamp = new FakeLamp({ delay: 90 });
    await lamp.listen();
    const { bulb, service } = await makeBulb(lamp, {}, { power: 'on' });
    alActive(bulb);
    lampSays(bulb, { power: 'on' });
    // The order the wire showed at 20:45:49: the Off first, then the 41%
    // the finger had passed on its way down.
    await service.getCharacteristic('On').write(false);
    await sleep(250);
    await dragStep(service, 41, 452, false);
    await sleep(400);
    const wire = lamp.received.map((r) => [r.method, r.params]);
    console.log('     wire:', JSON.stringify(wire));
    check(
      'only the Off reached the lamp',
      JSON.stringify(wire) ===
        JSON.stringify([['set_power', ['off', 'smooth', 400]]]),
      JSON.stringify(wire)
    );
    check('the lamp is off', bulb.power === false, `${bulb.power}`);
    check(
      'and HomeKit says so',
      service.getCharacteristic('On').value === false,
      `${service.getCharacteristic('On').value}`
    );
    check('the 41% is kept', bulb.bright === 41, `${bulb.bright}`);

    // A deliberate change of mind still works: an On ends the tail at once.
    lamp.reset();
    await scene(service, { On: true, Brightness: 60 });
    await sleep(300);
    check(
      'an explicit On wakes it straight away',
      lamp.methods().join() === 'set_scene',
      `${lamp.methods()}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 54
  console.log(
    '\n54. The tail ends: a later brightness wakes the lamp as before'
  );
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { bulb, service } = await makeBulb(lamp, {}, { power: 'on' });
    await service.getCharacteristic('On').write(false);
    await sleep(150);
    bulb.offAt = Date.now() - 2500;
    lamp.reset();
    await service.getCharacteristic('Brightness').write(30);
    await sleep(200);
    check(
      'woken by set_scene',
      lamp.methods().join() === 'set_scene',
      `${lamp.methods()}`
    );
    check(
      'and HomeKit is told it is on, which it never asked for',
      service.getCharacteristic('On').value === true,
      `${service.getCharacteristic('On').value}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 55
  console.log('\n55. Brightness 0 switches the tile off, not just the lamp');
  {
    const lamp = new FakeLamp({ echo: true });
    await lamp.listen();
    const { bulb, service } = await makeBulb(lamp, {}, { power: 'on' });
    service.getCharacteristic('On').updateValue(true);
    await service.getCharacteristic('Brightness').write(0);
    await sleep(300);
    check(
      'set_power off on the wire',
      lamp.methods().join() === 'set_power',
      `${lamp.methods()}`
    );
    check(
      'HomeKit On follows, though only Brightness was written',
      service.getCharacteristic('On').value === false,
      `${service.getCharacteristic('On').value}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 56
  console.log('\n56. Opening the Home app costs one read per lamp, not two');
  {
    const lamp = new FakeLamp({ props: { power: 'on', nl_br: '0' } });
    await lamp.listen();
    const { bulb, service, accessory } = await makeBulb(lamp);
    lamp.reset();
    bulb.lastPowerRead = 0;
    await service.getCharacteristic('On').read();
    await moonlightSwitch(accessory).getCharacteristic('On').read();
    await sleep(200);
    const wire = lamp.received.map((r) => [r.method, r.params]);
    check(
      'a single get_prop for power and night mode',
      JSON.stringify(wire) ===
        JSON.stringify([['get_prop', ['power', 'nl_br']]]),
      JSON.stringify(wire)
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 57
  console.log('\n57. Leaving night mode by the slider stays off set_scene');
  {
    const lamp = new FakeLamp({ props: { active_mode: '', nl_br: '1' } });
    await lamp.listen();
    const { bulb, service } = await makeBulb(lamp, {}, { power: 'on' });
    alActive(bulb);
    lampSays(bulb, { power: 'on' });
    check('starts in night mode', bulb.nightMode === true, `${bulb.nightMode}`);
    lamp.reset();
    await service.getCharacteristic('Brightness').write(60);
    await service.getCharacteristic('ColorTemperature').write(370);
    await sleep(300);
    check(
      'the verified commands, not a scene',
      lamp.methods().join() === 'set_ct_abx,set_bright',
      `${lamp.methods()}`
    );
    lamp.reset();
    await dragStep(service, 70, 380, false);
    await sleep(300);
    check(
      'once out, the next step is a single scene again',
      lamp.methods().join() === 'set_scene',
      `${lamp.methods()}`
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 58
  console.log(
    '\n58. A lamp that drops off Wi-Fi mid-command gets it on return'
  );
  {
    // Measured on the Entrance lamp 2026-10-11 16:24:24: it took a wake
    // command, went silent - no reply, no ping - and rejoined the access
    // point 8 s later without having carried it out. Played here as a lamp
    // that swallows the command, vanishes, and is back 1.5 s later.
    const lamp = new FakeLamp();
    await lamp.listen();
    const { bulb } = await makeBulb(lamp, {
      connection: { timeout: 300, connectTimeout: 300, recoverWithin: 4000 },
    });
    const port = lamp.port;
    lamp.reset();
    // It takes the command and says nothing...
    lamp.silent = true;
    const started = Date.now();
    const pending = bulb.getProperty(['power']).then(
      () => 'ok',
      () => 'failed'
    );
    // ...then is off the network: no handshake completes until it is back.
    await sleep(50);
    await lamp.close();
    await sleep(1450);
    const back = new FakeLamp();
    await back.listen(port);
    const result = await pending;
    const elapsed = Date.now() - started;
    const writes = [lamp, back]
      .map((l) => l.methods().filter((x) => x === 'get_prop').length)
      .reduce((x, y) => x + y, 0);
    console.log(`     result=${result} writes=${writes} elapsed=${elapsed}ms`);
    check(
      'the command arrived once the lamp was back',
      result === 'ok',
      result
    );
    check('it cost exactly one extra write', writes === 2, `${writes}`);
    check(
      'and it waited for the lamp, not for the whole deadline',
      elapsed >= 1500 && elapsed < 3000,
      `${elapsed}ms`
    );
    bulb.reset();
    await back.close();
  }

  // ---------------------------------------------------------------- 59
  console.log('\n59. A lamp that never comes back is still given up');
  {
    const lamp = new FakeLamp({ silent: true });
    await lamp.listen();
    const { bulb } = await makeBulb(lamp, {
      connection: { timeout: 200, connectTimeout: 200, recoverWithin: 1200 },
    });
    await lamp.close();
    const started = Date.now();
    const result = await bulb.getProperty(['power']).then(
      () => 'ok',
      () => 'failed'
    );
    const elapsed = Date.now() - started;
    check('it fails', result === 'failed', result);
    check('within about the deadline', elapsed < 2500, `${elapsed}ms`);
    bulb.reset();
  }

  // ---------------------------------------------------------------- 60
  console.log('\n60. A burst from the hub lands where the finger stopped');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { bulb, service } = await makeBulb(lamp);
    alActive(bulb);
    // 17:15:00 on 2026-10-11: a 0 -> 100 drag, delivered 7-11 ms apart in
    // this order, each step with On.
    for (const b of [100, 60, 96, 100, 1]) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([
        service.getCharacteristic('On').write(true),
        service.getCharacteristic('Brightness').write(b),
      ]);
      // eslint-disable-next-line no-await-in-loop
      await sleep(8);
    }
    await sleep(300);
    const wire = lamp.received.map((r) => [r.method, r.params]);
    console.log('     wire:', JSON.stringify(wire));
    check(
      'one command, at 100',
      wire.length === 1 && wire[0][1][wire[0][1].length - 1] === 100,
      JSON.stringify(wire)
    );
    check(
      'and HomeKit is put back to 100, not left on the last write',
      service.getCharacteristic('Brightness').value === 100,
      `${service.getCharacteristic('Brightness').value}`
    );

    // A drag at the Home app's own pace is untouched.
    lamp.reset();
    for (const b of [80, 60, 40]) {
      // eslint-disable-next-line no-await-in-loop
      await service.getCharacteristic('Brightness').write(b);
      // eslint-disable-next-line no-await-in-loop
      await sleep(220);
    }
    await sleep(200);
    const steps = lamp.received.map((r) =>
      r.method === 'set_bright' ? r.params[0] : r.params[r.params.length - 1]
    );
    check(
      'a 220 ms drag still reaches the lamp step by step',
      JSON.stringify(steps.slice(-1)) === '[40]' && steps.length === 3,
      JSON.stringify(lamp.received.map((r) => [r.method, r.params]))
    );
    bulb.reset();
    await lamp.close();
  }

  // ---------------------------------------------------------------- 61
  console.log('\n61. A dropped socket is reset, so nothing on it is sent late');
  {
    const lamp = new FakeLamp();
    await lamp.listen();
    const { bulb } = await makeBulb(lamp);
    await bulb.getProperty(['power']);
    const [sock] = [...lamp.sockets];
    const seen = new Promise((resolve) => {
      sock.on('error', (err) => resolve(err.code));
      sock.on('end', () => resolve('FIN'));
    });
    bulb.reset();
    const how = await Promise.race([seen, sleep(1000).then(() => 'nothing')]);
    check(
      'the lamp sees a reset, not an orderly close',
      how === 'ECONNRESET',
      how
    );
    await lamp.close();
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

setTimeout(() => {
  console.error('HARNESS TIMEOUT');
  process.exit(3);
}, 90000).unref();

run().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});
