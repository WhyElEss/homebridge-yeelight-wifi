const Brightness = (Device) =>
  class extends Device {
    constructor(props, platform) {
      super(props, platform);
      this.bright = props.bright;

      (
        this.service.getCharacteristic(global.Characteristic.Brightness) ||
        this.service.addCharacteristic(global.Characteristic.Brightness)
      )
        .on('set', (value, callback) => {
          this.accepted(this.setBrightness(value), () =>
            this.service
              .getCharacteristic(global.Characteristic.Brightness)
              .updateValue(this.bright)
          );
          callback(null);
        })
        .updateValue(this.bright);
    }

    get bright() {
      return this._bright;
    }

    set bright(bright) {
      this._bright = Number(bright);
    }

    setBrightness(brightness) {
      // The lamp drops brightness while it is off, so power is requested in the
      // same flush rather than as a separate command ahead of it.
      return this.applyState({ power: true, bright: brightness });
    }

    updateStateFromProp(prop, value) {
      // Which property carries the brightness depends on the mode: in night
      // mode the lamp reports nl_br, and goes on reporting the daylight
      // `bright` it will return to, which is not what is lit right now. The
      // moonlight mixin sits outside this one, so by the time either prop
      // arrives here the mode is already known.
      if (prop === 'bright' && this.nightMode) return;
      if (prop === 'nl_br' && !this.nightMode) return;
      if (['bright', 'nl_br'].includes(prop)) {
        this.bright = value;
        this.service
          .getCharacteristic(global.Characteristic.Brightness)
          .updateValue(this.bright);
        return;
      }
      super.updateStateFromProp(prop, value);
    }
  };

module.exports = Brightness;
