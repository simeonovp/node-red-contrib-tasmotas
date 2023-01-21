module.exports = function (RED) {
  'use strict'
  
  class RfDevice {
    constructor (config) {
      RED.nodes.createNode(this, config)

      config.group = config.group || 'default'
      this.config = config
      this.codes = config.codes && JSON.parse(config.codes) || {}
      const manager = config.manager && RED.nodes.getNode(config.manager)
      if (manager) {
        manager.saveCodes(config.group, config.name, this.codes)
        for(let code in this.codes) manager.addListener(code, this._onRfReceive.bind(this))
      }
      this.timings = manager?.getTimings(config.group, config.name) || {}
      this.lastBridge = config.bridge || manager.defaultBridge || ''

      this.on('input', (msg, send, done) => {
        //TODO
      })
 
      // Deregister from DeviceNode when this node is deleted or restarted
      this.on('close', (done) => {
        if (manager) {
          for( let code in this.codes) manager.removeListener(code, this._onRfReceive.bind(this))
          if (config.canReceive) manager.saveTimings(config.group, config.name, this.timings)
        }
        done()
      })
    }

    _onRfReceive(msg) {
      if (this.config.canReceive) {
        this.lastBridge = msg.bridge
        const bridge = this.timings[msg.bridge]
        if (bridge) {
          // TODO check/save timings
        }
        else {
          const { Sync, Low, High } = msg.data
          this.timings[msg.bridge] = { Sync, Low, High }
        }
      }

      msg.payload = this.codes[msg.data.Data]?.name
      this.send(msg)
    }
  }

  RED.nodes.registerType('tasmota-rf-device', RfDevice)
}
