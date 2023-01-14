module.exports = function (RED) {
  'use strict'
  const TasmotaBase = require('./tasmota_base.js')

  class TasmotaConfig {
    constructor (userConfig) {
      RED.nodes.createNode(this, config)
      
      this.manager = this.config.manager && RED.nodes.getNode(this.config.manager)
        
      this.on('input', (msg, send, done) => {
      })
    }

  }

  RED.nodes.registerType('tasmota-config', TasmotaConfig)
}
