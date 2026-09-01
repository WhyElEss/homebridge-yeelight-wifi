const Color = (Device) =>
  class extends Device {
    constructor(props, platform) {
      super(props, platform);
      this.hue = props.hue;
      this.sat = props.sat;

      const { Hue, Saturation } = global.Characteristic;

      (
        this.service.getCharacteristic(Hue) ||
        this.service.addCharacteristic(Hue)
      )
        .on('set', (value, callback) => {
          this.accepted(this.setColor(value, null), () =>
            this.service.getCharacteristic(Hue).updateValue(this.hue)
          );
          callback(null);
        })
        .updateValue(this.hue);

      (
        this.service.getCharacteristic(Saturation) ||
        this.service.addCharacteristic(Saturation)
      )
        .on('set', (value, callback) => {
          this.accepted(this.setColor(null, value), () =>
            this.service.getCharacteristic(Saturation).updateValue(this.sat)
          );
          callback(null);
        })
        .updateValue(this.sat);
    }

    get hue() {
      return this._hue;
    }

    set hue(value) {
      this._hue = Number(value);
    }

    get sat() {
      return this._sat;
    }

    set sat(value) {
      this._sat = Number(value);
    }

    updateStateFromProp(prop, value) {
      if (prop === 'hue') {
        this.hue = value;
        if (!this.publishable(prop, value)) return;
        this.service
          .getCharacteristic(global.Characteristic.Hue)
          .updateValue(this.hue);
        return;
      }
      if (prop === 'sat') {
        this.sat = value;
        if (!this.publishable(prop, value)) return;
        this.service
          .getCharacteristic(global.Characteristic.Saturation)
          .updateValue(this.sat);
        return;
      }
      if (prop === 'rgb') {
        return;
      }
      super.updateStateFromProp(prop, value);
    }

    // HomeKit writes Hue and Saturation as two calls milliseconds apart. They
    // are merged by the flush window, which is what the old module-level hue
    // and sat pair was reaching for -- it leaked between calls and stuck for
    // good whenever a send failed.
    setColor(hv, sv) {
      const patch = { power: true };
      if (Number.isFinite(hv)) patch.hue = hv;
      if (Number.isFinite(sv)) patch.sat = sv;
      if (patch.hue === undefined && patch.sat === undefined) {
        return Promise.resolve();
      }
      return this.applyState(patch);
    }
  };

module.exports = Color;
