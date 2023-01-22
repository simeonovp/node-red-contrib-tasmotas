module.exports = function (RED) {
  'use strict'
  const TasmotaBase = require('./tasmota_base.js')

  const BUTTON_DEFAULTS = {
    idx: 0
  }

  class TasmotaButton extends TasmotaBase {
    constructor (config) {
      super(config, RED, BUTTON_DEFAULTS)

      // Subscribes to stat info for all the buttons  stat/<device>/+
      this.mqttSubscribeStat('+', (topic, payload) => {
        this.onStat(topic, payload)
      })
    }

    onStat (mqttTopic, mqttPayloadBuf) {
      let channel = null
      let action = null
      let payload = null
      const lastTopic = mqttTopic.split('/').pop()
      try {
        payload = JSON.parse(mqttPayloadBuf.toString())
      }
      catch (err) {
        return // ignore any non-json payload
      }

      /* Firmware >= 9.1.0
         stat/topic/RESULT = {"Button<X>":{"Action":"SINGLE"}}
         stat/topic/RESULT = {"Switch<X>":{"Action":"SINGLE"}}
      */
      if (lastTopic === 'RESULT') {
        for (const [key, value] of Object.entries(payload)) {
          if (key.startsWith('Button') || key.startsWith('Switch')) {
            channel = this.extractChannelNum(key)
            action = value.Action
          }
        }
      } 
      /* Firmware < 9.1.0
         stat/topic/BUTTON<X> = {"ACTION":"DOUBLE"}
      */
      else if (lastTopic.startsWith('BUTTON')) {
        channel = this.extractChannelNum(lastTopic)
        action = payload.ACTION
      }

      // something usefull received ?
      if (!channel || !action || (channel !== (this.config.idx + 1))) return

      this.setNodeStatus('green', `${action} (${channel})`)

      this.onSend({ topic: 'button' + channel, payload: action })
    }
  }

  RED.nodes.registerType('tasmota-button', TasmotaButton)
}
