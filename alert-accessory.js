// The alert lives on its own accessory rather than as a second service on the
// lamp, for two reasons: the Home app lists it as something an automation can
// target directly, and the moonlight mixin already claims the lamp's only
// Switch service by type.
const PLUGIN_NAME = 'homebridge-yeelight';
const PLATFORM_NAME = 'yeelight';

const uuidFor = (id) => global.UUIDGen.generate(`${id}:alert`);

function remove(platform, id) {
  const accessory = platform.alerts[id];
  if (!accessory) return;
  delete platform.alerts[id];
  try {
    platform.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      accessory,
    ]);
    platform.log(`Removed the alert switch for ${accessory.displayName}.`);
    // eslint-disable-next-line no-empty
  } catch (_) {}
}

// Creates, updates or removes the "<name> Alert" switch for one lamp.
function configure(platform, bulb, { id, name }) {
  if (!bulb.alertEnabled) {
    remove(platform, id);
    return null;
  }

  const { Characteristic, Service } = global;
  let accessory = platform.alerts[id];

  if (!accessory) {
    platform.log(`Adding an alert switch for ${name}...`);
    accessory = new global.Accessory(`${name} Alert`, uuidFor(id));
    accessory.context.did = id;
    accessory.context.role = 'alert';
    platform.alerts[id] = accessory;
    platform.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      accessory,
    ]);
  }

  const alertName = `${name} Alert`;
  if (accessory.displayName !== alertName) {
    platform.log(`Renaming ${accessory.displayName} to ${alertName}.`);
    accessory.displayName = alertName;
    platform.api.updatePlatformAccessories([accessory]);
  }

  accessory
    .getService(Service.AccessoryInformation)
    .setCharacteristic(Characteristic.Name, alertName)
    .setCharacteristic(Characteristic.Manufacturer, 'YeeLight')
    .setCharacteristic(Characteristic.Model, `${bulb.model} Alert`)
    .setCharacteristic(Characteristic.SerialNumber, `${bulb.did}-alert`);

  const service =
    accessory.getService(Service.Switch) ||
    accessory.addService(new Service.Switch(alertName));
  service.setCharacteristic(Characteristic.Name, alertName);

  const characteristic = service.getCharacteristic(Characteristic.On);
  characteristic.removeAllListeners?.('set');
  characteristic.removeAllListeners?.('get');
  characteristic
    .on('set', async (value, callback) => {
      try {
        await bulb.setAlert(!!value);
        callback(null);
      } catch (err) {
        callback(err);
      }
    })
    // Answered from memory: the alert is our own state, and asking the lamp
    // would spend a command out of its per-minute quota for nothing.
    .on('get', (callback) => callback(null, bulb.alertActive))
    .updateValue(bulb.alertActive);

  bulb.alertService = service;
  accessory.initialized = true;
  return accessory;
}

module.exports = { configure, remove };
