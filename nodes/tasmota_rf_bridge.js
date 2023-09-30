module.exports = function (RED) {
  'use strict'
  const TasmotaBase = require('./tasmota_base.js')

  class RfBridge extends TasmotaBase {
    constructor (config) {
      super(config, RED, {})

      const manager = config.manager && RED.nodes.getNode(config.manager)

      const onRfReceive = (topic, payload) => {
        const canReceive = (this.config.canReceive !== undefined) ? this.config.canReceive : true
        if (canReceive) {
          const json = payload.toString()
          const data = (json.charAt(0) === '{') && JSON.parse(json)
          const msg = {}
          msg.payload = data
          msg.data = data?.RfReceived?.Data
          msg.timestamp = Date.now()
          msg.data && super.onSend(msg)
        }
      }

      // register topic in tasmota device
      this.mqttSubscribeTele('RESULT', onRfReceive)

      this.on('input', (msg, send, done) => {
        const bridge = this.deviceNode?.config.device
        bridge && msg.timings && msg.payload && manager?.sendRfCode(bridge, msg.timings, msg.payload)
        done()
      })

      this.on('close', (done) => {
        //this.mqttUnubscribeTele('RESULT', onRfReceive)
        done()
      })
    }
  }

  RED.nodes.registerType('tasmota-rf-bridge', RfBridge)
}
