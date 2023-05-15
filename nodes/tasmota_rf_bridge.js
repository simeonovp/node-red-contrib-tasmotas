module.exports = function (RED) {
  'use strict'
  const TasmotaBase = require('./tasmota_base.js')

  class RfBridge extends TasmotaBase {
    constructor (config) {
      super(config, RED, {})

      const manager = config.manager && RED.nodes.getNode(config.manager)

      // register topic in tasmota device
      this.mqttSubscribeTele('RESULT', (topic, payload) => {
        if (this.config.canReceive) {
          const json = payload.toString()
          const data = (json.charAt(0) === '{') && JSON.parse(json)
          msg.payload = data?.RfReceived
          msg.payload && this.onSend(msg)
        }
      })

      this.on('input', (msg, send, done) => {
        const bridge = this.deviceNode?.config.device
        bridge && msg.timings && msg.payload && manager?.sendRfCode(bridge, msg.timings, msg.payload)
        done()
      })
    }
  }

  RED.nodes.registerType('tasmota-rf-bridge', RfBridge)
}
