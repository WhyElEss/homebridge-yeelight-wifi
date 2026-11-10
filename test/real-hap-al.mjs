// The alert's Adaptive Lighting restore, run against the real HAP-NodeJS
// rather than the fake in harness.js: it leans on members HAP-NodeJS does not
// publish (serialize, activeTransition, handleActiveTransitionUpdated), so
// only the real thing can say whether it still works.
//
// Run where HAP-NodeJS is installed - inside the Homebridge container:
//   node test/real-hap-al.mjs /homebridge/node_modules/homebridge/node_modules/@homebridge/hap-nodejs/dist/index.js
//
// The two Transition Control values are the hub's own, captured on the Pi on
// 2026-11-09: ENABLE armed Upstairs at 21:34:02, DISABLE is what the door
// automation sent at 21:57:45. The capture does not go stale: HAP-NodeJS takes
// the moment of the write as the schedule's start (timeMillisOffset is
// Date.now() minus the start time the hub sent), so its 24 hours begin
// whenever the test runs.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const hap = await import(process.argv[2]);
const { Accessory, Service, Characteristic, AdaptiveLightingController, uuid } =
  hap;
global.Characteristic = Characteristic;
const Temperature = require('../bulbs/temperature.js');

const ENABLE =
  'Av8B/wEBDgImARDE8z2pY8lMD4uJbDajPu+eAghQtab7vQAAAAMI7Ig7PwjVT4kDAQEF/wEPAQTv7m6/AgSrqv5DAwEAAAABEgEE3t1dvwIEVVX+QwMEWAgYAAAAARIBBDMzM78CBACA/UMDBEB3GwAAAAESAQRswRa/AgTHcftDAwRAdxsAAAABEgEE9UkfvwIEchz9QwMEQHcbAAAAARgBBGzBFr8CBMfx+UMDBEB3GwAEBIDLpAAAAAESAQS2YAu/AgTkuPVDAwRAdxsAAAABEgEE7+7uvgIEVVXvQwMEQHcbAAAAARIBBHIcx74CBMdx6EMDBEB3GwAAAAESAQQC/5qZAf+ZvgIEAIDhQwMEQHcbAAAAARIBBM3MTL4CBAAA2kMDBEB3GwAAAAESAQTNzMy9AgQF/wAA00MDBEB3GwAAAAESAQSJiAi9AgSrKsxDAwRAdxsAAAABEgEEYQs2vQIE5DjGQwMEQHcbAAAAARIBBPVJH74CBBzHwEMDBEB3GwAAAAESAQRhC7a+AgQcx7tDAwRAdxsAAAABEgEE5DgOvwIEHEe3QwMEQHcbAAAAARIBBOmTPr8CBOS4s0MDBEB3GwAAAAESAQRbsIW/AgTkOLFDAwRAdxsAAAABEgEEOY6jvwIEjuOvQwMEQHcbAAAAARIBBI7juL8CBOQ4rwL/QwMEQAH/dxsAAAABEgEEpU+6vwIEHEeuQwMEQHcbAAAAARIBBKVPur8CBBzHrUMDBEB3GwAAAAEF/xIBBLy7u78CBFXVrUMDBEB3GwAAAAESAQSlT7q/AgQcx61DAwRAdxsAAAABGAEEvLu7vwIEVdWtQwMEQHcbAAQEgO42AAAAARIBBKVPur8CBBzHrUMDBEB3GwAAAAESAQR3d7e/AgSrKq5DAwRAdxsAAAABEgEEBluwvwIEjuOuQwMEQHcbAAAAARIBBGZmpr8CBACAsEMDBEB3GwAAAAESAQSamZm/AgQAALJDAwRAdxsAAAABEgEEzcyMvwIEAAC1QwMEAv9AdxsAAAAB9wESAQTSJ32/AgTHcbhDAwRAdxsAAAABEgEElD5pvwIEOY69QwMEQHcbAAAAARIBBDMzM78FtwIEAADEQwMEQHcbAAAAARIBBFuwBb8CBHIczEMDBEB3GwAAAAESAQQGWzC/AgTH8ddDAwRAdxsAAAABEgEEchxHvwIEjmPjQwMEQHcbAAAAARIBBLAFW78CBBzH7kMDBEB3GwAAAAESAQSwBVu/AgQcR/hDAwRAdxsAAAABEgEE7+5uvwIEq6r+QwMEQHcbAAAAARIBBO/ubr8CBKuq/kMDBOhuAwACAQsDDAEECgAAAAIEZAAAAAYCYOoIBMAnCQA=';
