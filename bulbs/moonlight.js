// Night mode - "moonlight" in Yeelight's own vocabulary - is one fixed state:
// the lamp at its dimmest, in a warm amber that no combination of brightness
// and colour temperature reproduces. The spec gives it a fourth parameter to
// set_power ("5: turn on and switch to Night light mode") and reports it
// through two properties: active_mode, which the spec marks ceiling-light-only,
// and nl_br, "brightness of night mode light". A bedside lamp answers
// active_mode with an empty string and nl_br with a real number, so the probe
// asks for both and the lamp's answer decides which one its mode is read from.
//
// The firmware leaves the mode on any set_ct_abx or set_bright - even one that
// changes nothing - which makes Adaptive Lighting its natural enemy: one nudge
// a minute would end it within the minute. Background nudges are swallowed and
// remembered here, the way the alert mixin swallows them while a lamp is
// flashing; a deliberate write is let through, and takes the switch down with
// it rather than leaving it claiming a mode the lamp has already left.

const DAYLIGHT_MODE = 0;
const MOONLIGHT_MODE = 1;
// set_power's optional "mode" parameter.
const NIGHT_LIGHT = 5;
// What the night light lights at. The lamp reports it either way; sending it to
// HomeKit ourselves means the tile is right before the first prop arrives.
const NIGHT_BRIGHTNESS = 1;

