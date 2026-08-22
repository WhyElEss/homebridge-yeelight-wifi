const BacklightColor = (Device) =>
  class extends Device {
    constructor(props, platform) {
      super(props, platform);
      this.backlightHue = props['bg_hue'];
      this.backlightSat = props['bg_sat'];
      // Hue and Saturation arrive as two separate writes; the half that lands
      // first is parked here until its partner shows up.
      this.pendingBacklightColor = {};

      const { Hue, Saturation } = global.Characteristic;

      (
        this.backlightService.getCharacteristic(Hue) ||
        this.backlightService.addCharacteristic(Hue)
      )
        .on('set', (value, callback) => {
          this.accepted(this.setBacklightColor(value, null), () =>
            this.backlightService
              .getCharacteristic(Hue)
              .updateValue(this.backlightHue)
          );
          callback(null);
        })
        .updateValue(this.backlightHue);

      (
        this.backlightService.getCharacteristic(Saturation) ||
        this.backlightService.addCharacteristic(Saturation)
      )
        .on('set', (value, callback) => {
          this.accepted(this.setBacklightColor(null, value), () =>
            this.backlightService
              .getCharacteristic(Saturation)
              .updateValue(this.backlightSat)
          );
          callback(null);
        })
        .updateValue(this.backlightSat);
    }

    get backlightHue() {
      return this._backlightHue;
    }

    set backlightHue(value) {
      this._backlightHue = Number(value);
    }

    get backlightSat() {
      return this._backlightSat;
    }

    set backlightSat(value) {
      this._backlightSat = Number(value);
    }

    updateStateFromProp(prop, value) {
      if (prop === 'bg_hue') {
        this.backlightHue = value;
        this.backlightService
          .getCharacteristic(global.Characteristic.Hue)
          .updateValue(this.backlightHue);
        return;
      }
      if (prop === 'bg_sat') {
        this.backlightSat = value;
        this.backlightService
          .getCharacteristic(global.Characteristic.Saturation)
          .updateValue(this.backlightSat);
        return;
      }
      if (prop === 'bg_rgb') {
        return;
      }
      super.updateStateFromProp(prop, value);
    }

    async setBacklightColor(hv, sv) {
      const pending = this.pendingBacklightColor;
      if (Number.isFinite(hv)) pending.hue = hv;
      if (Number.isFinite(sv)) pending.sat = sv;

      const hue = pending.hue === undefined ? this.backlightHue : pending.hue;
      const sat = pending.sat === undefined ? this.backlightSat : pending.sat;
      if (!Number.isFinite(hue) || !Number.isFinite(sat)) return;

      const { color: transition = 400 } = this.config.transitions || {};
      await this.setBacklightPower(true);
      const req = {
        method: 'bg_set_hsv',
        params: [Math.round(hue), Math.round(sat), 'smooth', transition],
      };
      return this.sendCmd(req).then(() => {
        this._backlightHue = hue;
        this._backlightSat = sat;
        this.pendingBacklightColor = {};
      });
    }
  };

module.exports = BacklightColor;
