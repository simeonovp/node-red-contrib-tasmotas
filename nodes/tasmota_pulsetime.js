module.exports = function (RED) {
  'use strict'
  const TasmotaBase = require('./tasmota_base.js')

  const PULSETIME_DEFAULTS = {
    idx: 0,
  }

  class TasmotaPulseTime extends TasmotaBase {
    constructor (config) {
      super(config, RED, PULSETIME_DEFAULTS)
      this.switch = this.deviceNode.swiches[this.config.idx]
      this.switch.supportPulseTime = true
      this.pulseTime = null
    }

    onNodeInput (msg) {
      if (msg.device && (this.deviceNode.config.device === msg.device)) return

      const payload = NaN(payload) ? payload || '' : msg.payload
      this.switch.requestTimer(payload.toString())
    }

    onSend(msg) {
      this.log('onSend, topic:' + msg.topic)
      switch(msg.topic) {
        case 'timeout':
          msg.payload = msg.timeout
          super.onSend(msg)
          break
        case 'countdown':
          msg.payload = msg.countdown
          super.onSend([null, msg])
          break
      }
    }
  }

  RED.nodes.registerType('tasmota-pulsetime', TasmotaPulseTime)
}
