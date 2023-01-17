module.exports = function (RED) {
  'use strict'
  const TasmotaBase = require('./tasmota_base.js')

  class TasmotaConfig {
    constructor (config) {
      RED.nodes.createNode(this, config)
      
      this.manager = config.manager && RED.nodes.getNode(config.manager)
        
      this.on('input', (msg, send, done) => {
        if (!this.manager) return done('Manager not found')
        //TODO check needs convert device to IP
        if (!msg.action) msg.action = msg.topic

        switch (msg.action) {
        case 'backupResources':
          //TODO
          break
        case 'loadMqttMap':
          msg.payload = this.manager.loadMqttMap()
          break
        case 'findAP':
          if (!msg.bssid && !msg.topic)  return done('BSSID not selected')
          msg.payload = this.manager.findAP(msg.bssid || msg.topic)
          break
        case 'listDbDevices':
          msg.payload = this.manager.listDbDevices(msg.payload || 'mqtt')
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
        if (!msg.ip && !msg.host)  return done('IP address or host must be selected')
        if (!msg.command && !msg.topic) return done('Command not selected')
        msg.payload = await this.manager.httpCommand(msg.ip || msg.host, msg.command || msg.topic, msg.payload)
        break
      case 'downloadConfig':
        if (!msg.ip && !msg.host) return done('IP address or host must be selected')
        msg.payload = await this.manager.downloadConfig(msg.ip || msg.host, msg.force)
        break
      case 'downloadAllConfigs':
        await this.manager.downloadConfig(msg.force)
        break
      case 'scanNetwork':
        await this.manager.scanNetwork()
        break
      default:
        this.warn('Unknown action:' + msg.action)
        return done()
      }
      send(msg)
      done()
    }
  }

  RED.nodes.registerType('tasmota-config', TasmotaConfig)
}
