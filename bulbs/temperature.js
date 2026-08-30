const { colorFromTemperature } = require('../utils');

const Temperature = (Device) =>
  class extends Device {
    constructor(props, platform) {
      super(props, platform);
      this.temperature = props.ct;
      this.controller = {};

      const { ColorTemperature } = global.Characteristic;
      // HomeKit defines this characteristic as 140-500 mired. A bslamp3 goes
      // down to 1700 K, which is 588, and advertising that put the lamp
      // outside the range every controller expects - Adaptive Lighting is
      // computed against these very bounds. The lamp keeps whatever it
      // supports; HomeKit is told only what HomeKit understands.
      const [rawMin, rawMax] = props.limits.colorTemperature;
      const minValue = Math.max(140, rawMin);
      const maxValue = Math.min(500, rawMax);
      if (minValue !== rawMin || maxValue !== rawMax) {
        this.log.debug(
          `${this.tag}: colour temperature ${rawMin}-${rawMax} narrowed to ${minValue}-${maxValue} for HomeKit.`
        );
      }

      (
        this.service.getCharacteristic(ColorTemperature) ||
        this.service.addOptionalCharacteristic(ColorTemperature)
      )
        // AdaptiveLightingController drives its periodic nudges through this
        // same SET handler, passing `{ controller, omitEventUpdate }` as the
        // context. A person dragging the temperature slider arrives without
        // it, which is the only way to tell a background nudge from a
        // deliberate change - see the alert and moonlight mixins, which
        // suppress the former while a lamp is flashing or in night mode.
        .on('set', (value, callback, context) => {
          const fromAdaptiveLighting =
            typeof context === 'object' &&
            context !== null &&
            'controller' in context;

          this.accepted(this.setTemperature(value, fromAdaptiveLighting), () =>
            this.service
              .getCharacteristic(ColorTemperature)
              .updateValue(this.temperature)
          );
          callback(null);
        })
        .setProps({ minValue, maxValue })
        .updateValue(this.temperature);

      // Setup the adaptive lighting controller if available
      this.configureAdaptiveLightingController(platform);
    }

    get temperature() {
      return this._temperature;
    }

    set temperature(kelvin) {
      this._temperature = Math.floor(10 ** 6 / Number(kelvin));
    }

    // The controller stays an empty object when Homebridge is too old to
    // provide one, and calling through it blindly used to throw.
    get adaptiveLighting() {
      return (
        typeof this.controller.isAdaptiveLightingActive === 'function' &&
        this.controller.isAdaptiveLightingActive()
      );
    }

    // `fromAdaptiveLighting` is unused here - whether the lamp may be woken
    // depends on AL being armed, not on which write this is - but it is part
    // of the signature so the alert mixin can intercept background nudges.
    // eslint-disable-next-line no-unused-vars
    setTemperature(mired, fromAdaptiveLighting = false) {
      // If we are already in color temperature mode (2) and the current
      // temperature matches the new temperature there is no need to send
      // another command.
      if (this.temperature === mired && this.colorMode === 2) {
        return Promise.resolve();
      }

      // Adaptive lighting drifts the temperature on its own schedule and must
      // never switch the lamp on to do it.
      if (this.adaptiveLighting) {
        if (!this.power) {
          // Remember it so the value is applied the next time it powers on.
          this._temperature = mired;
          return Promise.resolve();
        }
        return this.applyState({ ct: mired });
      }

      // A direct request from the user turns the lamp on and takes it there.
      return this.applyState({ power: true, ct: mired });
    }

    onTemperatureApplied(mired) {
      // With adaptive lighting on, Homebridge already updates the colour in
      // HomeKit to match; when we set the temperature ourselves we have to.
      if (this.adaptiveLighting) return;
      const { hue, sat } = colorFromTemperature(mired);
      super.updateStateFromProp('hue', hue);
      super.updateStateFromProp('sat', sat);
    }

    updateStateFromProp(prop, value) {
      switch (prop) {
        case 'ct':
          this.temperature = value;
          this.service
            .getCharacteristic(global.Characteristic.ColorTemperature)
            .updateValue(this.temperature);
          break;
        case 'color_mode':
          this.colorMode = Number(value);
          break;
        default:
          super.updateStateFromProp(prop, value);
      }
    }

    configureAdaptiveLightingController(platform) {
      if (!platform.api.versionGreaterOrEqual) return;
      if (!platform.api.versionGreaterOrEqual('1.3.0-beta.23')) return;

      this.controller = new platform.api.hap.AdaptiveLightingController(
        this.service
      );
      this.accessory.configureController(this.controller);
      // Waking a lamp at the transition's current temperature is handled by
      // applyPowerOnDefaults, in the same command that switches it on. This
      // used to be a second command sent from here, with the temperature
      // decremented by one mired each time to get past setTemperature's
      // "same value, skip" check - a lamp that was switched on often drifted
      // measurably away from the curve.
    }
  };

module.exports = Temperature;
