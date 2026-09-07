const path = require('path')
const fs = require('fs')
const fsx = require('fs-extra')
const spawn = require('child_process').spawn

const events = require('events')
const { NetHelper } = require('./lib/utils.js')

function JSONparse (json) {
  try {
    return JSON.parse(json)
  }
  catch (err) {
    console.error(`Error JSON.parse(${json}):${err}`)
  }
}

module.exports = function (RED) {
  'use strict'

  class DbBase {
    constructor (config, manifest) {
      this.config = config || {}
      this.data = undefined
      this.manifest = manifest

      this.downloadPending = false
      this.load()
    }

    updateManifest (key, json) {
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

    ensureData () {
      if (!this.data || typeof this.data !== 'object' || Array.isArray(this.data)) {
        this.data = {}
      }
      this.data.devices = Array.isArray(this.data.devices) ? this.data.devices : []
      this.data.groups = Array.isArray(this.data.groups) ? this.data.groups : []
      return this.data
    }

    load () {
      if (!this.config.path || !fs.existsSync(this.config.path)) {
        this.data = {}
        return
      }
      const json = fs.readFileSync(this.config.path, 'utf8') || '{}'
      const parsed = JSONparse(json)
      this.data = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {}
      this.ensureData()
    }

    save (overwrite) {
      if (!this.config.path) return
      this.ensureData()
      if (overwrite || !fs.existsSync(this.config.path)) {
        const json = JSON.stringify(this.data, null, 2)
        fs.createWriteStream(this.config.path).write(json)
        this.updateManifest(this.config.path, json)
      }
    }

    async download (skipIfSame = false) {
      const url = this.config.url
      if (!url) return
      if (this.downloadPending) return
      this.downloadPending = true
      try {
        const resp = await fetch(url)
        const data = resp.ok ? await resp.json() : undefined
        if (!resp.ok || !data) {
          console.warn('Failed to get ' + url)
          throw new Error(`HTTP ${resp.status}`)
        }

        const json = JSON.stringify(data, null, 2)
        const manifest = this.manifest?.data
        const length = (manifest && manifest[url]?.length) || 0
        const hash = (manifest && manifest[url]?.hash) || 0
        if (skipIfSame && length && json.length && (length === json.length) && (hash === this.hashCode(json))) {
          return
        }

        this.data = data
        this.updateManifest(url, json)
        return json
      }
      finally {
        this.downloadPending = false
      }
    }

    hashCode (string) {
      let hash = 0
      for (let i = 0; i < string.length; i++) {
        const code = string.charCodeAt(i)
        hash = ((hash << 5) - hash) + code
        hash = hash & hash // Convert to 32bit integer
      }
      return hash
    }

    getTable (table) {
      return this.data && this.data[table]
    }

    findTableRaw (table, col, val, ignorecase = false) {
      const arr = this.getTable(table)
      if (ignorecase) {
        val = val.toUpperCase()
        return arr && arr.find(row => (row[col].toUpperCase() === val))
      }
      return arr && arr.find(row => (row[col] === val))
    }

    getTableRawIndex (table, col, val) {
      const arr = this.getTable(table)
      return arr && arr.findIndex(row => (row[col] === val))
    }
  }

  class TasmotaManager {
    constructor (config) {
      RED.nodes.createNode(this, config)

      this.config = config
      this.dbStatus = 'unconfigured'

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
      this.mqttMap = undefined
      this.ev = new events.EventEmitter()
      this.ev.setMaxListeners(0)

      this.lastTasmotaScan = { at: null, results: [] }
      this._scanTimer = null
      this._scheduleRecoveryScan()

      this.on('close', (done) => {
        if (this.rf433DbDirty) this.rf433Db.save(true)
        if (this._scanTimer) clearInterval(this._scanTimer)
        done()
      })

      this.initialize(true)

      if (!fs.existsSync(this.mqttMapPath)) this.downloadAllConfigs()
      else this.loadMqttMap()
    }

    get dbDevices () { return this.devicesDb.ensureData() }
    get network () { return this.networkDb.data }

    async initialize (overwrite = false) {
      // download:
      if (!this.config.dbUri) return
      if (!overwrite && (this.dbStatus === 'configured')) return
      if (this.dbStatus === 'initializing') return
      this._setStatus('initializing')
      try {
        if (this.devicesDb && await this.devicesDb.download(true)) this.devicesDb.save(overwrite)
        if (this.networkDb && await this.networkDb.download(true)) this.networkDb.save(overwrite)
        const groups = (this.devicesDb && this.devicesDb.getTable('groups')) || [{ idx: 0, name: '?' }]
        const group = groups.find(row => (row.name === this.name))
        if (group) {
          this.grp = group.idx
        }
        else {
          this.grp = groups.length
          groups.push({ idx: this.grp, name: this.name })
          this.log(`DevicesDb add group ${this.name} with idx ${this.grp}`)
          this.devicesDb.save(true)
        }
        await this.downloadIcons()

        this._downloadDecodeConfig()

        this._setStatus('configured')
      }
      catch (err) {
        this.dbStatus = 'unconfigured'
        this.error(err.stack || err)
      }
    }

    _setStatus (status) {
      this.dbStatus = status
      // Pass the new status to all listeners
      // ?? this.emit('devdb_status', status)
    }

    async _downloadDecodeConfig () {
      const localPath = this.confdir + '/decode-config.py'

      if (fs.existsSync(localPath)) return
      this.log('download decode-config.py to ' + localPath)
      const url = 'https://raw.githubusercontent.com/tasmota/decode-config/development/decode-config.py'
      try {
        const data = await this.getRequest(url)
        fs.createWriteStream(localPath).write(data)
      }
      catch (err) {
        this.error(`Error on downloading decode-config tool from ${url}. Download the tool manualy to ${this.confdir} (${err.message})`)
      }
    }

    _spawnDecodeConfig (params) {
      return new Promise((resolve, reject) => {
        const pythonProcess = spawn('python', [this.confdir + '/decode-config.py', ...params])
        pythonProcess.stdout.on('data', (data) => this.log(data))
        pythonProcess.stderr.on('data', (data) => this.warn(data))
        pythonProcess.on('error', (err) => {
          reject(new Error(`Failed to run decode-config.py - is python installed and on PATH? (${err.message})`))
        })
        pythonProcess.on('exit', (code, signal) => resolve(code))
      })
    }

    async downloadIcons (all, force) {
      if (!this.devicesDb || !this.config.dbUri) return
      const iconsDir = path.join(this.resDir, 'icons')
      if (fs.existsSync(iconsDir)) {
        if (!force) return
      }
      else {
        fs.mkdirSync(iconsDir, { recursive: true })
      }
      const devices = this.devicesDb.data?.devices
      if (!devices) return this.error('No devices table in DB')
      const hws = this.devicesDb.data?.hardware
      if (!hws) return this.error('No hardware table in DB')

      const urlDir = new URL('../img/', this.config.dbUri).href
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
        catch (err) {
          this.error(err)
        }
      }

      const hwList = (all && hws) || []
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
    backupResources (bakDir) {
      bakDir = path.resolve(path.join(this.resDir, '..', bakDir))
      const date = new Date().toISOString().slice(0, 10)
      const bakPath = path.join(bakDir, `${this.config.name}_${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}`)
      if (!fs.existsSync(bakDir)) fs.mkdirSync(bakDir, { recursive: true })
      try {
        fsx.copySync(this.resDir, bakPath)
      }
      catch (err) { this.error(err) }
    }

    loadMqttMap () {
      this.mqttMap = (fs.existsSync(this.mqttMapPath) && JSONparse(fs.readFileSync(this.mqttMapPath, 'utf8'))) || {}
      let mapDirty = false

      // refresh map by existing configs
      fs.readdirSync(this.confdir).forEach(file => {
        const { ext } = path.parse(file)
        if (ext !== '.json') return
        const filepath = path.join(this.confdir, file)
        const config = JSONparse(fs.readFileSync(filepath, 'utf8'))
        const ipAddress = config?.ip_address
        const mqttTopic = config?.mqtt_topic
        if (mqttTopic && ipAddress && ipAddress[0] && !this.mqttMap[ipAddress[0]]) {
          this.mqttMap[ipAddress[0]] = mqttTopic
          mapDirty = true
        }
      })
      if (mapDirty) fs.createWriteStream(this.mqttMapPath).write(JSON.stringify(this.mqttMap, null, 2))
      return this.mqttMap
    }

    getRf433Codes () {
      return this.rf433Db.data || {}
    }

    saveRf433Codes (onClose) {
      if (onClose) this.rf433DbDirty = true
      else this.rf433Db.save(true)
    }

    onRfReceived (bridge, time, data) {
      this.emit('rf-received', bridge, time, data)
    }

    async downloadConfig (ip, force = false) {
      const mqttTopic = this.mqttMap[ip]
      const filepath = path.join(this.confdir, (mqttTopic || ip) + '.json')

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
      catch (err) {
        this.error(err.stack || err)
      }

      const config = JSONparse(fs.readFileSync(filepath, 'utf8'))
      if (!mqttTopic && config?.mqtt_topic) {
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
        const sorted = Object.keys(this.mqttMap).sort().reduce((acc, key) => ({ ...acc, [key]: this.mqttMap[key] }), {})
        this.mqttMap = sorted
        fs.createWriteStream(this.mqttMapPath).write(JSON.stringify(this.mqttMap, null, 2))
      }
      return config
    }

    async downloadAllConfigs (force = false) {
      if (!this.mqttMap) this.loadMqttMap()

      // TODO iterate all tasmota devices
      const devices = (this.devicesDb && this.devicesDb.getTable('devices')) || []
      for (const device of devices) {
        if (device.fw && device.ip) {
          const mqttTopic = this.mqttMap[device.ip]
          if (!mqttTopic || !fs.existsSync(path.join(this.confdir, mqttTopic + '.json'))) {
            try {
              this.mqttMap[device.ip] = ''
              await this.downloadConfig(device.ip)
            }
            catch (err) {
              this.error(err.stack || err)
            }
          }
        }
      }
    }

    async scanNetwork () {
      if (!this.config.network) return this.error('Network not configured')
      try {
        const parts = this.config.network.split('/')
        const ipBytes = parts[0].split('.')
        if (ipBytes.length !== 4) return this.error('Format error, ip:' + parts[0])

        const ipAdr = parts[0].split('.').reduce((sum, b, i) => sum + (b << 8 * (3 - i)), 0)
        const prefix = ((parts.length > 1) && parseInt(parts[1])) || 24
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
            catch (err) { }
          }
        }
      }
      catch (err) {
        this.error(err)
      }
      this.busy = false
    }

    registerDevice (device) {
      this.devices[device.id] = device
      if (!device.config.ip) return // TODO host
      const dbDevice = this.devicesDb.findTableRaw('devices', 'ip', device.config.ip)
      if (dbDevice) {
        const dirty = false
        // TODO compare and update existing device
        if (dirty) this.devicesDb.save(true)
        return
      }
      // add new DB device
      this._addDbDevice(device.config) // host, ip, mac, name, group, version
    }

    unregisterDevice (device) {
      delete this.devices[device.id]
    }

    // Summary of every tasmota-device node currently registered with this
    // manager, for the editor's "Devices" tab (name/status/ap/ip).
    listRegisteredDevices () {
      return Object.values(this.devices).map((device) => ({
        id: device.id,
        name: device.config?.name || device.config?.device || device.id,
        online: !!device.isOnline,
        ap: device.ap || device.bssid || '',
        ip: device.config?.ip || ''
      }))
    }

    _addDbDevice (config) {
      const db = this.devicesDb?.data || {}
      this.devicesDb.data = db
      db.devices = Array.isArray(db.devices) ? db.devices : []
      db.groups = Array.isArray(db.groups) ? db.groups : []
      const group = config.group && db.groups.find(row => (row.name === config.group))
      db.devices.push({
        fw: config.version || 1,
        grp: group?.idx || this.grp,
        host: config.host,
        ip: config.ip,
        mac: config.mac || '',
        name: config.name
      })
      this.devicesDb.save(true)
    }

    findAP (bssid) {
      const ap = this.devicesDb && this.devicesDb.findTableRaw('devices', 'mac', bssid, true)
      if (ap) return ap
      const db = this.devicesDb?.data || {}
      this.devicesDb.data = db
      db.devices = Array.isArray(db.devices) ? db.devices : []
      db.devices.push({ mac: bssid })
      this.devicesDb.save(true)
    }

    listDevices () {
      const arr = []
      for (const ip in this.mqttMap) {
        if (this.mqttMap[ip]) arr.push({ [this.mqttMap[ip]]: ip })
      }
      return arr
    }

    listDeviceNodes () {
      const arr = []
      for (const id in this.devices) {
        const device = this.devices[id].config
        arr.push({ [device.name || device.host]: id })
      }
      return arr
    }

    listDbDevices (field) {
      const arr = []
      switch (field) {
        case 'ip':
          this.dbDevices.devices.forEach((el) => {
            if (!el.fw || !el.ip) return
            const mapped = this.mqttMap[el.ip]
            arr.push(mapped ? { [mapped]: el.ip } : el.ip)
          })
          return arr
        case 'host':
          this.dbDevices.devices.forEach((el) => {
            if (!el.fw || !el.host || el.host === '?') return
            const mapped = el.ip && this.mqttMap[el.ip]
            arr.push(mapped ? { [mapped]: el.host } : el.host)
          })
          return arr
        default:
          this.dbDevices.devices.forEach((el) => {
            if (el.fw && el.ip && this.mqttMap[el.ip]) arr.push(this.mqttMap[el.ip])
          })
          return arr
      }
    }

    getMqttDevice (topic) {
      for (const id in this.devices) {
        const device = this.devices[id]
        if (device.config.device === topic) return device
      }
    }

    getDbDevices () {
      return this.dbDevices.devices.filter((el) => el.fw)
    }

    async getRequest (url, json, timeout) {
      const controller = timeout ? new AbortController() : undefined
      const timer = timeout ? setTimeout(() => controller.abort(), timeout) : undefined
      try {
        const resp = await fetch(url, { signal: controller?.signal })
        const data = resp.ok ? await (json ? resp.json() : resp.text()) : undefined
        if (!resp.ok || !data) {
          console.warn('Failed to get ' + url)
          throw new Error(`HTTP ${resp.status}`)
        }
        return data
      }
      finally {
        if (timer) clearTimeout(timer)
      }
    }

    mqttCommand (device, command, payload) {
      const tasmota = this.getMqttDevice(device)
      tasmota && tasmota.mqttCommand(command, payload)
    }

    async httpCommand (ip, cmnd, val, timeout) {
      const command = val ? `${cmnd} ${val}` : cmnd
      const url = `http://${ip}/cm?cmnd=${encodeURIComponent(command)}`
      return await this.getRequest(url, true, timeout)
    }

    // Locates a device's cached decode-config.py dump without depending on
    // this.mqttMap (the legacy ip->mqtt_topic lookup - MQTT is optional in
    // Tasmota, and that mapping is stale/historical baggage we're moving
    // away from for new code, not something to build further on). Prefers
    // the MAC-derived default topic name (Tasmota's own tasmota_%06X
    // hostname/topic, from the last 3 MAC bytes - the same identifier
    // NetHelper.findTasmotaAPs() extracts from a fallback-AP SSID), since
    // that's stable and doesn't depend on the (possibly stale) device DB;
    // the DB's host/ip are only a fallback, for a manually renamed topic.
    _findCachedConfigFile (row, mac) {
      const macSuffix = mac && mac.replace(/[^0-9A-Fa-f]/g, '').slice(-6)
      const candidates = []
      if (macSuffix) candidates.push(`tasmota_${macSuffix.toUpperCase()}`, `tasmota_${macSuffix.toLowerCase()}`)
      if (row?.host) candidates.push(row.host)
      if (row?.ip) candidates.push(row.ip)
      for (const base of candidates) {
        const filepath = path.join(this.confdir, base + '.json')
        if (fs.existsSync(filepath)) return filepath
      }
      return undefined
    }

    // Build a manual recovery command/URL for a device that fell back to its
    // Tasmota setup AP (tasmota_XXXXXX-YYYY), to be opened while joined to
    // that AP. Field priority is overrides > the device's own cached
    // decode-config.py dump > the manager-level ssid/password fallback
    // (WiFi credentials only - there's no manager-level fallback for
    // ip/gateway/mask, only cache or an explicit override) - the DB is the
    // least trustworthy source (can go stale), the cache is read straight
    // from the device, so it always wins when both exist. `row` may be
    // missing entirely for a brand-new device (never in the device DB, no
    // cached config) - that's still a valid case as long as overrides/
    // manager-fallback supply enough to build a command; `found` means "a
    // command could be built", not "this MAC was already known".
    buildRecoveryCommand (mac, overrides = {}) {
      const row = this.devicesDb.findTableRaw('devices', 'mac', mac, true)

      const filepath = this._findCachedConfigFile(row, mac)
      const config = filepath && JSONparse(fs.readFileSync(filepath, 'utf8'))

      const ssid = overrides.ssid || config?.sta_ssid?.[0] || this.config.ssid
      const password = overrides.password || config?.sta_pwd?.[0] || this.config.password
      if (!ssid || !password) return { found: false, mac }
      const usedFallbackCredentials = !((overrides.ssid || config?.sta_ssid?.[0]) && (overrides.password || config?.sta_pwd?.[0]))

      // '0.0.0.0' is Tasmota's placeholder for "not set" in every IpAddress
      // slot, not just IpAddress1 - filter it out of every field uniformly.
      const isRealIp = (v) => !!(v && v !== '0.0.0.0')
      const cachedIp = config?.ip_address || []
      const ip = overrides.ip || cachedIp[0]
      const gateway = overrides.gateway || cachedIp[1]
      const mask = overrides.mask || cachedIp[2]
      const dns1 = cachedIp[3]
      const dns2 = cachedIp[4]
      const hasStaticIp = isRealIp(ip)

      const parts = [`SSId1 ${ssid}`, `Password1 ${password}`]
      if (hasStaticIp) parts.push(`IpAddress1 ${ip}`)
      if (isRealIp(gateway)) parts.push(`IpAddress2 ${gateway}`)
      if (isRealIp(mask)) parts.push(`IpAddress3 ${mask}`)
      if (isRealIp(dns1)) parts.push(`IpAddress4 ${dns1}`)
      if (isRealIp(dns2)) parts.push(`IpAddress5 ${dns2}`)
      parts.push('Restart 1')
      const command = 'Backlog ' + parts.join(';')
      const url = `http://192.168.4.1/cm?cmnd=${encodeURIComponent(command)}`

      // ip/host: prefer the cache (read straight from the device) over the
      // DB row, which can go stale - only fall back to the DB when neither
      // an override nor the cache had a value.
      return {
        found: true,
        alreadyKnown: !!row,
        mac,
        ip: ip || row?.ip,
        host: config?.hostname || row?.host,
        command,
        url,
        usedFallbackCredentials,
        hasStaticIp
      }
    }

    // Scans for currently visible Tasmota fallback APs (tasmota_XXXXXX-YYYY).
    // Shares the wifiBusy guard with recoveryDevice() - both touch the same
    // WiFi radio and must not run concurrently.
    async findTasmotaAPs (iface) {
      if (this.wifiBusy) throw new Error('findTasmotaAPs: a WiFi scan/recovery is already in progress')
      this.wifiBusy = true
      try {
        const networks = await NetHelper.scanWifiNetworks(iface || this.config.wifiInterface || 'wlan0')
        return NetHelper.findTasmotaAPs(networks)
      }
      finally {
        this.wifiBusy = false
      }
    }

    // Flags each found AP as belonging to an already-known device (matched
    // by the last 3 MAC bytes encoded in the SSID) - lets the editor warn
    // before recovering an AP that might not even be one of your own
    // devices, without blocking recovery of a genuinely new/unknown one.
    _enrichTasmotaAPs (aps) {
      const devices = this.devicesDb?.data?.devices || []
      // Strip separators before comparing - MACs in the DB are normally
      // colon-separated ("AA:BB:CC:DD:EE:FF"), but ap.macSuffix (from the
      // SSID) is 6 bare hex chars with no separators.
      const hexOnly = (mac) => mac.toUpperCase().replace(/[^0-9A-F]/g, '')
      return aps.map((ap) => {
        const match = devices.find((d) => d.mac && hexOnly(d.mac).endsWith(ap.macSuffix))
        return { ...ap, known: !!match, deviceName: match?.name, deviceIp: match?.ip }
      })
    }

    // findTasmotaAPs() + known/unknown enrichment, cached on this.lastTasmotaScan
    // for the editor's Assistants tab (GET .../tasmota-aps) and the scheduled
    // re-scan below - both share this single cache.
    async scanTasmotaAPs (iface) {
      const results = this._enrichTasmotaAPs(await this.findTasmotaAPs(iface))
      this.lastTasmotaScan = { at: new Date().toISOString(), results }
      return this.lastTasmotaScan
    }

    // (Re)schedules the periodic Tasmota-AP scan per recoveryScanRepeatHours
    // (0/unset = disabled). findTasmotaAPs() already no-ops via wifiBusy if a
    // manual scan/recovery is in progress, so a skipped tick just waits for
    // the next interval.
    _scheduleRecoveryScan () {
      if (this._scanTimer) {
        clearInterval(this._scanTimer)
        this._scanTimer = null
      }
      const hours = Number(this.config.recoveryScanRepeatHours)
      if (!hours || hours <= 0) return
      const ms = Math.min(hours * 3600000, 2147483647) // setInterval's 32-bit ms cap (~24.8 days)
      this._scanTimer = setInterval(() => {
        this.scanTasmotaAPs().catch((err) => this.warn(`Scheduled Tasmota AP scan failed: ${err.message}`))
      }, ms)
    }

    // Merges override values into a *copy* of a cached decode-config.py dump
    // (never mutates the original, which is still the on-disk cache) - same
    // override fields/priority as buildRecoveryCommand(), just applied to
    // the full config object instead of a handful of Backlog command parts.
    // No DNS override param exists (same as buildRecoveryCommand) - DNS
    // stays whatever the cache had.
    _applyConfigOverrides (config, overrides) {
      const merged = JSON.parse(JSON.stringify(config))
      if (overrides.ssid) merged.sta_ssid = [overrides.ssid, merged.sta_ssid?.[1] || '']
      if (overrides.password) merged.sta_pwd = [overrides.password, merged.sta_pwd?.[1] || '']
      if (overrides.ip || overrides.gateway || overrides.mask) {
        const ip = Array.isArray(merged.ip_address) ? merged.ip_address.slice() : []
        if (overrides.ip) ip[0] = overrides.ip
        if (overrides.gateway) ip[1] = overrides.gateway
        if (overrides.mask) ip[2] = overrides.mask
        merged.ip_address = ip
      }
      return merged
    }

    // Pushes a full config (typically a cached dump, optionally with
    // overrides merged in via _applyConfigOverrides) back to a device via
    // decode-config.py's own restore support - not just the handful of
    // fields buildRecoveryCommand()'s Backlog command covers, but the whole
    // device config (module/GPIO, relay names, rules, ...). The temp file is
    // always removed afterward, success or failure.
    async restoreFullConfig (ip, config) {
      const tmpPath = path.join(this.confdir, `.restore-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`)
      fs.writeFileSync(tmpPath, JSON.stringify(config))
      try {
        const err = await this._spawnDecodeConfig(['-d', ip, '--restore-file', tmpPath])
        if (err) throw new Error(`decode-config.py restore-file failed (exit code ${err})`)
      }
      finally {
        fs.rmSync(tmpPath, { force: true })
      }
    }

    // Automates the manual buildRecoveryCommand() workflow: hop this host's
    // WiFi onto the device's fallback AP, push its known-good config, and
    // always return the WiFi to exactly the state it was in before - even on
    // failure. A watchdog (NetHelper.scheduleConnectionActivation) is armed
    // *before* the hop as a dead-man's switch independent of this process,
    // in addition to (not instead of) the explicit restore in `finally`.
    async recoveryDevice (apSsid, overrides = {}) {
      if (!apSsid) throw new Error('recoveryDevice: Tasmota AP SSID is required')
      if (this.wifiBusy) throw new Error('recoveryDevice: a WiFi scan/recovery is already in progress')
      this.wifiBusy = true
      const iface = this.config.wifiInterface || 'wlan0'
      const manager = await NetHelper.detectNetworkManager()
      const original = await NetHelper.getCurrentConnection(iface, manager)
      const watchdogSeconds = this.config.recoveryWatchdogTimeoutSeconds || 180
      // null => schedule a disconnect: the correct restore target when
      // nothing was connected before the hop, never an invented connection.
      const watchdog = await NetHelper.scheduleConnectionActivation(
        original.connected ? original.connectionId : null, watchdogSeconds, { iface, manager }
      )
      let joinHandle
      try {
        joinHandle = await NetHelper.connectToNetwork(apSsid, { iface, manager })
        await NetHelper.waitForConnection(apSsid, { iface, manager })

        const status = await this.httpCommand('192.168.4.1', 'Status', '5', 5000)
        const mac = status?.StatusNET?.Mac
        if (!mac) throw new Error('recoveryDevice: could not read MAC address from device (Status 5)')

        // A cached decode-config.py dump lets us restore the device's whole
        // configuration (module/GPIO, relay names, rules, ...), not just the
        // handful of fields buildRecoveryCommand()'s Backlog command covers
        // - which is only enough if the device merely forgot its WiFi
        // credentials, not if it lost its configuration outright (the
        // scenario this feature exists for). No deliberate fallback from a
        // failed restore back to the Backlog push - a failed restore should
        // surface as an error, not silently downgrade to a partial fix.
        const row = this.devicesDb.findTableRaw('devices', 'mac', mac, true)
        const cachedConfigPath = this._findCachedConfigFile(row, mac)

        const recovery = this.buildRecoveryCommand(mac, overrides)
        if (!recovery.found) throw new Error(`recoveryDevice: no known configuration found for MAC ${mac}`)
        // A brand-new device (never in the device DB) stays invisible to
        // getDbDevices()/the Devices tab forever unless registered now.
        if (!recovery.alreadyKnown) this._addDbDevice({ mac, ip: overrides.ip })

        if (cachedConfigPath) {
          const cachedConfig = JSONparse(fs.readFileSync(cachedConfigPath, 'utf8'))
          await this.restoreFullConfig('192.168.4.1', this._applyConfigOverrides(cachedConfig, overrides))
          try { await this.httpCommand('192.168.4.1', 'Restart', '1', 5000) }
          catch (err) { this.log(`recoveryDevice: explicit restart after restore not reachable (device likely already rebooted): ${err.message}`) }
        }
        else {
          await this.getRequest(recovery.url, true, 10000) // pushes config; Backlog already ends in Restart 1
        }

        return { mac, mode: cachedConfigPath ? 'full-restore' : 'backlog', ...recovery }
      }
      finally {
        try {
          if (original.connected) await NetHelper.activateConnection(original.connectionId, { iface, manager })
          else await NetHelper.disconnect({ iface, manager })
        }
        catch (err) {
          this.error(`recoveryDevice: failed to restore original connection immediately - the watchdog will still do it in ~${watchdogSeconds}s: ${err.message}`)
        }
        if (joinHandle) {
          try { await NetHelper.forgetNetwork(joinHandle) }
          catch (err) { this.warn(`recoveryDevice: failed to remove temporary network profile for "${apSsid}": ${err.message}`) }
        }
        try { await NetHelper.cancelScheduledActivation(watchdog.unitName) }
        catch (err) { this.warn(`recoveryDevice: failed to cancel watchdog unit ${watchdog.unitName} (harmless - it will just fire once more): ${err.message}`) }
        this.wifiBusy = false
      }
    }
    // end commands
  }

  RED.nodes.registerType('tasmota-manager', TasmotaManager)

  RED.httpAdmin.get('/tasmota-manager/:id/devices', RED.auth.needsPermission('tasmota-manager.read'), function (req, res) {
    const node = RED.nodes.getNode(req.params.id)
    if (!node || node.type !== 'tasmota-manager') {
      res.sendStatus(404)
      return
    }
    res.json(node.listRegisteredDevices())
  })

  RED.httpAdmin.get('/tasmota-manager/:id/tasmota-aps', RED.auth.needsPermission('tasmota-manager.read'), function (req, res) {
    const node = RED.nodes.getNode(req.params.id)
    if (!node || node.type !== 'tasmota-manager') {
      res.sendStatus(404)
      return
    }
    res.json(node.lastTasmotaScan)
  })

  RED.httpAdmin.post('/tasmota-manager/:id/tasmota-aps/scan', RED.auth.needsPermission('tasmota-manager.write'), async function (req, res) {
    const node = RED.nodes.getNode(req.params.id)
    if (!node || node.type !== 'tasmota-manager') {
      res.sendStatus(404)
      return
    }
    try {
      res.json(await node.scanTasmotaAPs(req.body?.iface))
    }
    catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  RED.httpAdmin.post('/tasmota-manager/:id/recovery-device', RED.auth.needsPermission('tasmota-manager.write'), async function (req, res) {
    const node = RED.nodes.getNode(req.params.id)
    if (!node || node.type !== 'tasmota-manager') {
      res.sendStatus(404)
      return
    }
    if (!req.body?.ssid) {
      res.status(400).json({ error: 'ssid is required' })
      return
    }
    try {
      res.json(await node.recoveryDevice(req.body.ssid, req.body.override || {}))
    }
    catch (err) {
      res.status(500).json({ error: err.message })
    }
  })
}
