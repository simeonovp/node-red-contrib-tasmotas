module.exports = function (RED) {
  'use strict'

  class TasmotaConfig {
    constructor (config) {
      RED.nodes.createNode(this, config)

      this.manager = config.manager && RED.nodes.getNode(config.manager)

      this.on('input', (msg, send, done) => {
        if (!this.manager) return done('Manager not found')
        // TODO check needs convert device to IP
        if (!msg.action) msg.action = msg.topic
        this.onInput(msg, send, done)
      })
    }

    // All actions (sync and async) share one try/catch and always finish via
    // done()/done(err) - done(err) already reports the error through
    // node.error() and correctly marks the message as failed for
    // Catch/Status/Complete nodes, so there's no separate this.error() call.
    async onInput (msg, send, done) {
      try {
        switch (msg.action) {
          case 'backupResources':
            this.manager.backupResources(msg.payload || './backup')
            break
          case 'loadMqttMap':
            msg.payload = this.manager.loadMqttMap()
            break
          case 'findAP':
            if (!msg.bssid && !msg.topic) return done('BSSID not selected')
            msg.payload = this.manager.findAP(msg.bssid || msg.topic)
            break
          case 'listDevices':
            msg.payload = this.manager.listDevices()
            break
          case 'listDeviceNodes':
            msg.payload = this.manager.listDeviceNodes()
            break
          case 'listDbDevices':
            msg.payload = this.manager.listDbDevices(msg.payload)
            break
          case 'getDbDevices':
            msg.payload = this.manager.getDbDevices()
            break
          case 'httpCommand':
            if (!msg.ip && !msg.host) return done('IP address or host must be selected')
            if (!msg.command && !msg.topic) return done('Command not selected')
            msg.payload = await this.manager.httpCommand(msg.ip || msg.host, msg.command || msg.topic, msg.payload)
            break
          case 'downloadConfig':
            if (!msg.ip && !msg.host) return done('IP address or host must be selected')
            msg.payload = await this.manager.downloadConfig(msg.ip || msg.host, msg.force)
            break
          case 'downloadAllConfigs':
            await this.manager.downloadAllConfigs(msg.force)
            break
          case 'scanNetwork':
            await this.manager.scanNetwork()
            break
          case 'buildRecoveryCommand':
            if (!msg.mac) return done('MAC address not selected')
            msg.payload = this.manager.buildRecoveryCommand(msg.mac)
            break
          default:
            this.warn('Unknown action:' + msg.action)
            return done()
        }
        send(msg)
        done()
      }
      catch (err) {
        done(err)
      }
    }
  }

  RED.nodes.registerType('tasmota-config', TasmotaConfig)
}
