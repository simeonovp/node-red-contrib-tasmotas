module.exports = function (RED) {
  'use strict'
  
  class RfDevice {
    constructor (config) {
      RED.nodes.createNode(this, config)

      const manager = config.manager && RED.nodes.getNode(config.manager)
      const keys = config.keys && config.keys.split(',') || []

      this.on('input', (msg, send, done) => {
        //TODO
      })

      if (manager) {
        for( let key of keys) manager.addListener('mqtt', this._onRfReceive.bind(this))
      }
  
      // Deregister from DeviceNode when this node is deleted or restarted
      this.on('close', (done) => {
        if (manager) {
          for( let key of keys) manager.removeListener('mqtt', this._onRfReceive.bind(this))
        }
        done()
      })
    }

    _onRfReceive(key, msg) {
      this.send(msg)
    }
  }

  RED.nodes.registerType('tasmota-rf-device', RfDevice)
}
