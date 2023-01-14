'use strict'

const TASMOTA_DEFAULTS = {
  // basic
  device: '', // mandatory
  name: '',
  outputs: 1,
  sendDevice: true,
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
      } else {
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
      this.deregister(this)
      done()
    })
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
    if (this.config.sendDevice) msg.device = this.deviceNode.config.device
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
      this.MQTTPublish('cmnd', cmd, param)
    } else if (Array.isArray(payload)) {
      // 2. list payload: ['CMD <param>', 'CMD <param>', ...]
      for (let i = 0; i < payload.length; i++) {
        const [cmd, param] = payload[i].split(' ', 2)
        this.MQTTPublish('cmnd', cmd, param)
      }
    } else if (typeof payload === 'object') {
      // 3. object payload: {'CMD': 'param', 'CMD': 'param', ...}
      for (const cmd in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, cmd)) {
          const param = payload[cmd]
          this.MQTTPublish('cmnd', cmd, param)
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
    } else {
      this.status({
        fill: 'red',
        shape: 'ring',
        text: isOnline && LWT_ONLINE || LWT_OFFLINE
      })
    }
  }

  MQTTPublish(prefix, command, payload) {
    this.deviceNode.MQTTPublish(prefix, command, payload)
  }

  MQTTSubscribe(prefix, command, callback) {
    this.deviceNode.MQTTSubscribe(this, prefix, command, callback)
  }

  extractChannelNum(str) {
    const numberRegexp = /\d+$/
    return Number(str.match(numberRegexp) || 1)
  }
}

module.exports = TasmotaBase
