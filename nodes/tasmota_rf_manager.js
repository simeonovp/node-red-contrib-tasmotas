const path = require('path')
const fs = require('fs')

module.exports = function (RED) {
  'use strict'

  class TasmotaRfManager {
    constructor (config) {
      RED.nodes.createNode(this, config)
      this.config = config
      this.manager = config.manager && RED.nodes.getNode(config.manager)
      this.debounce = parseInt(config.debounce) || 0 // 1s
      this.mqttMap = this.manager?.getRf433Codes()

      this.lastTimes = {}
    }

    onRfReceived(bridge, time, data) {
      //Example: RfReceived":{"Sync":12570,"Low":430,"High":1210,"Data":"E5CD7E","RfKey":"None"}
      const timestamp = Date.now()
      if (this.debounce) {
        //filter same event receiver over multiple bridges
        const lastTime = lastTimes[data.Data] || 0
        lastTimes[data.Data] = timestamp
        if ((timestamp - lastTime) < this.debounce) return
      }
      this.emit(data.Data, { bridge, time, data })
    }
  }
  
  RED.nodes.registerType('tasmota-rf-manager', TasmotaRfManager)
}
