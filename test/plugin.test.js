const { FakeLamp, makeBulb, sleep } = require('./harness');

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
    const moonlight = accessory.getService(global.Service.Switch);
    if (!moonlight) {
      check('a moonlight switch exists to read', false, 'no switch service');
    } else {
      bulb.lastMoonlightRead = Date.now();
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
  const moonlightSwitch = (accessory) =>
    accessory.getService(global.Service.Switch);

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