const MoonlightMode = (Device) =>
  class extends Device {
    constructor(props, platform) {
      super(props, platform);
      this.lastMoonlightRead = 0;
      this.activeMode = DAYLIGHT_MODE;
      // Which property this lamp answers about its night mode with, once the
      // probe knows. Null until then, and for a lamp that has no night mode.
      this.moonlightProp = null;
      // What the lamp was lit at before the mode was switched on.
      this.moonlightSnapshot = null;
      this.initMoonlight().catch((err) => {
        this.log.debug(
          `${this.tag}: moonlight probe failed: ${err.message || err}.`
        );
      });
    }

    async initMoonlight() {
      const [activeMode, nightBrightness] = await this.getProperty([
        'active_mode',
        'nl_br',
      ]);

      // An empty string is how the firmware says it does not know a property,
      // so a lamp without the mode answers with two of them.
      const known = (value) => value !== undefined && value !== '';
      if (known(activeMode)) this.moonlightProp = 'active_mode';
      else if (known(nightBrightness)) this.moonlightProp = 'nl_br';
      else return;

      this.log(`Device ${this.name} supports moonlight mode`);
      this.activeMode = this.modeFrom(
        this.moonlightProp === 'active_mode' ? activeMode : nightBrightness
      );

      this.moonlightModeService =
        this.accessory.getService(global.Service.Switch) ||
        this.accessory.addService(new global.Service.Switch(`Moonlight Mode`));

      this.moonlightModeService
        .getCharacteristic(global.Characteristic.On)
        .on('set', (value, callback) => {
          this.accepted(this.setMoonlightMode(value), () =>
            this.publishMoonlightState()
          );
          callback(null);
        })
        // From memory, like every other read: a read that goes to the lamp
        // costs a command and blocks HomeKit while it travels.
        .on('get', (callback) => {
          callback(null, this.nightMode);
          this.refreshMoonlightInBackground();
        })
        .updateValue(this.nightMode);
    }

    // active_mode is the mode itself. nl_br is a brightness, and a night light
    // burning at any brightness at all is the mode being on.
    modeFrom(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return DAYLIGHT_MODE;
      const on =
        this.moonlightProp === 'active_mode'
          ? number === MOONLIGHT_MODE
          : number > 0;
      return on ? MOONLIGHT_MODE : DAYLIGHT_MODE;
    }

    get nightMode() {
      return this.activeMode === MOONLIGHT_MODE;
    }

    // A write we cannot stop is on its way to the lamp, and the firmware will
    // drop the mode as it lands. The switch goes down now rather than a
    // round-trip later, so nothing in HomeKit claims a mode that is over.
    nightModeEnded() {
      this.moonlightSnapshot = null;
      if (!this.nightMode) return;
      this.log.debug(
        `${this.tag}: night mode ends, a deliberate write is on its way.`
      );
      this.activeMode = DAYLIGHT_MODE;
      this.publishMoonlightState();
    }

    publishMoonlightState() {
      if (!this.moonlightModeService) return;
      this.moonlightModeService
        .getCharacteristic(global.Characteristic.On)
        .updateValue(this.nightMode);
    }

    refreshMoonlightInBackground() {
      if (!this.moonlightProp) return;
      const now = Date.now();
      if (now - this.lastMoonlightRead < this.staleAfter) return;
      this.lastMoonlightRead = now;
      this.getProperty([this.moonlightProp])
        .then(([value]) => {
          if (value === undefined || value === '') return;
          this.updateStateFromProp(this.moonlightProp, value);
        })
        .catch((err) => {
          this.log.debug(
            `${this.tag}: background moonlight refresh failed: ${
              err.message || err
            }.`
          );
        });
    }

    setMoonlightMode(state) {
      return state ? this.enterMoonlight() : this.leaveMoonlight();
    }

    async enterMoonlight() {
      if (this.nightMode) return;
      const { power: transition = 400 } = this.config.transitions || {};

      // Taken before the command goes out: from here on the brightness we know
      // is the night light's, and what to come back to would be lost.
      this.moonlightSnapshot = { bright: this.bright, power: this.power };
      this.log.debug(
        `${this.tag}: night mode on, snapshot ${JSON.stringify(
          this.moonlightSnapshot
        )}.`
      );

      await this.sendCmd({
        method: 'set_power',
        params: ['on', 'smooth', transition, NIGHT_LIGHT],
      });

      this.activeMode = MOONLIGHT_MODE;
      // The command powers the lamp on as a side effect.
      this.power = 'on';
      this.publishMoonlightState();

      const reflected = { On: true };
      // Only for a lamp that has the characteristic at all: asking HAP for one
      // a lamp does not have is how an optional characteristic gets added.
      if (Number.isFinite(this.bright)) {
        this.bright = NIGHT_BRIGHTNESS;
        reflected.Brightness = NIGHT_BRIGHTNESS;
      }
      this.reflect(reflected);
    }

    async leaveMoonlight() {
      if (!this.nightMode) return;

      const snap = this.moonlightSnapshot;
      this.moonlightSnapshot = null;
      this.activeMode = DAYLIGHT_MODE;
      this.publishMoonlightState();

      // Putting the lamp back where it was is also what takes it out of the
      // mode - any temperature or brightness command ends it - so there is no
      // separate command for the mode itself. Adaptive Lighting's nudges were
      // swallowed while the mode was on but still recorded, so this lands on
      // the curve where it stands now rather than where it stood at bedtime.
      const patch = { power: true };
      const reflected = {};

      if (Number.isFinite(this.temperature)) {
        patch.ct = this.temperature;
        reflected.ColorTemperature = this.temperature;
      }

      const bright = snap && snap.bright;
      if (Number.isFinite(bright)) {
        patch.bright = bright;
        reflected.Brightness = bright;
      }

      // A lamp that takes neither is left to the documented way out: mode 1 is
      // "turn on and switch to CT mode", which is daylight by another name.
      if (patch.ct === undefined && patch.bright === undefined) {
        const { power: transition = 400 } = this.config.transitions || {};
        await this.sendCmd({
          method: 'set_power',
          params: ['on', 'smooth', transition, 1],
        });
        return;
      }

      await this.applyState(patch);
      this.reflect(reflected);
      this.log.debug(
        `${this.tag}: night mode off, restored ${JSON.stringify(reflected)}.`
      );
    }

    // Adaptive Lighting never writes brightness, so a brightness change is
    // always someone's hand on a slider - and the lamp leaves night mode as it
    // lands, whatever we think about it.
    setBrightness(brightness) {
      this.nightModeEnded();
      return super.setBrightness(brightness);
    }

    setTemperature(mired, fromAdaptiveLighting = false) {
      if (this.nightMode && fromAdaptiveLighting) {
        this.log.debug(
          `${this.tag}: ignoring a background Adaptive Lighting nudge while night mode is on.`
        );
        // Remembered, so leaving the mode lands on the curve's current point.
        this._temperature = mired;
        return Promise.resolve();
      }
      this.nightModeEnded();
      return super.setTemperature(mired, fromAdaptiveLighting);
    }

    updateStateFromProp(prop, value) {
      if (prop === this.moonlightProp) {
        const mode = this.modeFrom(value);
        if (mode !== this.activeMode) {
          // The lamp is the authority. The Yeelight app, a scene, another
          // controller - anything can end the mode, and a switch left on would
          // be the only thing in the house still claiming it.
          this.activeMode = mode;
          if (mode === DAYLIGHT_MODE) this.moonlightSnapshot = null;
          this.publishMoonlightState();
        }
        // Kept flowing: the brightness mixin reads nl_br too, and it sits
        // inside this one, so it sees the prop with the mode already settled.
        super.updateStateFromProp(prop, value);
        return;
      }

      super.updateStateFromProp(prop, value);
    }
  };

module.exports = MoonlightMode;
