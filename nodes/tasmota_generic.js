module.exports = function (RED) {
  'use strict'
  const TasmotaBase = require('./tasmota_base.js')

  const GENERIC_DEFAULTS = {
    subscribeToStat: false,
    subscribeToTele: false
  }

  class TasmotaGeneric extends TasmotaBase {
    constructor (config) {
      super(config, RED, GENERIC_DEFAULTS)

      // Subscribe to STAT messages (all or just RESULT)
      if (this.config.subscribeToStat) {
        this.MQTTSubscribe('stat', '+', (topic, payload) => {
          this.onMqttMessage(topic, payload)
        })
      } else {
        this.MQTTSubscribe('stat', 'RESULT', (topic, payload) => {
          this.onMqttMessage(topic, payload)
        })
      }
      // Subscribe to TELE messages (if requested)
      if (this.config.subscribeToTele) {
        this.MQTTSubscribe('tele', '+', (topic, payload) => {
          this.onMqttMessage(topic, payload)
        })
      }
    }

    onMqttMessage (topic, payloadBuf) {
      let payload = ''
      try {
        payload = JSON.parse(payloadBuf.toString())
      } 
      catch (err) {
        return // ignore any non-json payload
      }

      // Forward to the node output
      const msg = { topic: topic, payload: payload }
      this.onSend(msg)
    }

    onNodeInput (msg) {
      this.sendRawCommand(msg.payload)
    }
  }

  RED.nodes.registerType('tasmota-generic', TasmotaGeneric)
}
