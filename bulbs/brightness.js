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
      // Zero is how HomeKit says "off" through the brightness slider, and on a
      // grouped accessory - a lamp with switches of its own - that slider is
      // the only control the tile offers. The firmware has no zero: set_bright
      // clamps to 1, and on a lamp that was already off the same patch turned
      // into the set_scene that woke it. Dragging to the bottom put the lamp
      // back on at 1%, which is how this was found.
      if (!(Number(brightness) > 0)) {
        return this.applyState({ power: false, force: true });
      }

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
        // The cache always follows the lamp; HomeKit only hears about changes
        // that did not come from us. Confirming our own set_bright to a
        // controller that already holds a later value is what drags a slider
        // backwards under the finger that is still moving it.
        if (!this.publishable(prop, value)) return;
        this.service
          .getCharacteristic(global.Characteristic.Brightness)
          .updateValue(this.bright);
        return;
      }
      super.updateStateFromProp(prop, value);
    }
  };

module.exports = Brightness;
