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
          this.manager.backupResources(msg.payload || './backup')
          break
        case 'loadMqttMap':
          msg.payload = this.manager.loadMqttMap()
          break
        case 'findAP':
          if (!msg.bssid && !msg.topic)  return done('BSSID not selected')
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
      try {
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
          await this.manager.downloadAllConfigs(msg.force)
          break
        case 'scanNetwork':
          this.status({ text: 'scan', fill: 'yellow', shape: 'dot' })
          const devList = await this.manager.scanNetwork((idx, count) => this.status({ text: `scan ${idx}/${count}`, fill: 'yellow', shape: 'dot' }))
          this.status({ text: 'ready', fill: 'green', shape: 'dot' })
          RED.events.emit('runtime-event', { id: this.id, retain: false, payload: devList })
          break
        case 'refreshDb':
          await this.manager.initialize(true)
          RED.events.emit('runtime-event', { id: this.id, retain: false, payload: this.manager.devicesDb?.data || {} })
          break
        default:
          this.warn(`Unknown action:${msg.action}, msg:${JSON.stringify(msg)}`)
          return done()
        }
        send(msg)
      }
      catch(err) {
        this.error(err)
      }
      done()
    }
  }

  RED.nodes.registerType('tasmota-config', TasmotaConfig)

  //#.node-red\node_modules\@node-red\nodes\core\common\20-inject.js
  RED.httpAdmin.post(
    '/tasmota/:id',
    RED.auth.needsPermission('inject-comm.write'),
    (req, res) => {
      const node = RED.nodes.getNode(req.params.id)
      if (!node) return res.sendStatus(404)
      try {
        if (req.body) node.receive(req.body)
        res.sendStatus(200)
      }
      catch(err) {
        res.sendStatus(500)
        node.error(RED._('inject-comm.failed', { error: err.toString() }))
      }
    }
  )
}
