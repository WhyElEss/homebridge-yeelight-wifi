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
      `     writes=${JSON.stringify(m)} connections=${lamp.connections} elapsed=${elapsed}ms`
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
