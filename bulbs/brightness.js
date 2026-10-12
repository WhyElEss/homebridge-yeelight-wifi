// Writes closer together than this are one burst from the home hub, not a
// finger. The Home app streams a drag at one write every 210-270 ms; the hub
// (an Apple TV) sometimes holds a whole drag back and sends it in one go,
// 7-11 ms apart and out of order. Neither end of a burst is where the finger
// stopped: of the four bursts whose end the owner reported on 2026-10-11/12,
// the first value was right three times (100, 60, 96, 100, 1 for a drag to
// 100) and wrong once (67, 6, 98, 100 for a drag to 100), and the last value
// was right twice. What was right every time is the value furthest from where
// the lamp started, in the direction the values went.
const BURST_GAP = 30;

const Brightness = (Device) =>
  class extends Device {
    constructor(props, platform) {
      super(props, platform);
      this.bright = props.bright;
      this.lastBrightnessWrite = 0;
      // The burst in progress: where the lamp stood when it began, every
      // value it has carried, and the one currently chosen.
      this.burstBase = 0;
      this.burstValues = [];
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

    // Whether this write belongs to a burst already under way. The first
    // write of a burst goes through at once; each one after it is folded into
    // the burst, and if that moves the choice the lamp is sent the new choice -
    // usually before the first has even left the coalescing window. Once the
    // burst is over HomeKit is told the value chosen, since the hub keeps the
    // last one it sent.
    inBurst(value) {
      const now = Date.now();
      const gap = now - this.lastBrightnessWrite;
      this.lastBrightnessWrite = now;
      if (gap >= BURST_GAP) {
        this.burstBase = this.power ? Number(this.bright) || 0 : 0;
        this.burstValues = [value];
        this.burstValue = value;
        return false;
      }

      this.burstValues.push(value);
      const chosen = this.burstChoice();
      this.log.info(
        `${this.tag}: Brightness=${value} came ${gap} ms after the last one - part of a burst from ${this.burstBase}, keeping ${chosen}.`
      );
      if (chosen !== this.burstValue) {
        this.burstValue = chosen;
        this.accepted(this.setBrightness(chosen), () =>
          this.reflect({ Brightness: this.bright })
        );
      }

      clearTimeout(this.burstTimer);
      this.burstTimer = setTimeout(() => {
        this.burstTimer = null;
        this.reflect({ Brightness: this.burstValue });
      }, BURST_GAP * 3);
      return true;
    }

    // The furthest value in the direction the burst went from where the lamp
    // stood; the last one when it went both ways.
    burstChoice() {
      const values = this.burstValues.map(Number);
      const base = this.burstBase;
      if (values.every((v) => v >= base)) return Math.max(...values);
      if (values.every((v) => v <= base)) return Math.min(...values);
      return values[values.length - 1];
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
