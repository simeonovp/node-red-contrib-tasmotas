const path = require('path')
const fs = require('fs')

module.exports = function (RED) {
  'use strict'

  class TasmotaRfManager {
    constructor (config) {
      RED.nodes.createNode(this, config)
      this.config = config
      this.manager = config.manager && RED.nodes.getNode(config.manager)
      this.manager?.addListener('rf-received', this._onRfReceived.bind(this))
      this.defaultBridge = ''
      this.debounce = parseInt(config.debounce) || 0 // 1s
      this.rf433Data = this.manager?.getRf433Codes()
      //this.setMaxListeners(100)

      this.lastTimes = {}
    
      this.on('close', (done) => {
        this.manager?.removeListener('rf-received', this._onRfReceived.bind(this))
        done()
      })
    }

    _onRfReceived(bridge, time, data) {
      //Example: RfReceived":{"Sync":12570,"Low":430,"High":1210,"Data":"E5CD7E","RfKey":"None"}
      const timestamp = Date.now()
      if (!this.defaultBridge) this.defaultBridge = bridge
      if (this.debounce) {
        //filter same event receiver over multiple bridges
        const lastTime = this.lastTimes[data.Data] || 0
        this.lastTimes[data.Data] = timestamp
        if ((timestamp - lastTime) < this.debounce) return
      }
      //this.log('-- emit ' + data.Data)
      this.emit(data.Data, { bridge, time, data })
    }

    sendRfCode(bridge, timings, code) {
      const payload = `RfSync ${timings.Sync}; RfLow ${timings.Low}; RfHigh ${timings.High}; RfCode ${parseInt(code, 16)}`
      this.manager?.mqttCommand(bridge, 'Backlog', payload)
    }

    saveCodes(group, name, codes) {
      if (!this.manager) return
      let dirty = false
      const devices = this.rf433Data[group] || []
      if (!devices.length) {
        this.rf433Data[group] = devices
        dirty = true
        this.warn(`Add group ${group}`)
      }
      const codesEqual = (code1, code2) => {
        return (code1.name === code2.name)
      }
      const device = devices.find(row => (row['name'] === name))
      if (device) {
        for (let code in codes) {
          if (!device.codes[code] || !codesEqual(device.codes[code], codes[code])) {
            device.codes[code] = codes[code]
            dirty = true
            this.warn(`Device ${name} code ${code} changed from "${JSON.stringify(device.codes[code])}" to "${JSON.stringify(codes[code])}"`)
          }
        }
      }
      else {
        devices.push({ name, codes })
        dirty = true
        this.warn(`Add device ${name}`)
      }
      //save if changed
      if (dirty) this.manager.saveRf433Codes()
    }

    getTimings(group, name) {
      return this.manager && this.rf433Data[group].find(row => (row['name'] === name)).timimgs || {}
    }

    saveTimings(group, name, timings) {
      if (!this.manager) return
      let dirty = false
      const timimgsEqual = (bridge1, bridge2) => {
        return (bridge1.Sync === bridge2.Sync) && (bridge1.Low === bridge2.Low) && (bridge1.High === bridge2.High)
      }
      // device must exists after saveCodes called
      const device = this.rf433Data[group].find(row => (row['name'] === name))
      device.timimgs = device.timimgs || {}
      for (let bridge in timings) {
        if (!device.timimgs[bridge] || !timimgsEqual(device.timimgs[bridge], timings[bridge])) {
          device.timimgs[bridge] = timings[bridge]
          dirty = true
          this.warn(`Device ${name} timing for bridge ${bridge} changed from "${JSON.stringify(device.timimgs[bridge])}" to "${JSON.stringify(timings[bridge])}"`)
        }
      }

      // save if changed
      if (dirty) this.manager.saveRf433Codes(true)
    }
  }
  
  RED.nodes.registerType('tasmota-rf-manager', TasmotaRfManager)
}
