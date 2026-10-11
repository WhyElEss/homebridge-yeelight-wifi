// Writes closer together than this are one burst from the home hub, not a
// finger. The Home app streams a drag at one write every 210-270 ms; on
// 2026-10-11 the hub (an Apple TV) three times held a whole drag back and then
// sent it in one go, 7-11 ms apart and out of order - 0 -> 100 arrived as
// 100, 60, 96, 100, 1. Each time the first value of the burst was where the
// finger stopped and the last was not, so the last one, which is what used to
// win, lit the lamp at 1% under a slider showing 100.
const BURST_GAP = 30;

const Brightness = (Device) =>
  class extends Device {
    constructor(props, platform) {
      super(props, platform);
      this.bright = props.bright;
      this.lastBrightnessWrite = 0;
      this.burstValue = null;
      this.burstTimer = null;

      (
        this.service.getCharacteristic(global.Characteristic.Brightness) ||
        this.service.addCharacteristic(global.Characteristic.Brightness)
      )
        .on('set', (value, callback) => {
          this.heard('Brightness', value);
          if (this.inBurst(value)) {
            callback(null);
            return;
          }
          this.accepted(this.setBrightness(value), () =>
            this.service
              .getCharacteristic(global.Characteristic.Brightness)
              .updateValue(this.bright)
          );
          callback(null);
        })
        .updateValue(this.bright);
    }

    // Whether this write is part of a burst that already has its value. The
    // first write of a burst goes through; the rest are logged and dropped,
    // and once the burst is over HomeKit is told the value that was kept - it
    // stored the last one it sent, which is how the slider fell back to 1.
    inBurst(value) {
      const now = Date.now();
      const gap = now - this.lastBrightnessWrite;
      this.lastBrightnessWrite = now;
      if (gap >= BURST_GAP) {
        this.burstValue = value;
        return false;
      }
      this.log.info(
        `${this.tag}: Brightness=${value} came ${gap} ms after the last one - part of a burst, keeping ${this.burstValue}.`
      );
      clearTimeout(this.burstTimer);
      this.burstTimer = setTimeout(() => {
        this.burstTimer = null;
        this.reflect({ Brightness: this.burstValue });
      }, BURST_GAP * 3);
      return true;
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
        // As much an Off as one written to On - see OFF_TAIL in bulb.js.
        this.offAt = Date.now();
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
