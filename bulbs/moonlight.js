const DAYLIGHT_MODE = 0;
const MOONLIGHT_MODE = 1;

const MoonlightMode = (Device) =>
  class extends Device {
    constructor(props, platform) {
      super(props, platform);
      this.initMoonlight().catch((err) => {
        this.log.debug(
          `${this.tag}: moonlight probe failed: ${err.message || err}.`
        );
      });
    }

    async initMoonlight() {
      const [activeMode] = await this.getProperty(['active_mode']);
      if (!activeMode) return;

      this.log(`Device ${this.name} supports moonlight mode`);
      this.activeMode = Number(activeMode) || DAYLIGHT_MODE;

      this.moonlightModeService =
        this.accessory.getService(global.Service.Switch) ||
        this.accessory.addService(new global.Service.Switch(`Moonlight Mode`));

      this.moonlightModeService
        .getCharacteristic(global.Characteristic.On)
        .on('set', (value, callback) => {
          this.accepted(this.setMoonlightMode(value), () =>
            this.moonlightModeService
              .getCharacteristic(global.Characteristic.On)
              .updateValue(this.activeMode === MOONLIGHT_MODE)
          );
          callback(null);
        })
        .on('get', async (callback) => {
          try {
            const [value] = await this.getProperty(['active_mode']);
            this.activeMode = Number(value);
            callback(null, this.activeMode);
          } catch (err) {
            callback(err, this.activeMode);
          }
        })
        .updateValue(this.activeMode);
    }

    async setMoonlightMode(state) {
      const { brightness: transition = 400 } = this.config.transitions || {};
      this.log.debug(
        `Setting ${state ? 'moon' : 'day'}light mode on device ${this.did}`
      );
      await this.sendCmd({
        method: 'set_power',
        params: ['on', 'smooth', transition, state ? 5 : 1],
      });
      this.activeMode = state ? MOONLIGHT_MODE : DAYLIGHT_MODE;
      // The command powers the lamp on as a side effect.
      this.power = 'on';
    }

    updateStateFromProp(prop, value) {
      if (prop === 'active_mode') {
        // Kept numeric: the brightness and temperature mixins compare it
        // against 1, and a string never matched.
        this.activeMode = Number(value);
        // Advertisements can arrive before the probe has built the service.
        if (this.moonlightModeService) {
          this.moonlightModeService
            .getCharacteristic(global.Characteristic.On)
            .updateValue(this.activeMode === MOONLIGHT_MODE);
        }
        return;
      }

      super.updateStateFromProp(prop, value);
    }
  };

module.exports = MoonlightMode;
