// A lamp's switches - the alert and the moonlight mode - live on the lamp's own
// accessory, as Switch services told apart by their subtype. One accessory per
// lamp is what leaves the layout to HomeKit: the Home app groups an accessory's
// controls into one tile by default, and "Show as separate tiles" in the
// accessory's settings splits them. That is the owner's choice to make, and a
// plugin that registers an accessory per switch takes it away.
//
// The alert used to be an accessory of its own, and the moonlight switch a
// Switch service with no subtype. Both are migrated here, once, on the launch
// that first sees them.
const PLUGIN_NAME = 'homebridge-yeelight';
const PLATFORM_NAME = 'yeelight';

const ALERT = 'alert';
const MOONLIGHT = 'moonlight';

// Always by subtype, never by type: two Switch services on one accessory are
// the same type, and a lookup by type answers with whichever was added first.
const findSwitch = (accessory, subtype) =>
  accessory.getServiceById(global.Service.Switch, subtype);

function switchService(accessory, subtype, name) {
  const { Characteristic, Service } = global;
  const service =
    findSwitch(accessory, subtype) ||
    accessory.addService(new Service.Switch(name, subtype));
  service.displayName = name;
  service.setCharacteristic(Characteristic.Name, name);
  return service;
}

function removeSwitch(accessory, subtype) {
  const service = findSwitch(accessory, subtype);
  if (!service) return false;
  accessory.removeService(service);
  return true;
}

// The alert's own accessory, from before the switches moved onto the lamp.
function removeLegacyAlert(platform, id, name) {
  const accessory = platform.alerts[id];
  if (!accessory) return;
  delete platform.alerts[id];
  try {
    platform.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      accessory,
    ]);
    platform.log(`Moved the alert switch for ${name} onto the lamp itself.`);
    // eslint-disable-next-line no-empty
  } catch (_) {}
}

// A subtype-less Switch is a different service to HomeKit than the subtyped one
// that replaces it, so leaving it behind would show a switch with nothing at
// all behind it.
function removeLegacySwitches(platform, accessory, id, name) {
  removeLegacyAlert(platform, id, name);

  (accessory.services || [])
    .filter(
      (service) => service instanceof global.Service.Switch && !service.subtype
    )
    .forEach((service) => {
      platform.log(`Replacing the old moonlight switch on ${name}.`);
      accessory.removeService(service);
    });
}

// Adds, updates or removes the "<name> Alert" switch on the lamp's accessory.
function configureAlert(platform, bulb, name) {
  const { Characteristic } = global;

  if (!bulb.alertEnabled) {
    if (removeSwitch(bulb.accessory, ALERT)) {
      platform.log(`Removed the alert switch from ${name}.`);
    }
    bulb.alertService = null;
    return null;
  }

  const service = switchService(bulb.accessory, ALERT, `${name} Alert`);
  const characteristic = service.getCharacteristic(Characteristic.On);
  characteristic.removeAllListeners?.('set');
  characteristic.removeAllListeners?.('get');
  characteristic
    .on('set', (value, callback) => {
      // Same rule as the lamp's own handlers: accept now, act after. An alert
      // is two flushes on a lamp that was off, which HomeKit should not wait on.
      bulb.accepted(bulb.setAlert(!!value), () => bulb.publishAlertState());
      callback(null);
    })
    // Answered from memory: the alert is our own state, and asking the lamp
    // would spend a command out of its per-minute quota for nothing.
    .on('get', (callback) => callback(null, bulb.alertActive))
    .updateValue(bulb.alertActive);

  bulb.alertService = service;
  return service;
}

module.exports = {
  ALERT,
  MOONLIGHT,
  switchService,
  removeSwitch,
  removeLegacyAlert,
  removeLegacySwitches,
  configureAlert,
};
