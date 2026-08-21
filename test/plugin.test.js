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
    await sleep(100);
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
    check('gives up quickly', elapsed < 2000, `${elapsed}ms`);
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
