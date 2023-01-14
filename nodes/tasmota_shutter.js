module.exports = function (RED) {
  'use strict'
  const TasmotaBase = require('./tasmota_base.js')

  const D_CMND_SHUTTER_UP = 'Up'
  const D_CMND_SHUTTER_DOWN = 'Down'

  const SHUTTER_DEFAULTS = {
    idx: 0,
    swapSwitches: false
  }

  const ShutterPrefix = 'Shutter'
  const ShutterCommands = [
    'Open',
    'Close',
    'Toggle',
    'ToggleDir',
    'Mode',
    'StopOpen',
    'StopClose',
    'StopToggle',
    'StopToggleDir',
    'Change',
    'StopPosition',
    'Stop',
    'Position',
    'OpenDuration',
    'CloseDuration',
    'Relay',
    'SetHalfway',
    'SetClose',
    'SetOpen',
    'Invert',
    'Calibration',
    'MotorDelay',
    'Frequency',
    'Button',
    'Lock',
    'EnableEndStopTime',
    'InvertWebButtons',
    'PWMRange',
    'UnitTest',
    'TiltConfig',
    'Tilt',
    'TiltChange'
  ]

  class TasmotaShutter extends TasmotaBase {
    constructor (config) {
      super(config, RED, SHUTTER_DEFAULTS)
      this.shutter = this.deviceNode.shutters[this.config.idx]
    }

    onNodeInput (msg) {
      let payload = msg.payload
      const topic = (msg.topic || '').toLowerCase()
      if (topic === 'position') {
        this.shutter.command('Position', payload.toString())
        return
      }
      if (typeof payload === 'string') {
        switch (payload) {
          case 'Open':
            if (this.config.swapSwitches) payload = 'Close'
            break;
          case 'Close':
            if (this.config.swapSwitches) payload = 'Open'
            break;
          case 'Stop':
            break;
          default:
            this.warn('Invalid payload received on input' + JSON.stringify(msg))
            return
        }
      }
      else {
        this.warn('Invalid payload received on input' + JSON.stringify(msg))
        return
      }
      this.shutter.command(payload)
    }

    onSend(msg) {
      msg.payload = this.shutter.data.Position
      switch(msg.topic) {
        case 'position':
          // update status icon and label
          if (this.shutter.position === 100) this.setNodeStatus('green', (this.config.swapSwitches) ? 'Open' : 'Closed')
          else if (this.shutter.position === 0) this.setNodeStatus('green', (this.config.swapSwitches) ? 'Closed' : 'Open')
          else this.setNodeStatus('grey', this.shutter.data.Position.toString() + '%')
          break
      }
      super.onSend(msg)
    }

    _onMqttEvent(ev) {
      super._onMqttEvent(ev)
      switch(ev) {
        case 'DeviceOnline':
          this.shutter.requestPosition()
          break;
        case 'DeviceOffline':
          break;
      }
    }
  }

  RED.nodes.registerType('tasmota-shutter', TasmotaShutter)
}
