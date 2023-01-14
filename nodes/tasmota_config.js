module.exports = function (RED) {
  'use strict'
  const TasmotaBase = require('./tasmota_base.js')

  class TasmotaConfig {
    constructor (config) {
      RED.nodes.createNode(this, config)
      
      this.manager = config.manager && RED.nodes.getNode(config.manager)
        
      this.on('input', (msg, send, done) => {
        this.log('-- on input action:' + msg.action)
        if (!this.manager) return done('Manager not found')
        if (!msg.action) return done('No action selected')

        switch (msg.action) {
        case 'loadMqttMap':
          msg.payload = this.manager.loadMqttMap()
          break
        case 'findAP':
          if (!msg.bssid)  return done('BSSID not selected')
          msg.payload = this.manager.findAP(msg.bssid)
          break
        case 'getDbDevices':
          msg.payload = this.manager.getDbDevices()
          break
        default:
          try {
            return this.onInput(msg, send, done)
          }
          catch (err) {
            done(err)
          }
        }
        send(msg)
        done()
      })
    }

    async onInput(msg, send, done) {
      switch (msg.action) {
      case 'httpCommand':
        if (!msg.ip)  return done('IP address not selected')
        if (!msg.command)  return done('Command not selected')
        msg.payload = await this.manager.httpCommand(msg.ip, msg.command, msg.val)
        break
      case 'downloadConfig':
        if (!msg.ip)  return done('IP address not selected')
        msg.payload = await this.manager.downloadConfig(msg.ip, msg.force)
        break
      case 'downloadAllConfigs':
        await this.manager.downloadConfig(msg.force)
        break
      default:
        this.warn('Unknown action:' + msg.action)
        return done()
      }
      //this.log('-- on input resp:' + JSON.stringify(msg, null, 2))
      send(msg)
      done()
    }
  }

  RED.nodes.registerType('tasmota-config', TasmotaConfig)
}
