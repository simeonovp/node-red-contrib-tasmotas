const { emit } = require('process')
const path = require('path')
const fs = require('fs')
const request = require('request')
const spawn = require("child_process").spawn;

const socketio = require('socket.io');
const events = require('events');

module.exports = function (RED) {
  'use strict'

  const CONFIG_DEFAULTS = {
    // basic
    manager: '', // optional
    broker: '', // mandatory
    device: '', // mandatory
    name: '',
    ip: '',
    host: '',
    mac: '',
    version: 1,
    module: 0,
    relais: 0,
    friendlynames: '',
    // advanced
    fullTopic: 'tasmota/%topic%/%prefix%', // '%prefix%/%topic%/',
    cmndPrefix: 'cmnd',
    statPrefix: 'stat',
    telePrefix: 'tele',
    qos: 1,
    retain: false
  }

  // values for the tasmota POWER command
  const onValue = 'ON'
  const offValue = 'OFF'
  const toggleValue = 'TOGGLE'

  const ShutterPrefix = 'Shutter'
  
  // const DBG = console.log

  function extractChannelNum (str) {
    const numberRegexp = /\d+$/
    return Number(str.match(numberRegexp) || 1)
  }

  function parseSeconds(val) {
    return (val > 110) ? (val - 100) : parseInt(val / 10);
  }

  class Power {
    constructor (device, idx) {
      this.device = device
      this.idx = idx
      this.lastValue = false //cache
      this.lastChangeTime = 0 //new Date()
      this.timeout //PulseTime
      this.timer = 0
      this.lastTime = 0
      this.debTimer
      this.supportPulseTime = false

      device.MQTTSubscribe(device, 'stat', 'POWER' + this.channel, (topic, mqttPayloadBuf) => this.onPower(topic, mqttPayloadBuf))
      if (this.channel === 1) device.MQTTSubscribe(device, 'stat', 'POWER', (topic, mqttPayloadBuf) => this.onPower(topic, mqttPayloadBuf))

      device.MQTTSubscribe(device, 'cmnd', 'PulseTime' + this.channel, (topic, mqttPayloadBuf) => this.onPulseTime(topic, mqttPayloadBuf))
      if (this.channel === 1) device.MQTTSubscribe(device, 'cmnd', 'PulseTime', (topic, mqttPayloadBuf) => this.onPulseTime(topic, mqttPayloadBuf))

      device.MQTTSubscribe(device, 'stat', 'RESULT', (topic, mqttPayloadBuf) => {
        const mqttPayload = mqttPayloadBuf.toString()
        const result = JSON.parse(mqttPayload)
        if (!result) return
        for (const key in result) {
          if (!key.startsWith('PulseTime')) return
          if (extractChannelNum(key) !== this.channel) return
          const PulseTime = result[key]
          if (PulseTime) {
            if (PulseTime.Set !== null) {
              const sec = parseSeconds(PulseTime.Set)
              if (this.timeout !== sec) {
                this.timeout = sec
                this.send({topic: 'timeout', timeout: sec})
              }
            }
            if (this.device.polling) {
              if (PulseTime.Remaining !== null) {
                const sec = parseSeconds(PulseTime.Remaining)
                if(sec) this.send({topic: 'countdown', countdown: sec})
                else if(this.timer) this.stopTimer()
              }
            }
          }
        }
      })

      if (device.isOnline) {
        this.device.MQTTPublish('cmnd', 'POWER' +  this.channel)
        startTimer()
      }
    }

    get channel() { return this.idx + 1 }

    onClose() {
      if (this.timer) clearInterval(idx)
    }

    onPower(topic, mqttPayloadBuf) {
      const mqttPayload = mqttPayloadBuf.toString()
      if (mqttPayload === onValue) this.lastValue = true
      else if (mqttPayload === offValue) this.lastValue = false
      else return

      if (this.supportPulseTime) {
        if (!this.lastValue) this.stopTimer()
        else if (!this.timer) this.startTimer()
      }

      this.lastChangeTime = new Date()
      this.send({ topic: 'switch' })
    }

    onPulseTime(topic, mqttPayloadBuf) {
      const mqttPayload = mqttPayloadBuf.toString()
      const sec = parseSeconds(parseInt(mqttPayload))
      if (!mqttPayload) return //epmty  payload
      if (this.timeout !== sec) {
        this.timeout = sec
      }
      this.send({ topic: 'timeout', timeout: sec })
    }

    send(msg) {
      this.device.emit('tasmota-switch' + (this.idx || ''), 'send', msg)
    }
    
    setPower(val) {
      if (this.debounce) {
        try {
        const timestamp = Date.now()
        const diff = (timestamp - this.lastTime)
        if (diff > this.debounce) {
          this.lastTime = timestamp
          this.device.MQTTPublish('cmnd', 'POWER' +  this.channel, val && onValue || offValue)
        }
        else if (!this.debTimer) {
          this.debTimer = setTimeout(()=>{ 
            clearTimeout[this.debTimer]
            this.debTimer = null
            this.lastTime = Date.now()
            this.device.MQTTPublish('cmnd', 'POWER' +  this.channel, val && onValue || offValue)
          }, this.debounce - diff)
        }
        } 
        catch(err) {
          this.warn('Debounce exeption' + err)
        }
      }
      else this.device.MQTTPublish('cmnd', 'POWER' +  this.channel, val && onValue || offValue)
    }

    requestTimer(timeout) {
      let value
      if (timeout) {
        const sec = parseInt(timeout)
        value = ((sec > 11) ? (sec + 100) : (sec * 10)).toString()
      }

      this.device.MQTTPublish('cmnd', 'PulseTime' +  this.channel, value)
    }

    startTimer() {
      if (!this.supportPulseTime || !this.device.polling || (this.timeout === 0)) return;
      if (this.timer) this.clearInterval(this.timer)
      this.timer = setInterval(()=>{ this.requestTimer() }, this.device.polling * 1000);
      this.requestTimer()
    }

    stopTimer() {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = 0
      }
      this.send({topic: 'countdown', countdown: 0})
    }
  }

  class Shutter {
    constructor (device, idx) {
      this.device = device
      this.idx = idx
      this.data = {
        Position: null,
        Direction: 0,
        Target: 0
      }

      const idx1 = idx * 2
      this.switch1 = device.swiches[idx1] || new Power(device, idx1)
      device.swiches[idx1] = this.switch1
      const idx2 = idx1 + 1
      this.switch1 = device.swiches[idx2] || new Power(device, idx2)
      device.swiches[idx2] = this.switch1

      //tasmota/t1_02/tele/SENSOR = {"Time":"2022-12-26T09:07:46","Shutter1":{"Position":100,"Direction":0,"Target":100}}
      device.MQTTSubscribe(device, 'tele', 'SENSOR', this.onMqttState.bind(this))
      //tasmota/t1_02/stat/RESULT = {"Shutter1":{"Position":98,"Direction":-1,"Target":-151}}
      device.MQTTSubscribe(device, 'stat', 'RESULT', this.onMqttState.bind(this))
      if (device.isOnline) this.requestPosition()
    }

    get channel() { return this.idx + 1 }

    send(msg) {
      this.device.emit('tasmota-shutter' + (this.idx || ''), 'send', msg)
    }

    command(cmd, val) {
      this.device.MQTTPublish('cmnd', ShutterPrefix + cmd + this.channel, val)
    }

    requestPosition() {
      if (isNaN(this.data.Position)) {
        this.data.Position = 0
        this.command('ShutterPosition')
      }
    }

    onMqttState(topic, mqttPayloadBuf) {
      const mqttPayload = mqttPayloadBuf.toString()
      const payloadData = JSON.parse(mqttPayload)

      const position = payloadData['ShutterPosition' + this.channel]
      if (!isNaN(position)) {
        if (this.data.Position !== position) {
          this.data.Position = position
          this.send({ topic: 'position' })
        }
      }
      else {
        const data = payloadData['Shutter' + this.channel]
        if (data && (this.data.Position !== data.Position)) {
          Object.assign(this.data, data)
          this.send({ topic: 'position' })
        }
      }
    }
  }

  //SonoffSC: {"Temperature":24,"Humidity":43,"DewPoint":10.6,"Light":10,"Noise":40,"AirQuality":90}

  class TasmotaDevice {
    constructor (config) {
      RED.nodes.createNode(this, config)

      // Internals
      this.brokerNode = null
      this.users = 0 // count of users registered for broker notifications
      this.subGroups = null
      this.cmndSubscriptions = null
      this.statSubscriptions = null
      this.teleSubscriptions = null
      this.polling = 1
      this.deviceConfig = null

      // LastWillTopic status of the device
      this.isOnline = false

      // Merge user and default config
      const defaults = CONFIG_DEFAULTS
      this.config = {}

      for (const key in defaults) {
        if (config[key] !== undefined && config[key] !== '') {
          if ((typeof defaults[key] == 'number') && (typeof config[key] === 'string')) {
            this.config[key] = parseInt(config[key])
          }
          else this.config[key] = config[key]
        } else {
          this.config[key] = defaults[key]
        }
      }
      this.config.name = this.config.name || this.config.device

      this.cache = {}
      //switches
      this.swichUsers
      this.swiches = [] //type Power
      this.shutters = [] //type Shutter
      this.sendDevice = config.sendDevice || false
      this.debounce = 0

      // Get and check the broker node (could be wrong if updated from old release)
      this.manager = this.config.manager && RED.nodes.getNode(this.config.manager)
      if (this.manager) this.manager.registerDevice(this)

      const brokerNode = RED.nodes.getNode(this.config.broker)
      if (!brokerNode || brokerNode.type !== 'tasmota-mqtt-broker') {
        this.warn('Broker configuration is wrong or missing, please review the node settings')
        return
      }
      // Register ourself in the broker node
      this.brokerNode = brokerNode
     
      //this._regsterAtBroker()

      // Deregister from BrokerNode when this node is deleted or restarted
      this.on('close', (done) => {
        for (const item in this.swiches) item.onClose()
        if (this.users) this._deregsterAtBroker(this)
        done()
      })
    }

    async downloadConfig(force = false) {
      //.node-red\projects\node-red-contrib-tasmota\resources\configs
      if (!this.manager || !this.config.ip) return
      this.deviceConfig = await this.manager.downloadConfig(this.config.ip, force)
      if (!this.deviceConfig) return
      if (this.deviceConfig.mqtt_host !== this.brokerNode?.config.broker) {
        this.warn(`Force download device config due to different MQTT broker (${this.deviceConfig.mqtt_host} != ${this.brokerNode?.config.broker})`)
        this.deviceConfig = await this.manager.downloadConfig(this.config.ip, true)
        if (!this.deviceConfig) return
      }

      this.MQTTPublish('cmnd', 'STATUS', '11')
    }

    status0() {
      //this.MQTTPublish('cmnd', 'STATUS', '0')
      // 14:24:20 MQT: tasmota/pow_09/stat/STATUS = {"Status":{"Module":43,"FriendlyName":["Klima Office"],"Topic":"pow_09","ButtonTopic":"0","Power":1,"PowerOnState":3,"LedState":1,"LedMask":"FFFF","SaveData":1,"SaveState":1,"SwitchTopic":"0","SwitchMode":[0,0,0,0,0,0,0,0],"ButtonRetain":0,"SwitchRetain":0,"SensorRetain":0,"PowerRetain":0}}
      // 14:24:20 MQT: tasmota/pow_09/stat/STATUS1 = {"StatusPRM":{"Baudrate":4800,"SerialConfig":"8E1","GroupTopic":"tasmotas","OtaUrl":"http://thehackbox.org/tasmota/release/tasmota.bin","RestartReason":"Software/System restart","Uptime":"0T01:04:39","StartupUTC":"2022-12-30T12:19:41","Sleep":50,"CfgHolder":4617,"BootCount":60,"BCResetTime":"2020-04-25T06:22:31","SaveCount":1070,"SaveAddress":"F6000"}}
      // 14:24:20 MQT: tasmota/pow_09/stat/STATUS2 = {"StatusFWR":{"Version":"8.2.0(tasmota)","BuildDateTime":"2020-03-20T14:45:23","Boot":31,"Core":"STAGE","SDK":"2.2.2-dev(38a443e)","Hardware":"ESP8266EX","CR":"358/699"}}
      // 14:24:20 MQT: tasmota/pow_09/stat/STATUS3 = {"StatusLOG":{"SerialLog":0,"WebLog":2,"MqttLog":0,"SysLog":0,"LogHost":"","LogPort":514,"SSId":["SiHaRu",""],"TelePeriod":300,"Resolution":"558180C0","SetOption":["00008009","2805C8000100068000005A00000000000000","000000C0","00000000"]}}
      // 14:24:20 MQT: tasmota/pow_09/stat/STATUS4 = {"StatusMEM":{"ProgramSize":577,"Free":424,"Heap":25,"ProgramFlashSize":1024,"FlashSize":4096,"FlashChipId":"1640EF","FlashMode":3,"Features":["00000809","8FDAE397","043683A0","000000CD","010013C0","C000F981","00000004"],"Drivers":"1,2,3,4,5,6,7,8,9,10,12,16,18,19,20,21,22,24,26,27,29,30,35,37","Sensors":"1,2,3,4,5,6"}}
      // 14:24:20 MQT: tasmota/pow_09/stat/STATUS5 = {"StatusNET":{"Hostname":"pow-09","IPAddress":"192.168.13.79","Gateway":"192.168.13.222","Subnetmask":"255.255.255.0","DNSServer":"192.168.13.222","Mac":"BC:DD:C2:8D:FE:E8","Webserver":2,"WifiConfig":4,"WifiPower":17.0}}
      // 14:24:20 MQT: tasmota/pow_09/stat/STATUS6 = {"StatusMQT":{"MqttHost":"192.168.192.225","MqttPort":1883,"MqttClientMask":"Pow_09","MqttClient":"Pow_09","MqttUser":"DVES_USER","MqttCount":1,"MAX_PACKET_SIZE":1200,"KEEPALIVE":30}}
      // 14:24:20 MQT: tasmota/pow_09/stat/STATUS7 = {"StatusTIM":{"UTC":"2022-12-30T13:24:20","Local":"2022-12-30T14:24:20","StartDST":"2022-03-27T02:00:00","EndDST":"2022-10-30T03:00:00","Timezone":"+01:00","Sunrise":"08:43","Sunset":"17:01"}}
      // 14:24:20 MQT: tasmota/pow_09/stat/STATUS9 = {"StatusPTH":{"PowerDelta":0,"PowerLow":0,"PowerHigh":0,"VoltageLow":0,"VoltageHigh":0,"CurrentLow":0,"CurrentHigh":0}}
      // 14:24:20 MQT: tasmota/pow_09/stat/STATUS10 = {"StatusSNS":{"Time":"2022-12-30T14:24:20","ENERGY":{"TotalStartTime":"2020-04-25T06:22:31","Total":263.033,"Yesterday":0.091,"Today":0.166,"Power":4,"ApparentPower":48,"ReactivePower":47,"Factor":0.08,"Voltage":235,"Current":0.202}}}
      // 14:24:20 MQT: tasmota/pow_09/stat/STATUS11 = {"StatusSTS":{"Time":"2022-12-30T14:24:20","Uptime":"0T01:04:39","UptimeSec":3879,"Heap":25,"SleepMode":"Dynamic","Sleep":50,"LoadAvg":19,"MqttCount":1,"POWER":"ON","Wifi":{"AP":1,"SSId":"SiHaRu","BSSId":"50:D4:F7:50:38:24","Channel":6,"RSSI":66,"Signal":-67,"LinkCount":1,"Downtime":"0T00:00:07"}}}
      const STATUS = {"Status":{"Module":43,"FriendlyName":["Klima Office"],"Topic":"pow_09","ButtonTopic":"0","Power":1,"PowerOnState":3,"LedState":1,"LedMask":"FFFF","SaveData":1,"SaveState":1,"SwitchTopic":"0","SwitchMode":[0,0,0,0,0,0,0,0],"ButtonRetain":0,"SwitchRetain":0,"SensorRetain":0,"PowerRetain":0}}
      const STATUS1 = {"StatusPRM":{"Baudrate":4800,"SerialConfig":"8E1","GroupTopic":"tasmotas","OtaUrl":"http://thehackbox.org/tasmota/release/tasmota.bin","RestartReason":"Software/System restart","Uptime":"0T01:04:39","StartupUTC":"2022-12-30T12:19:41","Sleep":50,"CfgHolder":4617,"BootCount":60,"BCResetTime":"2020-04-25T06:22:31","SaveCount":1070,"SaveAddress":"F6000"}}
      const STATUS2 = {"StatusFWR":{"Version":"8.2.0(tasmota)","BuildDateTime":"2020-03-20T14:45:23","Boot":31,"Core":"STAGE","SDK":"2.2.2-dev(38a443e)","Hardware":"ESP8266EX","CR":"358/699"}}
      const STATUS3 = {"StatusLOG":{"SerialLog":0,"WebLog":2,"MqttLog":0,"SysLog":0,"LogHost":"","LogPort":514,"SSId":["SiHaRu",""],"TelePeriod":300,"Resolution":"558180C0","SetOption":["00008009","2805C8000100068000005A00000000000000","000000C0","00000000"]}}
      const STATUS4 = {"StatusMEM":{"ProgramSize":577,"Free":424,"Heap":25,"ProgramFlashSize":1024,"FlashSize":4096,"FlashChipId":"1640EF","FlashMode":3,"Features":["00000809","8FDAE397","043683A0","000000CD","010013C0","C000F981","00000004"],"Drivers":"1,2,3,4,5,6,7,8,9,10,12,16,18,19,20,21,22,24,26,27,29,30,35,37","Sensors":"1,2,3,4,5,6"}}
      const STATUS5 = {"StatusNET":{"Hostname":"pow-09","IPAddress":"192.168.13.79","Gateway":"192.168.13.222","Subnetmask":"255.255.255.0","DNSServer":"192.168.13.222","Mac":"BC:DD:C2:8D:FE:E8","Webserver":2,"WifiConfig":4,"WifiPower":17.0}}
      const STATUS6 = {"StatusMQT":{"MqttHost":"192.168.192.225","MqttPort":1883,"MqttClientMask":"Pow_09","MqttClient":"Pow_09","MqttUser":"DVES_USER","MqttCount":1,"MAX_PACKET_SIZE":1200,"KEEPALIVE":30}}
      const STATUS7 = {"StatusTIM":{"UTC":"2022-12-30T13:24:20","Local":"2022-12-30T14:24:20","StartDST":"2022-03-27T02:00:00","EndDST":"2022-10-30T03:00:00","Timezone":"+01:00","Sunrise":"08:43","Sunset":"17:01"}}
      const STATUS9 = {"StatusPTH":{"PowerDelta":0,"PowerLow":0,"PowerHigh":0,"VoltageLow":0,"VoltageHigh":0,"CurrentLow":0,"CurrentHigh":0}}
      const STATUS10 = {"StatusSNS":{"Time":"2022-12-30T14:24:20","ENERGY":{"TotalStartTime":"2020-04-25T06:22:31","Total":263.033,"Yesterday":0.091,"Today":0.166,"Power":4,"ApparentPower":48,"ReactivePower":47,"Factor":0.08,"Voltage":235,"Current":0.202}}}
      const STATUS11 = {"StatusSTS":{"Time":"2022-12-30T14:24:20","Uptime":"0T01:04:39","UptimeSec":3879,"Heap":25,"SleepMode":"Dynamic","Sleep":50,"LoadAvg":19,"MqttCount":1,"POWER":"ON","Wifi":{"AP":1,"SSId":"SiHaRu","BSSId":"50:D4:F7:50:38:24","Channel":6,"RSSI":66,"Signal":-67,"LinkCount":1,"Downtime":"0T00:00:07"}}}
    }

    _onMqttStatus(command, payload) {
      switch (command) {
        case 'STATUS': {
          const data = payload && JSON.parse(payload)
          if (data?.Status?.Topic !== this.config.device) this.warn('MQTT reports different topic "${data?.Status?.Topic}", expected "${this.config.device}"')
          break
        }
        case 'STATUS5': {
          const data = payload && JSON.parse(payload)
          this.config.ip = data?.StatusNET?.IPAddress || this.config.ip
          if (this.config.ip) this.downloadConfig()
          break
        }
        case 'STATUS11': {
          if (this.manager) {
            const data = payload && JSON.parse(payload)
            const bssid = data?.StatusSTS?.Wifi?.BSSId // "50:D4:F7:50:38:24"
            if (bssid && (bssid !== this.bssid)) {
              this.bssid = bssid
              const ap = this.manager.findAP(bssid)?.host
              // RED.nodes.eachNode(n => { if ((n.type === 'tasmota-ap') && (n.mac.toUpperCase() === bssid)) ap = n.name; });
              if (ap && (ap !== this.ap)) {
                this.ap = ap
                this.emit('mqtt', 'DeviceOnline')
              }
            }
          }
          break
        }
      }
    }

    _regsterAtBroker() {
      this.brokerNode.register(this)
      this.isOnline = false

      // Subscribe to device availability changes  tele/<device>/LWT
      this.MQTTSubscribe(this, 'tele', 'LWT', (topic, payload) => {
        this.isOnline = (payload.toString().startsWith('Online'))
        if (this.isOnline) {
          this.onDeviceOnline()
        } else {
          this.onDeviceOffline()
        }
      })
    }

    _deregsterAtBroker() {
      this.brokerNode.deregister(this)
      this.isOnline = false
    }

    /* Register a new TasmotaNode */
    register (tasmotaNode) {
      if (!this.cache[tasmotaNode.type]) this.cache[tasmotaNode.type] = {}

      //increment users
      if (!this.users) this._regsterAtBroker()
      this.users++

      if (tasmotaNode.type === 'tasmota-switch') {
        const idx = tasmotaNode.config.idx || 0
        // create power object on demand
        this.swiches[idx] = this.swiches[idx] || new Power(this, idx)
      }
      if (tasmotaNode.type === 'tasmota-shutter') {
        const idx = tasmotaNode.config.idx || 0
        // create shutter object on demand
        this.shutters[idx] = this.shutters[idx] || new Shutter(this, idx)
      }

      //set cached LWT
      //-- if (this.isOnline) tasmotaNode.onDeviceOnline()
    }

    /* DeRegister a previously registered TasmotaNode */
    deregister (tasmotaNode) {
      this.users--
      if (!this.users) this._deregsterAtBroker()
    }

    // Begin broker event handler (redirect events to users)
    onBrokerConnecting () {
      this.emit('mqtt', 'BrokerConnecting')
    }

    onBrokerOnline () {
      if (this.subGroups) {
        const fullTopic = (this.config.fullTopic
          .replace('%topic%', this.config.device)
          .replace('%prefix%', '+') 
          + (this.config.fullTopic.endsWith('/') ? '+' : '/+'))
            .replace('+/+', '#')
        //single device subscribtion
        this.brokerNode.subscribe(this, fullTopic, this.config.qos, (topic, payload, packet) => { 
          this._onMqttMessage(topic, payload, packet) })
      }

      this.emit('mqtt', 'BrokerOnline')
    }

    onBrokerOffline () {
      this.emit('mqtt', 'BrokerOffline')
    }

    onDeviceOnline () {
      if (this.config.ip) this.downloadConfig()
      else this.MQTTPublish('cmnd', 'STATUS', '5')
      this.emit('mqtt', 'DeviceOnline')
    }

    onDeviceOffline () {
      this.emit('mqtt', 'DeviceOffline')
    }

    _onMqttMessage(topic, payload, packet) {
      if (this.subGroups.stat && topic.startsWith(this.subGroups.stat.topic)) {
        const command = topic.substr(this.subGroups.stat.topic.length)
        if (command.startsWith('STATUS')) this._onMqttStatus(command, payload)
        this._fireMqttMessage(topic, payload, packet, command, this.subGroups.stat.subscriptions);
      }
      else if (this.subGroups.cmnd && topic.startsWith(this.subGroups.cmnd.topic)) {
        const command = topic.substr(this.subGroups.cmnd.topic.length)
        this._fireMqttMessage(topic, payload, packet, command, this.subGroups.cmnd.subscriptions);
      }
      else if (this.subGroups.tele && topic.startsWith(this.subGroups.tele.topic)) {
        const command = topic.substr(this.subGroups.tele.topic.length)
        this._fireMqttMessage(topic, payload, packet, command, this.subGroups.tele.subscriptions);
      }
      else {
        //regiter tele subGroup on demand
        if (!this.subGroups.cmnd && topic.includes(this.config.cmndPrefix)) return this.MQTTSubscribe(this, 'cmnd', 'STATUS')
        if (!this.subGroups.tele && topic.includes(this.config.telePrefix)) return this.MQTTSubscribe(this, 'tele')
        this.warn(`_onMqttMessage topic:${topic}, subGroups:${JSON.stringify(this.subGroups)}`)
      }
    }

    _fireMqttMessage(topic, payload, packet, command, subscriptions) {
      if (Object.prototype.hasOwnProperty.call(subscriptions, command)) {
        for (const ref in subscriptions[command]) {
          if (Object.prototype.hasOwnProperty.call(subscriptions[command], ref)) {
            const callback = subscriptions[command][ref]
            callback(topic, payload, packet)
          }
        }
      }
      command = '+'
      if (Object.prototype.hasOwnProperty.call(subscriptions, command)) {
        for (const ref in subscriptions[command]) {
          if (Object.prototype.hasOwnProperty.call(subscriptions[command], ref)) {
            const callback = subscriptions[command][ref]
            callback(topic, payload, packet)
          }
        }
      }
    }

    buildFullTopic(prefix, command) {
      let full = this.config.fullTopic

      full = full.replace('%topic%', this.config.device)

      if (prefix === 'tele') {
        full = full.replace('%prefix%', this.config.telePrefix)
      } else if (prefix === 'cmnd') {
        full = full.replace('%prefix%', this.config.cmndPrefix)
      } else if (prefix === 'stat') {
        full = full.replace('%prefix%', this.config.statPrefix)
      }

      if (full.endsWith('/')) {
        return full + command
      } else {
        return full + '/' + command
      }
    }

    MQTTPublish(prefix, command, payload) {
      const fullTopic = this.buildFullTopic(prefix, command)
      const options = {
        qos: this.config.qos,
        retain: this.config.retain
      }
      this.brokerNode.publish(fullTopic, payload, options)
    }

    MQTTSubscribe(tasmotaNode, prefix, command, callback) {
      this.subGroups = this.subGroups || {}

      switch (prefix) {
        case 'cmnd':
        case 'stat':
        case 'tele':
          break
        default:
          this.warn(`MQTTSubscribe (!unknown prefix):${prefix}, type:${tasmotaNode.type}, node:${tasmotaNode.config?.name}, nodeId:${tasmotaNode.id}`)
          if (prefix) {
            const topic = this.buildFullTopic(prefix, command)
            this.brokerNode.subscribe(tasmotaNode, topic, this.config.qos, callback)
          }
          return
      }
      
      const topic = this.buildFullTopic(prefix, '')
      this.subGroups[prefix] = this.subGroups[prefix] || { topic, subscriptions: {} }
      if (!command || !callback) return
    
      let subscriptions = this.subGroups[prefix].subscriptions
      subscriptions[command] = subscriptions[command] || {}
      subscriptions[command][tasmotaNode.id] = callback
    }
  }

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
  
  RED.nodes.registerType('tasmota-device', TasmotaDevice)
}
