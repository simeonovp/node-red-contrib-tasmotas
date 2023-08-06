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
      if (this.switch) this.switch.supportPulseTime = true
    }

    onNodeInput (msg) {
      if (msg.device && (this.deviceNode.config.device === msg.device)) return

      const payload = isNaN(msg.payload) ? msg.payload || '' : msg.payload
      this.switch.requestTimer(payload.toString())
    }

    onSend(msg) {
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
