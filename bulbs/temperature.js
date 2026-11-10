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
          if (!fromAdaptiveLighting) this.heard('ColorTemperature', value);

          // HAP answers every brightness change with a temperature of its
          // own, including the values of a hub burst that the brightness
          // mixin has dropped. On 2026-10-11 the last of those (3%) put the
          // lamp at 4950 K under a kept 100%. Once the burst is over the kept
          // brightness is handed back to HomeKit and the curve's temperature
          // for it arrives on its own.
          // Every curve temperature that follows a burst write is kept against
          // that write's brightness, so the chosen one can be applied when the
          // burst closes.
          if (fromAdaptiveLighting && this.burstTemperatures) {
            const values = this.burstValues || [];
            if (values.length) {
              this.burstTemperatures.set(values[values.length - 1], value);
            }
          }
          if (fromAdaptiveLighting && this.burstTimer) {
            this.log.debug(
              `${this.tag}: dropping an Adaptive Lighting temperature that follows a dropped brightness.`
            );
            callback(null);
            return;
          }

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

    // A copy of the running transition - the schedule the hub sent - or null.
    // `serialize` is what HAP-NodeJS itself writes to ControllerStorage.
    adaptiveTransition() {
      if (!this.adaptiveLighting) return null;
      if (typeof this.controller.serialize !== 'function') return null;
      const saved = this.controller.serialize();
      return saved ? JSON.parse(JSON.stringify(saved)) : null;
    }

    // Puts a transition taken by adaptiveTransition() back, exactly as
    // HAP-NodeJS does when the hub sends one: handleActiveTransitionUpdated
    // tells HomeKit the active transition count is 1 again, starts the
    // minute-by-minute updates (the first one at once, at the curve's current
    // point) and saves it to ControllerStorage so it survives a restart. Both
    // members are internal to HAP-NodeJS (TypeScript-private), which is why
    // they are checked before use; tested against HAP-NodeJS 2.x.
    resumeAdaptiveLighting(saved) {
      if (!saved || !saved.activeTransition) return false;
      if (this.adaptiveLighting) return false;
      const controller = this.controller;
      if (typeof controller.handleActiveTransitionUpdated !== 'function') {
        this.log.warn(
          `${this.tag}: cannot put Adaptive Lighting back on this Homebridge.`
        );
        return false;
      }
      try {
        controller.activeTransition = JSON.parse(
          JSON.stringify(saved.activeTransition)
        );
        controller.handleActiveTransitionUpdated();
      } catch (err) {
        this.log.warn(
          `${this.tag}: could not put Adaptive Lighting back: ${err.message}`
        );
        if (typeof controller.disableAdaptiveLighting === 'function') {
          controller.disableAdaptiveLighting();
        }
        return false;
      }
      this.log.info(`${this.tag}: Adaptive Lighting back on after the alert.`);
      return this.adaptiveLighting;
    }

    // Whether the lamp may be woken depends on AL being armed, not on which
    // write this is. `fromAdaptiveLighting` marks the command as background -
    // the next nudge supersedes it, so nothing waits on a lamp that is not
    // answering - and lets the alert and moonlight mixins intercept it.
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
        return this.applyState(
          { ct: mired },
          { background: fromAdaptiveLighting }
        );
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
          if (!this.publishable(prop, value)) break;
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
      this.watchAdaptiveLightingDisable();
      // Waking a lamp at the transition's current temperature is handled by
      // applyPowerOnDefaults, in the same command that switches it on. This
      // used to be a second command sent from here, with the temperature
      // decremented by one mired each time to get past setTemperature's
      // "same value, skip" check - a lamp that was switched on often drifted
      // measurably away from the curve.
    }

    watchAdaptiveLightingDisable() {
      // The hub switches Adaptive Lighting off with a Transition Control write
      // that carries nothing but the colour temperature's iid, and it puts that
      // write into the same request as the alert switch: on 2026-11-09 at
      // 21:57:45 the door automation sent Entrance its AL-off a few
      // milliseconds before its Alert=1. HAP-NodeJS drops the schedule on the
      // spot (handleAdaptiveLightingDisabled -> disableAdaptiveLighting), so
      // by the time the alert takes its snapshot the transition is gone. Every
      // way HAP-NodeJS ends a transition goes through this one method, so this
      // is where the state before the batch is kept, transition included.
      const disable = this.controller.disableAdaptiveLighting;
      if (typeof disable === 'function') {
        this.controller.disableAdaptiveLighting = (...args) => {
          if (this.adaptiveLighting) this.rememberPreBatchState();
          return disable.apply(this.controller, args);
        };
      }
    }
  };

module.exports = Temperature;
