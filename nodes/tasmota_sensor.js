module.exports = function (RED) {
  'use strict'
  const TasmotaBase = require('./tasmota_base.js')

  const SENSOR_DEFAULTS = {
    rules: [],
    outputTopic: ''
  }

  class TasmotaSensor extends TasmotaBase {
    constructor (config) {
      super(config, RED, SENSOR_DEFAULTS)

      // Subscribe to device telemetry changes  tele/<device>/SENSOR
      this.MQTTSubscribe('tele', 'SENSOR', (topic, payload) => {
        //tasmota/sc_01/tele/SENSOR = {"Time":"2023-01-08T07:20:34","SonoffSC":{"Temperature":23.0,"Humidity":44.0,"DewPoint":10.1,"Light":10,"Noise":40,"AirQuality":90},"TempUnit":"C"}
        this.onSensorTelemetry(topic, payload)
      })

      this.MQTTSubscribe('tele', 'RESULT', (topic, payload) => {
        //tasmota/sc_01/tele/SENSOR = {"Time":"2023-01-08T07:20:34","SonoffSC":{"Temperature":23.0,"Humidity":44.0,"DewPoint":10.1,"Light":10,"Noise":40,"AirQuality":90},"TempUnit":"C"}
        this.onSensorTelemetry(topic, payload)
      })

      // Subscribe to explicit sensor-data responses  stat/<device>/STATUS8
      this.MQTTSubscribe('stat', 'STATUS8', (topic, payload) => {
        this.onSensorStatus(topic, payload)
      })
    }

    onDeviceOnline () {
      // Publish a start command to get the sensors data  cmnd/<device>/STATUS [8]
      this.MQTTPublish('cmnd', 'STATUS', '8')
    }

    onNodeInput (msg) {
      // on input we ask a fresh value
      this.MQTTPublish('cmnd', 'STATUS', '8')
    }

    sendToOutputs (tasmotaData) {
      const topic = this.config.outputTopic ? this.config.outputTopic : undefined

      if (!this.config.rules || !this.config.rules.length) {
        this.onSend({ topic: topic, payload: tasmotaData })
        return
      }

      const messages = []
      for (let i = 0; i < this.config.rules.length; i++) {
        const rule = this.config.rules[i]
        if (!rule || rule === 'payload') {
          messages.push({ topic: topic, payload: tasmotaData })
        } else {
          const expr = RED.util.prepareJSONataExpression(rule, this)
          const result = RED.util.evaluateJSONataExpression(expr, tasmotaData)
          messages.push({ topic: topic, payload: result })
        }
      }
      this.onSend(messages)
    }

    onSensorTelemetry (topic, payload) {
      try {
        const data = JSON.parse(payload.toString())
        this.sendToOutputs(data)
      } 
      catch (err) {
        this.setNodeStatus('red', 'Error parsing JSON data from device')
        this.error(err, 'Error parsing JSON data from device')
      }
    }

    onSensorStatus (topic, payload) {
      try {
        const data = JSON.parse(payload.toString())
        this.sendToOutputs(data.StatusSNS)
      } 
      catch (err) {
        this.setNodeStatus('red', 'Error parsing JSON data from device')
        this.error(err, 'Error parsing JSON data from device')
      }
    }
  }

  RED.nodes.registerType('tasmota-sensor', TasmotaSensor)
}
