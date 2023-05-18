module.exports = function (RED) {
  'use strict'
  const TasmotaBase = require('./tasmota_base.js')

  const SWITCH_DEFAULTS = {
    idx: 0,
    supportPulseTime: false, //#2--
    supportChangeTime: false
  }

  class TasmotaSwitch extends TasmotaBase {
    constructor (config) {
      super(config, RED, SWITCH_DEFAULTS)
      this.switch = this.deviceNode.swiches[this.config.idx]
      //#2---
      if (this.config.supportPulseTime) {
        this.warn('Parameter SupportPulseTime is deprecated. Use PulseTime node instead')
        this.switch.supportPulseTime = true
      }
    }

    onNodeInput (msg) {
      if (msg.device && (this.deviceNode.config.device === msg.device)) return

      let payload = msg.payload
      const topic = (msg.topic || '').toLowerCase()
      //#2---
      if (topic.startsWith('timeout')) {
        if (!this.config.supportPulseTime) return
        const channel = this.extractChannelNum(topic)
        this.switch.requestTimer(payload.toString())
        return
      }

      if (typeof payload !== 'boolean') {
        // Switch On/Off for booleans and 1/0 (int or str)
        if (payload === 1) payload = true
        else if (payload === 0) payload = false
        // String payload: on/off, true/false, toggle (not case sensitive)
        else if (typeof payload === 'string') {
          switch (payload.toLowerCase()) {
            case '1':
            case 'on':
            case 'true':
              payload = true
              break
            case '0':
            case 'off':
            case 'false':
              payload = false
              break
            case 'toggle':
              payload = !this.switch.lastValue
              break
            default:
              this.warn('Invalid payload received on input' + JSON.stringify(msg))
              return
          }
        }
        else {
          this.warn('Invalid payload received on input' + JSON.stringify(msg))
          return
        }
      }
      
      if (payload !== this.switch.lastValue) this.switch.setPower(payload)
    }

    onSend(msg) {
      msg.payload = this.switch.lastValue
      if (this.config.supportChangeTime) msg.time = this.switch.lastChangeTime.toLocaleString()
      switch(msg.topic) {
        case 'switch':
          // update status icon and label
          if (this.switch.lastValue) this.setNodeStatus('green', 'On')
          else  this.setNodeStatus('grey', 'Off')
          super.onSend(msg)
          break
        default:
          if (this.config.supportPulseTime) super.onSend(msg) //#2--
      }
    }
  }

  RED.nodes.registerType('tasmota-switch', TasmotaSwitch)
}