const DISABLE = 'AgUBAwEBDg==';

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`
  );
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The lamp's light service with the iids the captured values point at:
// Brightness 11 and ColorTemperature 14, as on the Pi.
const accessory = new Accessory('Lamp', uuid.generate('real-hap-al'));
const light = accessory.addService(Service.Lightbulb, 'Lamp');
light.getCharacteristic(Characteristic.Brightness).iid = 11;
light.getCharacteristic(Characteristic.Brightness).value = 100;
const ct = light.getCharacteristic(Characteristic.ColorTemperature);
ct.iid = 14;
light.getCharacteristic(Characteristic.Hue);
light.getCharacteristic(Characteristic.Saturation);
const nudges = [];
ct.onSet((value, context) => {
  nudges.push({ value, context });
});

const controller = new AdaptiveLightingController(light);
accessory.configureController(controller);
let saved = 0;
controller.setupStateChangeDelegate(() => {
  saved += 1;
});

// Only the parts of the plugin's lamp this path touches.
const Lamp = Temperature(
  class {
    rememberPreBatchState() {
      this.remembered = (this.remembered || 0) + 1;
    }
  }
);
const lamp = Object.create(Lamp.prototype);
lamp.tag = 'Lamp';
lamp.log = { info() {}, debug() {}, warn: (m) => console.log('   warn', m) };
lamp.controller = controller;
lamp.watchAdaptiveLightingDisable();

const transitionControl = light.getCharacteristic(
  Characteristic.CharacteristicValueTransitionControl
);
const activeCount = light.getCharacteristic(
  Characteristic.CharacteristicValueActiveTransitionCount
);
const counts = [];
activeCount.on('change', (change) => counts.push(change.newValue));

console.log(`HAP-NodeJS ${hap.HAPLibraryVersion?.() ?? '?'}`);

await transitionControl.handleSetRequest(ENABLE);
check(
  "the hub's schedule arms AL",
  controller.isAdaptiveLightingActive(),
  'not armed'
);
const before = lamp.adaptiveTransition();
check(
  'adaptiveTransition() copies the schedule',
  !!before && before.activeTransition.transitionCurve.length > 10,
  JSON.stringify(before)?.slice(0, 80)
);

await transitionControl.handleSetRequest(DISABLE);
check(
  "the hub's AL-off disarms it",
  !controller.isAdaptiveLightingActive(),
  'still armed'
);
check(
  'the disable was seen before it took effect',
  lamp.remembered === 1,
  `${lamp.remembered}`
);

nudges.length = 0;
counts.length = 0;
saved = 0;
const resumed = lamp.resumeAdaptiveLighting(before);
await sleep(50);
check(
  'resumeAdaptiveLighting() reports success',
  resumed === true,
  `${resumed}`
);
check('AL is armed again', controller.isAdaptiveLightingActive(), 'not armed');
check(
  'HomeKit is told: active transition count 1',
  counts.includes(1),
  JSON.stringify(counts)
);
check('the schedule is saved for a restart', saved >= 1, `${saved}`);
check(
  "the curve's current point goes out at once, marked as AL",
  nudges.length >= 1 && nudges[0].context?.controller === controller,
  JSON.stringify(nudges.map((n) => n.value))
);
const read = Buffer.from(
  await transitionControl.handleGetRequest(),
  'base64'
).toString('hex');
// Kept as a UUID string, sent as its 16 bytes.
const id = before.activeTransition.transitionId.replace(/-/g, '').toLowerCase();
check(
  'a read of Transition Control answers with the same transition id',
  read.includes(id),
  `${read.slice(0, 60)}… vs ${id}`
);

controller.disableAdaptiveLighting();
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
