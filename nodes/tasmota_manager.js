const { emit } = require('process')
const path = require('path')
const fs = require('fs')
const fsx = require('fs-extra')
const request = require('request')
const spawn = require("child_process").spawn

const socketio = require('socket.io')
const events = require('events')

function JSONparse(json) {
  try {
    return JSON.parse(json)
  }
  catch(err) {
    console.error(`Error JSON.parse(${json}):${err}`)
    //console.warn(err.stack)
  }
}

module.exports = function (RED) {
  'use strict'

  class DbBase {
    constructor(config, manifest) {
      this.config = config || {}
      this.data = undefined
      this.manifest = manifest
  
      this.downloadPending = false
      this.load()
    }

    updateManifest(key, json) {
      if (!this.manifest) return
      this.manifest.data = this.manifest.data || {}
      const fileManifest = this.manifest.data[key] || {}
      if (fileManifest.length && json.length && (fileManifest.length === json.length) && (fileManifest.hash === this.hashCode(json))) return
      fileManifest.length = json.length
      fileManifest.hash = this.hashCode(json)
      fileManifest.date = new Date()
      this.manifest.data[key] = fileManifest
      this.manifest.save(true)
    }

    load() {
      if (!this.config.path || !fs.existsSync(this.config.path)) return
      const json = fs.readFileSync(this.config.path, 'utf8') || {}
      this.data = JSONparse(json)
    }
  
    save(overwrite) {
      if (!this.config.path) return
      if (overwrite || !fs.existsSync(this.config.path)) {
        const json = JSON.stringify(this.data, null, 2)
        fs.createWriteStream(this.config.path).write(json)
        this.updateManifest(this.config.path, json)
      }
    }
  
    download(skipIfSame = false) {
      const url = this.config.url
      if (!url) return
      if (this.downloadPending) return
      this.downloadPending = true
      return new Promise((resolve, reject) => {
        request(url, { json: true }, (err, resp, data) => {
          if (err || (resp && resp.statusCode >= 400) || !data) {
            console.warn('Failed to get ' + url)
            reject (err ? err : resp.statusCode)
            this.downloadPending = false
            return
          }
          
          const json = JSON.stringify(data, null, 2)
          const manifest = this.manifest?.data
          const length = manifest && manifest[url]?.length || 0
          const hash = manifest && manifest[url]?.hash || 0
          if (skipIfSame && length && json.length && (length === json.length) && (hash === this.hashCode(json))) {
            resolve()
            this.downloadPending = false
            return
          }

          this.data = data
          this.updateManifest(url, json)
          resolve(json)
          this.downloadPending = false
        })
      })
    }
    
    hashCode(string) {
      let hash = 0
      for (let i = 0; i < string.length; i++) {
        let code = string.charCodeAt(i)
        hash = ((hash << 5) - hash) + code
        hash = hash & hash // Convert to 32bit integer
      }
      return hash
    }


    getTable(table) {
      return this.data && this.data[table]
    }
  
    findTableRaw(table, col, val, ignorecase = false) {
      const arr = this.getTable(table)
      if (ignorecase) {
        val = val.toUpperCase()
        return arr && arr.find(row => (row[col].toUpperCase() === val))
      }
      return arr && arr.find(row => (row[col] === val))
    }
  
    getTableRawIndex(table, col, val) {
      const arr = this.getTable(table)
      return arr && arr.findIndex(row => (row[col] === val))
    }
  
  }

  class TasmotaManager {
    constructor (config) {
      RED.nodes.createNode(this, config)

      this.config = config
      this.status = 'unconfigured'

      this.resDir = path.resolve(path.join(__dirname, '../resources', config.name))
      this.manifestDb = new DbBase({ path: path.join(this.resDir, 'manifest.json') })

      this.devicesDb = new DbBase({ 
        path: path.join(this.resDir, 'devices.json'), 
        url: this.config.dbUri && (this.config.dbUri + 'devices.json') 
      }, this.manifestDb)
      this.grp = 0

      this.networkDb = new DbBase({ 
        path: path.join(this.resDir, 'network.json'), 
        url: this.config.dbUri && (this.config.dbUri + 'network.json') 
      }, this.manifestDb)

      this.rf433Db = new DbBase({ 
        path: path.join(this.resDir, 'rf433codes.json'), 
        url: this.config.dbUri && (this.config.dbUri + 'rf433codes.json') 
      }, this.manifestDb)
      this.rf433DbDirty = false

      this.confdir = path.join(this.resDir, 'configs')
      if (!fs.existsSync(this.confdir)) fs.mkdirSync(this.confdir, { recursive: true })
      if (!fs.existsSync(this.confdir)) this.error(`Create local cache folder "${this.confdir}" failed`)

      this.devices = {}
      this.hosts = {}

      this.mqttMapPath = path.resolve(path.join(this.confdir, '..', 'mqtt_map.json'))
      this.mqttMap
      this.io
      this.ev = new events.EventEmitter()
      this.ev.setMaxListeners(0)

      this.on('close', (done)=>{
        if (this.rf433DbDirty) this.rf433Db.save(true)
        done()
      })

      this.initialize(true)
      
      if (!fs.existsSync(this.mqttMapPath)) this.downloadAllConfigs()
      else this.loadMqttMap()
    }

    get dbDevices() {  return this.devicesDb.data }
    get network() {  return this.networkDb.data }
 
    async initialize(overwrite = false) {
      //download:
      if (!this.config.dbUri) return
      if (!overwrite && (this.status === 'configured')) return
      if (this.status === 'initializing') return
      this._setStatus('initializing')
      try {
        if (this.devicesDb && await this.devicesDb.download(true)) this.devicesDb.save(overwrite)
        if (this.networkDb && await this.networkDb.download(true)) this.networkDb.save(overwrite)
        const groups = this.devicesDb && this.devicesDb.getTable('groups') || [{ idx: 0, name: '?' }]
        const group = groups.find(row => (row['name'] === this.name))
        if (group) {
          this.grp = group.idx
        }
        else {
          this.grp = groups.lentgh
          groups.push({ idx: this.grp, name: this.name })
          this.log(`DevicesDb add group ${this.name} with idx ${this.grp}`)
          this.devicesDb.save(true)
        }
        await this.downloadIcons()

        this._downloadDecodeConfig()

        this._setStatus('configured')
      }
      catch(err) {
        this.status = 'unconfigured'
        this.error(err.stack || err)
      }
    }

    _setStatus(status) {
      this.status = status
      // Pass the new status to all listeners
      //?? this.emit('devdb_status', status)
    }

    async _downloadDecodeConfig() {
      const localPath = this.confdir + '/decode-config.py'

      if (fs.existsSync(localPath)) return
      this.log('download decode-config.py to ' + localPath)
      const url = 'https://raw.githubusercontent.com/tasmota/decode-config/development/decode-config.py'
      try {
        const data = await this.getRequest(url)
        fs.createWriteStream(localPath).write(data)
      }
      catch {
        this.error(`Error on downloading decode-config tool from ${url}. Download the tool manualy to ${this.confdir}`)
      }
    }

    _spawnDecodeConfig(params) {
      return new Promise((resolve, reject) => {
        const pythonProcess = spawn('python', [this.confdir + '/decode-config.py', ...params])
        pythonProcess.stdout.on('data', (data) => this.log(data))
        pythonProcess.stderr.on('data', (data) => this.warn(data))
        pythonProcess.on('exit', (code, signal) => resolve(code))
      })
    }

    async downloadIcons(all, force) {
      if (!this.devicesDb || !this.config.dbUri) return
      const iconsDir = path.join(this.resDir, 'icons')
      if (fs.existsSync(this.iconsdir)) if (!force) return
      else fs.mkdirSync(this.iconsdir, { recursive: true })
      const devices = this.devicesDb.data?.devices
      if (!devices) return this.error('No devices table in DB')
      const hws = this.devicesDb.data?.hardware
      if (!hws) return this.error('No hardware table in DB')

      const urlDir = new URL('../img/', this.config.dbUri).href
      // const download = (uri, filename, callback) => {
      //   request.head(uri, (err, res, body) => {
      //     request(uri).pipe(fs.createWriteStream(filename)).on('close', callback)
      //   })
      // }
      const saveIconFromUrl = async (url, iconPath) => {
        this.log(`Download icon from url ${url} to ${iconPath}`)
        try {
          const response = await fetch(url)
          const arrayBuffer = await response.arrayBuffer()
          const buffer = Buffer.from(arrayBuffer)
          const imgDir = path.dirname(iconPath)
          if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true })
          fs.createWriteStream(iconPath).write(buffer)
        }
        catch(err) {
          this.error(err)
        }
      }

      const hwList = all && hws || []
      if (!all) {
        for (const device of devices) {
          if (device.fw && device.hw) {
            const hw = !hwList.find(i => i.idx === device.hw) && hws.find(i => i.idx === device.hw)
            if (hw) hwList.push(hw)
          }
        }
      }
      for (const hw of hwList) {
        const img = hw?.img && (hw.img !== '?') && hw.img
        if (!img) continue
        const imgPath = path.join(iconsDir, img)
        if (force || !fs.existsSync(imgPath)) await saveIconFromUrl(urlDir + img, imgPath)
      }
    }

    // begin commands
    backupResources(bakDir) {
      bakDir = path.resolve(path.join(this.resDir, '..', bakDir))
      const date = new Date().toISOString().slice(0, 10)
      const bakPath = path.join(bakDir, `${this.config.name}_${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}`)
      if (!fs.existsSync(bakDir)) fs.mkdirSync(bakDir, { recursive: true })
      try {
        fsx.copySync(this.resDir, bakPath)
      } 
      catch (err) { this.error(err) }
    }
    
    loadMqttMap() {
      this.mqttMap = fs.existsSync(this.mqttMapPath) && JSONparse(fs.readFileSync(this.mqttMapPath, 'utf8')) || {}
      let mapDirty = false

      //refresh map by existing configs
      fs.readdirSync(this.confdir).forEach(file => {
        const { ext } = path.parse(file)
        if (ext !== '.json') return
        const filepath = path.join(this.confdir, file)
        const config = JSONparse(fs.readFileSync(filepath, 'utf8'))
        const ip_address = config?.ip_address
        const mqtt_topic = config?.mqtt_topic
        if (mqtt_topic && ip_address && ip_address[0] && !this.mqttMap[ip_address[0]]) {
          this.mqttMap[ip_address[0]] = mqtt_topic
          mapDirty = true
        }
      }) 
      if (mapDirty) fs.createWriteStream(this.mqttMapPath).write(JSON.stringify(this.mqttMap, null, 2))
      return this.mqttMap
    }

    getRf433Codes() {
      return this.rf433Db.data || {}
    }

    saveRf433Codes(onClose) {
      if (onClose) this.rf433DbDirty = true
      else this.rf433Db.save(true)
    }
    
    onRfReceived(bridge, time, data) {
      this.emit('rf-received', bridge, time, data)
    }

    async downloadConfig(ip, force = false) {
      const mqtt_topic = this.mqttMap[ip]
      const filepath = path.join(this.confdir, (mqtt_topic || ip) + '.json')

      try {
        if (force || !fs.existsSync(filepath)) {
          const err = await this._spawnDecodeConfig([
            '-d', ip,
            '-o', filepath,
            '--json-indent', 2
          ])
          if (err) return
        }
      }
      catch(err) {
        this.error(err.stack || err)
      }
    
      const config = JSONparse(fs.readFileSync(filepath, 'utf8'))
      if (!mqtt_topic && config?.mqtt_topic) {
        fs.renameSync(filepath, path.join(this.confdir, config.mqtt_topic + '.json'))
        this.mqttMap[ip] = config.mqtt_topic
        // check/update device ip by host
        const dbDevice = this.devicesDb.findTableRaw('devices', 'host', config.hostname)
        if (dbDevice) {
          // compare and update existing device
          if (config.ip_address[0] && (dbDevice.ip !== config.ip_address[0])) {
            dbDevice.ip = config.ip_address[0]
            this.devicesDb.save(true)
          }
        }
        else {
          this._addDbDevice({
            host: config.hostname, 
            ip: config.ip_address[0], 
            name: config.friendlyname[0]
          })
        }
  
        if (this.devices[config.hostname] !== ip) {
          this.hosts[config.hostname] = ip
        }
        const sorted = Object.keys(this.mqttMap).sort().reduce((acc, key) => ({...acc, [key]: this.mqttMap[key]}), {})
        this.mqttMap = sorted
        fs.createWriteStream(this.mqttMapPath).write(JSON.stringify(this.mqttMap, null, 2))
      }
      return config
    }

    async downloadAllConfigs(force = false) {
      if (!this.mqttMap) this.loadMqttMap()

      //TODO iterate all tasmota devices
      const devices = this.devicesDb && this.devicesDb.getTable('devices') || []
      for (let device of devices) {
        if (device.fw && device.ip) {
          const mqtt_topic = this.mqttMap[device.ip]
          if (!mqtt_topic || !fs.existsSync(path.join(this.confdir, mqtt_topic + '.json'))) {
            try {
              this.mqttMap[device.ip] = ''
              await this.downloadConfig(device.ip)
            }
            catch(err) {
              this.error(err.stack || err)
            }
          }
        }
      }
    }

    async scanNetwork() {
      if (!this.config.network) return this.error('Network not configured')
      try{
        const parts = this.config.network.split('/')
        const ipBytes = parts[0].split('.')
        if (ipBytes.length !== 4) return this.error('Format error, ip:' + parts[0])

        const ipAdr = parts[0].split('.').reduce((sum, b, i) => sum + (b << 8 * (3 - i)), 0)
        const prefix = (parts.length > 1) && parseInt(parts[1]) || 24
        if (prefix < 16) return this.error('Min supported prefix is 16, configured prefix:' + prefix)
        const mask = (1 << (32 - prefix)) - 1
        const minAdr = ipAdr & ~mask
        const maxAdr = (minAdr + mask)
        const intToIP = (ip) => [24, 16, 8, 0].map(n => (ip >> n) & 0xff).join('.')
        
        this.log(`Scan from ${intToIP(minAdr + 1)} to ${intToIP(maxAdr - 1)}`)
        if (this.busy) return
        this.busy = true
        for (let ip = minAdr + 1; ip < maxAdr; ip++) {
          const ipStr = intToIP(ip)
          if (!this.mqttMap[ipStr]) {
            try {
              const res = await this.httpCommand(ipStr, 'Topic', '', 2000)
              res && this.log('Found Tasmota device at ' + ipStr)
              this.downloadConfig(ipStr)
            }
            catch(err) { }
          }
        }
      }
      catch(err){
        this.error(err)
      }
      this.busy = false
    }

    registerDevice(device) {
      this.devices[device.id] = device
      if (!device.config.ip) return //TODO host
      const dbDevice = this.devicesDb.findTableRaw('devices', 'ip', device.config.ip)
      if (dbDevice) {
        let dirty = false
        // TODO compare and update existing device
        if (dirty) this.devicesDb.save(true)
        return
      }
      // add new DB device
      this._addDbDevice(device.config) //host, ip, mac, name, group, version
    }

    unregisterDevice(device) {
      delete this.devices[device.id]
    }

    _addDbDevice(config) {
      const db = this.dbDevices
      db['devices'] = db['devices'] || []
      const group = config.group && db['groups'].find(row => (row['name'] === config.group))
      db['devices'].push({
        fw: config.version || 1,
        grp: group?.idx || this.grp,
        host: config.host,
        ip: config.ip,
        mac: config.mac || '',
        name: config.name
      })
      this.devicesDb.save(true)
    }

    findAP(bssid) {
      const ap = this.devicesDb && this.devicesDb.findTableRaw('devices', 'mac', bssid, true)
      if (ap) return ap
      const db = this.dbDevices
      db['devices'] = db['devices'] || []
      db['devices'].push({ mac: bssid })
      this.devicesDb.save(true)
    }

    listDevices() {
      const arr = []
      for(let ip in this.mqttMap) {
        const opt = {}
        this.mqttMap[ip] && arr.push((opt[this.mqttMap[ip]] = ip, opt))
      }
      return arr
    }

    listDeviceNodes() {
      const arr = []
      for(let id in this.devices) {
        const opt = {}
        const device = this.devices[id].config 
        arr.push((opt[device.name || device.host] = id, opt))
      }
      return arr
    }

    listDbDevices(field) {
      const arr = []
      let opt
      switch (field) {
      case 'ip':
        this.dbDevices['devices'].forEach((el) => (el.fw && el.ip && arr.push(
          this.mqttMap[el.ip] && (opt = {}, opt[this.mqttMap[el.ip]] = el.ip, opt) || el.ip)))
        return arr
      case 'host':
        this.dbDevices['devices'].forEach((el) => (el.fw && el.host && (el.host !== '?') && arr.push(
          el.ip && this.mqttMap[el.ip] && (opt = {}, opt[this.mqttMap[el.ip]] = el.host, opt) || el.host)))
        return arr
      default:
        this.dbDevices['devices'].forEach((el) => (el.fw && el.ip && this.mqttMap[el.ip] && arr.push(this.mqttMap[el.ip])))
        return arr
      }
    }

    getMqttDevice(topic) {
      for(let id in this.devices) {
        const device = this.devices[id]
        if (device.config.device == topic) return device
      }
    }

    getDbDevices() {
      return this.dbDevices['devices'].filter((el) => el.fw)
    }

    getRequest(url, json, timeout) {
      return new Promise((resolve, reject) => {
        request(url, { json, timeout }, (err, resp, data) => {
          if (err || (resp && resp.statusCode >= 400) || !data) {
            console.warn('Failed to get ' + url)
            reject (err ? err : resp.statusCode)
            this.downloadPending = false
            return
          }
          resolve(data)
        })
      })
    }

    mqttCommand(device, command, payload) {
      const tasmota = this.getMqttDevice(device)
      tasmota && tasmota.mqttCommand(command, payload)
    }

    async httpCommand(ip, cmnd, val, timeout) {
      const url = `http://${ip}/cm?cmnd=${cmnd}` + (val && (' ' + val) || '')
      return await this.getRequest(url, true, timeout)
    }
    // end commands
  }

  RED.nodes.registerType('tasmota-manager', TasmotaManager)
}
