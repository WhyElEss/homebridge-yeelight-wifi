// Snapshot the lamp, flash it in a fixed colour, then put it back exactly as
// it was. Built for the "make the lamp red while the front door is open"
// automation, where the Home app has no primitive that can remember a state.
//
// Everything here runs *below* HAP on purpose. An outside process writing
// Hue/Saturation/ColorTemperature over HomeKit would count as a manual write
// and switch Adaptive Lighting off for good (HAP-NodeJS disables the active
// transition on any characteristic change whose reason is "write"), and AL is
// the reason this plugin exists. Driving the lamp from in here and reporting
// back with updateValue keeps the transition armed throughout.

const CT_MODE = 2;

const DEFAULTS = { hue: 0, saturation: 100 };

const Alert = (Device) =>
  class extends Device {
    constructor(props, platform) {
      super(props, platform);

      const { enabled = false, ...colour } = props.alert || {};
      this.alertEnabled = !!enabled;
      this.alertSettings = Object.assign({}, DEFAULTS, colour);
      this.alertActive = false;
      this.alertSnapshot = null;
      // Set by the alert accessory so state changes reach its switch.
      this.alertService = null;
    }

    // Adaptive Lighting keeps nudging the colour temperature on its own
    // schedule; left alone it would wash the alert colour out within a minute.
    // The value is still remembered, so the restore lands on the curve's
    // current point rather than on a stale one from before the alert.
    setTemperature(mired, fromAdaptiveLighting = false) {
      if (this.alertActive && fromAdaptiveLighting) {
        this.log.debug(
          `${this.tag}: ignoring a background Adaptive Lighting nudge while the alert is on.`
        );
        this._temperature = mired;
        return Promise.resolve();
      }
      return super.setTemperature(mired, fromAdaptiveLighting);
    }

    captureAlertSnapshot() {
      return {
        power: this.power,
        bright: this.bright,
        hue: this.hue,
        sat: this.sat,
        ct: this.temperature,
        colorMode: this.colorMode,
      };
    }

    setAlert(on) {
      return on ? this.triggerAlert() : this.restoreAlert();
    }

    async triggerAlert() {
      if (this.alertActive) return;

      const { hue, saturation, brightness } = this.alertSettings;
      this.alertSnapshot = this.captureAlertSnapshot();
      this.alertActive = true;
      this.publishAlertState();
      this.log.debug(
        `${this.tag}: alert on, snapshot ${JSON.stringify(this.alertSnapshot)}.`
      );

      // No `force`: an explicit set_power would be a second command on a lamp
      // that is already lit, and one that is off gets its power from the
      // set_scene this turns into.
      const patch = { power: true, hue, sat: saturation };
      if (Number.isFinite(brightness)) patch.bright = brightness;

      try {
        await this.applyState(patch);
      } catch (err) {
        // The lamp never took the colour, so there is nothing to put back.
        this.alertActive = false;
        this.alertSnapshot = null;
        this.publishAlertState();
        throw err;
      }

      this.reflect({ On: true, Hue: hue, Saturation: saturation });
      if (Number.isFinite(brightness)) this.reflect({ Brightness: brightness });
    }

    async restoreAlert() {
      if (!this.alertActive) return;

      const snap = this.alertSnapshot;
      this.alertActive = false;
      this.alertSnapshot = null;
      this.publishAlertState();

      if (!snap) {
        this.log.warn(
          `${this.tag}: nothing was snapshotted, leaving the lamp as it is.`
        );
        return;
      }

      const patch = { power: true };
      const reflected = {};

      if (this.restoresColorTemperature(snap)) {
        // While the alert was up, Adaptive Lighting's nudges were swallowed but
        // still recorded, so this puts the lamp on the curve as it stands now
        // rather than where it was when the door opened.
        const mired = this.adaptiveLighting ? this.temperature : snap.ct;
        patch.ct = mired;
        reflected.ColorTemperature = mired;
      } else {
        patch.hue = snap.hue;
        patch.sat = snap.sat;
        reflected.Hue = snap.hue;
        reflected.Saturation = snap.sat;
      }

      // Only if the alert moved it: an extra set_bright is an extra command.
      if (
        Number.isFinite(this.alertSettings.brightness) &&
        Number.isFinite(snap.bright)
      ) {
        patch.bright = snap.bright;
        reflected.Brightness = snap.bright;
      }

      await this.applyState(patch);
      this.reflect(reflected);

      // Colour first, power last, and in two flushes: an "off" landing in the
      // same coalescing window would win outright and drop the colour, leaving
      // the lamp to come back red the next time anything switches it on.
      if (!snap.power) {
        await this.applyState({ power: false, force: true });
        this.reflect({ On: false });
      }

      this.log.debug(
        `${this.tag}: alert off, restored ${JSON.stringify(snap)}.`
      );
    }

    restoresColorTemperature(snap) {
      if (snap.colorMode === CT_MODE) return true;
      return !Number.isFinite(snap.hue) || !Number.isFinite(snap.sat);
    }

    // updateValue, never setValue: the first is how a plugin reports a change
    // it made itself, the second reads as a HomeKit write and takes Adaptive
    // Lighting down with it.
    reflect(values) {
      Object.entries(values).forEach(([characteristic, value]) => {
        if (value === undefined || value === null) return;
        this.service
          .getCharacteristic(global.Characteristic[characteristic])
          .updateValue(value);
      });
    }

    publishAlertState() {
      if (!this.alertService) return;
      this.alertService
        .getCharacteristic(global.Characteristic.On)
        .updateValue(this.alertActive);
    }
  };

module.exports = Alert;
