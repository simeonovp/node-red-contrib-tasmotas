'use strict'

const TASMOTA_DEFAULTS = {
  // basic
  device: '', // mandatory
  name: '',
  outputs: 1,
  sendDevice: true,
  crashMonitor: false,
  uidisabler: false
}

const LWT_ONLINE = 'Online'
const LWT_OFFLINE = 'Offline'

class TasmotaBase {
  constructor(config, RED, more_defaults = {}) {
    RED.nodes.createNode(this, config)

    this.closing = false

    // Merge base and child defaults
    const defaults = Object.assign({}, TASMOTA_DEFAULTS, more_defaults)

    // Merge user and default config
    this.config = {}
    for (const key in defaults) {
      if (config[key] !== undefined && config[key] !== '') {
        if ((typeof defaults[key] == 'number') && (typeof config[key] === 'string')) {
          this.config[key] = parseInt(config[key])
        }
        else this.config[key] = config[key]
      }
      else {
        this.config[key] = defaults[key]
      }
    }

    // Get and check the device node (could be wrong if updated from old release)
    const deviceNode = RED.nodes.getNode(this.config.device)
    if (!deviceNode || deviceNode.type !== 'tasmota-device') {
      this.warn('Device configuration is wrong or missing, please review the node settings')
      this.status({ fill: 'red', shape: 'dot', text: 'Wrong config' })
      return
    }
    this.config.name = this.config.name || deviceNode.config.device

    // Register ourself in the device node
    this.deviceNode = deviceNode
    this.deviceNode.register(this)
    this.deviceNode.addListener('mqtt', this._onMqttEvent.bind(this))
    this.deviceNode.addListener(this.type + (this.config.idx || ''), this._onDeviceEvent.bind(this))

    this.on('input', (msg, send, done) => {
      if (msg.topic === 'command') {
        // if topic is 'command' send raw tasmota commands over MQTT
        this.sendRawCommand(msg.payload)
      } else {
        // Or let the child class handle the msg
        this.onNodeInput(msg)
      }
      // Notify NodeRed we finished handling the msg
      if (done) {
        done()
      }
    })

    // Deregister from DeviceNode when this node is deleted or restarted
    this.on('close', (done) => {
      this.closing = true
      this.deviceNode.removeListener(this.type + (this.config.idx || ''), this._onDeviceEvent.bind(this))
      this.deviceNode.deregister(this)
      done()
    })

    if (this.config.crashMonitor) this.mqttSubscribeTele('INFO3', (topic, payload) => this.onRestart(topic, payload))
  }

  _onMqttEvent(ev) {
    switch (ev) {
      case 'BrokerConnecting':
        // force the status, regardless the LWT
        this.status({ fill: 'yellow', shape: 'ring', text: 'Broker connecting' })
        break;
      case 'BrokerOnline':
        // probably this is never shown, as the LWT sould be Offline
        // at this point. But we need to update the status.
        this.setNodeStatus('red', 'Broker connected', 'ring')
        break;
      case 'BrokerOffline':
        if (!this.closing) {
          // force the status, regardless the LWT
          this.status({ fill: 'red', shape: 'ring', text: 'Broker disconnected' })
          this._sendEnableUI(false)
          this._onMqttEvent('DeviceOffline')
        }
        break;
      case 'DeviceOnline':
        this.setNodeStatus('green', LWT_ONLINE, 'ring')
        this._sendEnableUI(true)
        break;
      case 'DeviceOffline':
        this.setNodeStatus('red', LWT_OFFLINE, 'ring')
        this._sendEnableUI(false)
        break;
    }
  }

  _onDeviceEvent(ev, data) {
    switch (ev) {
      case 'send':
        this.onSend(data)
        break;
    }
  }

  onSend(msg) {
    if (Array.isArray(msg)) {
      if (this.config.sendDevice) msg.forEach(pinMsg => pinMsg && (pinMsg.device = this.deviceNode.config.device))
    }
    else if (this.config.sendDevice) msg.device = this.deviceNode.config.device
    this.send(msg)
  }

  _sendEnableUI(enabled) {
    if (this.config.uidisabler) {
      this.sendToAllOutputs({ enabled })
    }
  }

  sendToAllOutputs(msg) {
    const count = Number(this.config.outputs) || 1
    if (count === 1) {
      this.send(msg)
    } else {
      this.send(new Array(count).fill(msg))
    }
  }

  sendRawCommand(payload) {
    if (typeof payload === 'string') {
      // 1. string payload: 'CMD <param>'
      const [cmd, param] = payload.split(' ', 2)
      this.mqttCommand(cmd, param)
    } else if (Array.isArray(payload)) {
      // 2. list payload: ['CMD <param>', 'CMD <param>', ...]
      for (let i = 0; i < payload.length; i++) {
        const [cmd, param] = payload[i].split(' ', 2)
        this.mqttCommand(cmd, param)
      }
    } else if (typeof payload === 'object') {
      // 3. object payload: {'CMD': 'param', 'CMD': 'param', ...}
      for (const cmd in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, cmd)) {
          const param = payload[cmd]
          this.mqttCommand(cmd, param)
        }
      }
    } else {
      this.warn('Invalid payload received for raw tasmota commands')
    }
  }

  onNodeInput(msg) {
    // Subclasses can override to receive input messagges from NodeRed
  }

  setNodeStatus(fill, text, shape) {
    const isOnline = this.deviceNode && this.deviceNode.isOnline
    if (isOnline) {
      text = this.deviceNode.ap && `${text}(${this.deviceNode.ap})` || text
      this.status({
        fill: fill,
        text: text,
        shape: shape || 'dot'
      })
    }
    else {
      this.status({
        fill: 'red',
        shape: 'ring',
        text: isOnline && LWT_ONLINE || LWT_OFFLINE
      })
    }
  }

  mqttCommand(command, payload) {
    this.deviceNode.mqttCommand(command, payload)
  }

  mqttSubscribeTele(command, callback) {
    this.deviceNode.mqttSubscribeTele(this, command, callback)
  }

  mqttSubscribeStat(command, callback) {
    this.deviceNode.mqttSubscribeStat(this, command, callback)
  }

  extractChannelNum(str) {
    const numberRegexp = /\d+$/
    return Number(str.match(numberRegexp) || 1)
  }


  onRestart(topic, payload) {
    //00:00:07 MQT: tasmota/t1_03/tele/INFO3 = {"RestartReason":{"Exception":29,"Reason":"Exception","EPC":["4000df64","00000000","00000000"],"EXCVADDR":"00000000","DEPC":"00000000","CallChain":["40101468","4025e5d7","4025e56c","4025e513","4025d674","4025d69d","4025b108","40101b7e","40253814","4025746d","4024c0dd","4025bdff","402534c4","4025b872","40264fc7","40264887","40243314","40000f49","40000f49","40000e19","40105909","4010590f","4010000d","4026376c","4026371d","40104609","40105751","40105336","40104c85","402494fa","40105239"]}}
    //00:00:06.066 MQT: tasmota/t1_03/tele/INFO3 = {"Info3":{"RestartReason":"Software/System restart","BootCount":940}}
    const restartReason = payload.Info3?.RestartReason || payload.RestartReason
    if (restartReason?.Exception) {
      this.error('Exception: ' + JSON.stringify(restartReason, null, 2))
    }
  }
}

module.exports = TasmotaBase
