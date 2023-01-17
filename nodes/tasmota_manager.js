const { emit } = require('process')
const path = require('path')
const fs = require('fs')
const request = require('request')
const spawn = require("child_process").spawn;

const socketio = require('socket.io');
const events = require('events');

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
      this.data = JSON.parse(json)
    }
  
    save(overwrite) {
      if (!this.config.path) return;
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
            return;
          }
          
          const json = JSON.stringify(data, null, 2)
          const manifest = this.manifest?.data
          const length = manifest && manifest[url]?.length || 0
          const hash = manifest && manifest[url]?.hash || 0
          if (skipIfSame && length && json.length && (length === json.length) && (hash === this.hashCode(json))) {
            resolve()
            this.downloadPending = false
            return;
          }

          this.data = data
          this.updateManifest(url, json)
          resolve(json)
          this.downloadPending = false
        });
      });
    }
    
    hashCode(string) {
      let hash = 0
      for (let i = 0; i < string.length; i++) {
        let code = string.charCodeAt(i)
        hash = ((hash << 5) - hash) + code;
        hash = hash & hash; // Convert to 32bit integer
      }
      return hash;
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
      this.status = 'unconfigured';

      const resDir = path.resolve(path.join(__dirname, '../resources', config.name))
      const cfgDir = path.join(resDir, 'configs')
      this.manifestDb = new DbBase({ path: path.join(resDir, 'manifest.json') });

      this.devicesDb = new DbBase({ 
        path: path.join(resDir, 'devices.json'), 
        url: this.config.dbUri && (this.config.dbUri + 'devices.json') 
      }, this.manifestDb);
      this.grp = 0

      this.networkDb = new DbBase({ 
        path: path.join(resDir, 'network.json'), 
        url: this.config.dbUri && (this.config.dbUri + 'network.json') 
      }, this.manifestDb);

      this.rf433Db = new DbBase({ 
        path: path.join(resDir, 'rf433codes.json'), 
        url: this.config.dbUri && (this.config.dbUri + 'rf433codes.json') 
      }, this.manifestDb);

      this.confdir = path.join(resDir, 'configs')
      if (!fs.existsSync(this.confdir)) fs.mkdirSync(this.confdir, { recursive: true });

      this.mqttMapPath = path.resolve(path.join(this.confdir, '..', 'mqtt_map.json'))
      this.mqttMap
      this.io
      this.ev = new events.EventEmitter()
      this.ev.setMaxListeners(0)
      this.rfManager

      this.on('input', (msg, send, done) => {
        switch (msg.topic) {
          case 'downloadAllConfigs':
            this.downloadAllConfigs().then(() => done(msg))
            break
        }
      })

      this.initialize(true)
      
      if (!fs.existsSync(this.mqttMapPath)) this.downloadAllConfigs()
    }

    get devices() {  return this.devicesDb.data }
    get network() {  return this.networkDb.data }
 
    async initialize(overwrite = false) {
      //download:
      if (!this.config.dbUri) return
      if (!overwrite && (this.status === 'configured')) return
      if (this.status === 'initializing') return
      this._setStatus('initializing');
      try {
        if (this.devicesDb && await this.devicesDb.download(true)) this.devicesDb.save(overwrite)
        if (this.networkDb && await this.networkDb.download(true)) this.networkDb.save(overwrite);
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

        this._downloadDecodeConfig()

        this._setStatus('configured');
      }
      catch(err) {
        this.status = 'unconfigured';
        this.error(err.stack || err);
      }
    }

    _setStatus(status) {
      this.status = status;
      // Pass the new status to all listeners
      //?? this.emit('devdb_status', status);
    }

    async _downloadDecodeConfig() {
      const localPath = this.confdir + '/decode-config.py'

      if (fs.existsSync(localPath)) return
      this.log('download decode-config.py to ' + localPath)
      const url = 'https://raw.githubusercontent.com/tasmota/decode-config/development/decode-config.py'
      const data = await this.getRequest(url)
      fs.createWriteStream(localPath).write(data)
    }

    _spawnDecodeConfig(params) {
      return new Promise((resolve, reject) => {
        const pythonProcess = spawn('python', [this.confdir + '/decode-config.py', ...params])
        pythonProcess.stdout.on('data', (data) => this.log(data))
        pythonProcess.stderr.on('data', (data) => this.warn(data))
        pythonProcess.on('exit', (code, signal) => resolve(code))
      })
    }

    // begin commands
    loadMqttMap() {
      this.mqttMap = fs.existsSync(this.mqttMapPath) && JSON.parse(fs.readFileSync(this.mqttMapPath, 'utf8')) || {}
      let mapDirty = false

      //refresh map by existing configs
      fs.readdirSync(this.confdir).forEach(file => {
        const { ext } = path.parse(file);
        if (ext !== '.json') return
        const filepath = path.join(this.confdir, file)
        const config = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        const ip_address = config?.ip_address
        const mqtt_topic = config?.mqtt_topic
        if (mqtt_topic && ip_address && ip_address[0] && !this.mqttMap[ip_address[0]]) {
          this.mqttMap[ip_address[0]] = mqtt_topic
          mapDirty = true
        }
      }); 
      if (mapDirty) fs.createWriteStream(this.mqttMapPath).write(JSON.stringify(this.mqttMap, null, 2));
      return this.mqttMap
    }

    getRf433Codes() {
      return this.rf433Db.data || {}
    }

    async downloadConfig(ip, force = false) {
      if (!this.mqttMap) this.loadMqttMap()
      const mqtt_topic = this.mqttMap && this.mqttMap[ip]
      const filepath = path.join(this.confdir, (mqtt_topic || ip) + '.json')

      try {
        if (force || !fs.existsSync(filepath)) {
          const err = await this._spawnDecodeConfig([
            '-d', ip,
            '-o', filepath,
            '--json-indent', 2
          ]);
          if (err) return
        }
      }
      catch(err) {
        this.error(err.stack || err);
      }
    
      const config = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      if (!mqtt_topic && config?.mqtt_topic) {
        fs.renameSync(filepath, path.join(this.confdir, config.mqtt_topic + '.json'))
        if (this.mqttMap) {
          this.mqttMap[ip] = config.mqtt_topic
          const sorted = Object.keys(this.mqttMap).sort().reduce((acc, key) => ({...acc, [key]: this.mqttMap[key]}), {})
          this.mqttMap = sorted
          fs.createWriteStream(this.mqttMapPath).write(JSON.stringify(this.mqttMap, null, 2));
        }
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
              this.error(err.stack || err);
            }
          }
        }
      }
    }

    async scanNetwork() {
      if (!this.config.network) return this.error('Network not configured')
      if (!this.mqttMap) this.loadMqttMap()
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
      if (!device.config.ip) return
      const dbDevice = this.devicesDb.findTableRaw('devices', 'ip', device.config.ip)
      if (dbDevice) {
        let dirty = false
        // compare and update existing device
        if (dirty) this.devicesDb.save(true)
        return
      }
      if (!this.devicesDb.data) return
      const db = this.devicesDb.data
      db['devices'] = db['devices'] || []
      const group = device.config.group && db['groups'].find(row => (row['name'] === device.config.group))
      db['devices'].push({
        fw: device.config.version || 1,
        grp: group?.idx || this.grp,
        host: device.config.host,
        ip: device.config.ip,
        mac: device.config.mac,
        name: device.config.name
      })
      this.devicesDb.save(true)
    }

    findAP(bssid) {
      const ap = this.devicesDb && this.devicesDb.findTableRaw('devices', 'mac', bssid, true)
      if (ap) return ap
      if (!this.devicesDb.data) return
      const db = this.devicesDb.data
      db['devices'] = db['devices'] || []
      db['devices'].push({ mac: bssid })
      this.devicesDb.save(true)
    }

    getDbDevices() {
      return this.devicesDb.data && this.devicesDb.data['devices'].filter((el) => el.fw)
    }

    listDbDevices(field) {
      const arr = []
      if (!this.devicesDb.data) return arr
      switch (field) {
      case 'ip':
        this.devicesDb.data['devices'].forEach((el) => (el.fw && el.ip && arr.push(el.ip)))
        return arr
      case 'host':
        this.devicesDb.data['devices'].forEach((el) => (el.fw && el.host && (el.host !== '?') && arr.push(el.host)))
        return arr
      default:
        if (!this.mqttMap) this.loadMqttMap()
        this.devicesDb.data['devices'].forEach((el) => (el.fw && el.ip && this.mqttMap[el.ip] && arr.push(this.mqttMap[el.ip])))
        return arr
      }
    }

    getRequest(url, json, timeout) {
      return new Promise((resolve, reject) => {
        request(url, { json, timeout }, (err, resp, data) => {
          if (err || (resp && resp.statusCode >= 400) || !data) {
            console.warn('Failed to get ' + url)
            reject (err ? err : resp.statusCode)
            this.downloadPending = false
            return;
          }
          resolve(data)
        });
      });
    }

    async httpCommand(ip, cmnd, val, timeout) {
      const url = `http://${ip}/cm?cmnd=${cmnd}` + (val && (' ' + val) || '')
      return await this.getRequest(url, true, timeout)
    }
    // end commands
  }

  RED.nodes.registerType('tasmota-manager', TasmotaManager)
}
