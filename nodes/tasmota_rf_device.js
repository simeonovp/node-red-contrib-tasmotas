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
        for(let code in this.codes) manager.addListener('mqtt', this._onRfReceive.bind(this))
      }
      this.timings = manager?.getTimings(config.group, config.name) || {}
      this.lastBridge = config.bridge || manager.defaultBridge || ''

      this.log('-- codes:' + config.codes)

      this.on('input', (msg, send, done) => {
        //TODO
      })
 
      // Deregister from DeviceNode when this node is deleted or restarted
      this.on('close', (done) => {
        if (manager) {
          for( let code in this.codes) manager.removeListener('mqtt', this._onRfReceive.bind(this))
          if (config.canReceive) manager.saveTimings(config.group, config.name, this.timings)
        }
        done()
      })
    }

    _onRfReceive(code, msg) {
      if (this.config.canReceive) {
        this.lastBridge = msg.bridge
        const bridge = timings[msg.bridge]
        if (bridge) {
          // TODO check/save timings
        }
        else {
          const { Sync, Low, High } = msg.data
          timings[msg.bridge] = { Sync, Low, High }
          this.log(`-- learn bridge:${msg.bridge}, ${JSON.stringify(timings[msg.bridge])}`)
        }
      }

      msg.payload = this.codes[key]?.name
      this.send(msg)
    }
  }

  RED.nodes.registerType('tasmota-rf-device', RfDevice)
}
