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

// An alert restores what the lamp was before the batch of HomeKit writes that
// came with it. The hub sends an automation as one burst - on 2026-11-09 at
// 21:57:45 the door automation put Entrance's Adaptive Lighting off and its
// Alert=1 into one request, the AL-off first - so the state that has to come
// back is the one before the burst, not the one the alert happens to find.
// Writes closer together than this count as one burst - the same 100 ms the
// brightness mixin uses for the hub's bursts. The door automation's writes
// came 3-17 ms apart; anything a person does separately comes later than this.
const BATCH_WINDOW = 100;

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

    // Called before every HomeKit write takes effect, and before HAP-NodeJS
    // ends a running Adaptive Lighting transition. The first of a burst keeps
    // the lamp as it stood; the rest only extend the burst.
    rememberPreBatchState() {
      if (this.alertActive) return;
      const now = Date.now();
      if (this.preBatch && now - this.preBatch.last <= BATCH_WINDOW) {
        this.preBatch.last = now;
        return;
      }
      this.preBatch = {
        snapshot: this.captureAlertSnapshot(),
        first: now,
        last: now,
      };
    }

    // The snapshot from before a burst the alert is part of, else the lamp
    // as it is now.
    alertStartingState() {
      const batch = this.preBatch;
      this.preBatch = null;
      if (batch && Date.now() - batch.last <= BATCH_WINDOW) {
        this.log.info(
          `${this.tag}: alert came with ${
            Date.now() - batch.first
          } ms of other HomeKit writes - restoring what was before them.`
        );
        return batch.snapshot;
      }
      return this.captureAlertSnapshot();
    }

    captureAlertSnapshot() {
      return {
        // The hub's whole schedule, so the restore can put Adaptive Lighting
        // back if anything switched it off - the alert's own automation does.
        adaptive:
          typeof this.adaptiveTransition === 'function'
            ? this.adaptiveTransition()
            : null,
        power: this.power,
        bright: this.bright,
        hue: this.hue,
        sat: this.sat,
        ct: this.temperature,
        colorMode: this.colorMode,
        nightMode: this.nightMode,
        // Taken before the alert ends the mode, and with it whatever the lamp
        // was lit at before the mode began - `bright` above is only the night
        // light's 1% while the mode is on.
        moonlight: this.moonlightSnapshot,
      };
    }

    setAlert(on) {
      return on ? this.triggerAlert() : this.restoreAlert();
    }

    async triggerAlert() {
      if (this.alertActive) return;

      const { hue, saturation, brightness } = this.alertSettings;
      this.alertSnapshot = this.alertStartingState();
      this.alertActive = true;
      this.publishAlertState();
      this.log.debug(
        `${this.tag}: alert on, snapshot ${JSON.stringify(this.alertSnapshot)}.`
      );

      // No `force`: an explicit set_power would be a second command on a lamp
      // that is already lit, and one that is off gets its power from the
      // set_scene this turns into.
      // The colour ends night mode in the firmware; the switch goes down with
      // it, and the restore below is what brings the mode back.
      this.nightModeEnded();

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

      // Night mode is not a colour that can be put back with the rest: the
      // alert's set_hsv ended it in the firmware, and only set_power's mode 5
      // brings it back.
      if (snap.nightMode) {
        await this.enterMoonlight();
        // Entering took its snapshot while the alert colour was in force, so
        // the one from before the alert goes back in its place.
        this.moonlightSnapshot = snap.moonlight || {
          bright: snap.bright,
          power: snap.power,
        };
        if (!snap.power) {
          await this.applyState({ power: false, force: true });
          this.reflect({ On: false });
        }
        this.resumeAdaptiveLightingAfterAlert(snap);
        this.log.debug(`${this.tag}: alert off, night mode back on.`);
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

      // Last, once the lamp holds its old colour and power: the transition's
      // first update goes out at once and moves it to the curve's current
      // point, which a snapshot taken minutes ago cannot know.
      this.resumeAdaptiveLightingAfterAlert(snap);

      this.log.debug(
        `${this.tag}: alert off, restored ${JSON.stringify({
          ...snap,
          adaptive: !!snap.adaptive,
        })}.`
      );
    }

    // A lamp that was on Adaptive Lighting before the alert is on it after,
    // whatever switched it off in between.
    resumeAdaptiveLightingAfterAlert(snap) {
      if (!snap.adaptive || this.adaptiveLighting) return;
      if (typeof this.resumeAdaptiveLighting !== 'function') return;
      this.resumeAdaptiveLighting(snap.adaptive);
    }

    restoresColorTemperature(snap) {
      if (snap.colorMode === CT_MODE) return true;
      return !Number.isFinite(snap.hue) || !Number.isFinite(snap.sat);
    }

    publishAlertState() {
      if (!this.alertService) return;
      this.alertService
        .getCharacteristic(global.Characteristic.On)
        .updateValue(this.alertActive);
    }
  };

module.exports = Alert;
