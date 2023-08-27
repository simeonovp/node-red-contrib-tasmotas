module.exports = function (RED) {
  'use strict'
  const TasmotaBase = require('./tasmota_base.js')

  const LIGHT_DEFAULTS = {
    dualLights: true,
    havedimmer: true,
    havetemp: false,
    havecolors: false,
    tempformat: 'K',
    colorsformat: 'HSB',
    colorCmnd: 'Color1'
  }

  // values for the tasmota POWER command
  const onValue = 'ON'
  const offValue = 'OFF'
  const toggleValue = 'TOGGLE'

  // named colors supported by the color command
  const TASMOTA_COLORS = {
    red: '1',
    green: '2',
    blue: '3',
    orange: '4',
    lightgreen: '5',
    lightblue: '6',
    amber: '7',
    cyan: '8',
    purple: '9',
    yellow: '10',
    pink: '11',
    white: '12',
    '+': '+',
    '-': '-'
  }

  function mired2percent (mired) {
    return 100 - Math.round(((mired - 153) / (500 - 153)) * 100)
  }

  function percent2mired (percent) {
    return Math.floor((((100 - percent) / 100) * (500 - 153)) + 153)
  }

  function mired2kelvin (mired) {
    return Math.floor(1000000 / mired)
  }

  function kelvin2mired (kelvin) {
    return Math.floor(1000000 / kelvin)
  }

  function hsb2rgb (h, s, v) {
    h = (h % 360 + 360) % 360 // normalize angle
    h = (h === 360) ? 1 : (h % 360 / parseFloat(360) * 6)
    s = (s === 100) ? 1 : (s % 100 / parseFloat(100))
    v = (v === 100) ? 1 : (v % 100 / parseFloat(100))

    const i = Math.floor(h)
    const f = h - i
    const p = v * (1 - s)
    const q = v * (1 - f * s)
    const t = v * (1 - (1 - f) * s)
    const mod = i % 6
    const r = [v, q, p, p, t, v][mod]
    const g = [t, v, v, q, p, p][mod]
    const b = [p, p, t, v, v, q][mod]

    return [
      Math.floor(r * 255),
      Math.floor(g * 255),
      Math.floor(b * 255)
    ]
  }

  class TasmotaLight extends TasmotaBase {
    constructor (config) {
      super(config, RED, LIGHT_DEFAULTS)
      this.cache = {} // light status cache, es: {on: true, bright:55, ct:153, colors:...}
      this.colorCmnd = config.colorCmnd || 'Color1'

      // Subscribes to state changes
      this.mqttSubscribeStat('RESULT', (topic, payload) => {
        this.onStat(topic, payload)
      })
    }

    onDeviceOnline () {
      // Publish a start command to get the current state of the device
      this.mqttCommand('State')
    }

    onNodeInput (msg) {
      const data = {}

      // MODE 1: simple on/off/toggle (without topic)
      if (!msg.topic &&
          (typeof msg.payload === 'number' ||
           typeof msg.payload === 'boolean' ||
           typeof msg.payload === 'string')) {
        data.on1 = msg.payload
      }

      // MODE 2: topic mode (with simple-typed payload)
      const processCmd = (cmd) => {
        switch (cmd) {
          case 'on': case 'state': case 'power': case 'power1':
            data.on1 = msg.payload
            break
          case 'power2':
            data.on2 = msg.payload
            break
          case 'bright': case 'brightness': case 'dimmer':
            data.bright = msg.payload
            break
          case 'dimmerc':
            data.dimmerc = msg.payload
            break
          case 'dimmerw':
            data.dimmerw = msg.payload
            break
          case 'ct': case 'colortemp':
            data.ct = msg.payload
            break
          case 'rgb': case 'rgbcolor':
            data.rgb = msg.payload
            break
          case 'hsb': case 'hsbcolor':
            data.hsb = msg.payload
            break
          case 'hex': case 'hexcolor':
            data.hex = msg.payload
            break
          case 'color':
            data.color = msg.payload
            break
          default:
            this.error('Unsupported topic ' + cmd)
        }
      }
      if (msg.topic && (typeof msg.topic === 'string') &&
          ((typeof msg.payload === 'boolean') ||
           (typeof msg.payload === 'number') ||
           (typeof msg.payload === 'string') ||
           Array.isArray(msg.payload))) {
        processCmd(msg.topic.toLowerCase())
      }

      // MODE 3: object payload (without topic)
      if (!msg.topic && typeof msg.payload === 'object') {
        for (const [key, value] of Object.entries(msg.payload)) {
          processCmd(key.toLowerCase())
       }
      }

      // did we found something usefull?
      if (!Object.keys.length) {
        this.warn('Invalid message received on input')
        return
      }

      // on: true/false, 1/0, on/off, toggle (not case sensitive)
      const sendPower = (on, idx) => {
        console.log(`-- sendPower(${on}, ${idx})`) //--
        switch (on.toString().toLowerCase()) {
          case '1':
          case 'on':
          case 'true':
            console.log(`-- mqttCommand(${'POWER' + idx}, ${onValue})`)
            this.mqttCommand('POWER' + idx, onValue)
            break
          case '0':
          case 'off':
          case 'false':
            console.log(`-- mqttCommand(${'POWER' + idx}, ${offValue})`)
            this.mqttCommand('POWER' + idx, offValue)
            break
          case 'toggle':
            this.mqttCommand('POWER' + idx, toggleValue)
            break
          default:
            this.warn(`Invalid value for the 'power${idx}' command (should be: true/false, 1/0, on/off or toggle)`)
        }
      }
      if (data.on1 !== undefined) sendPower(data.on1, 1)
      if (data.on2 !== undefined) sendPower(data.on2, 2)

      // rgb: array[r,g,b] or string "r,g,b" (0-255, 0-255, 0-255)
      if (data.rgb !== undefined) {
        if (typeof data.rgb === 'string') {
          this.mqttCommand(this.colorCmnd, data.rgb)
        } 
        else if (Array.isArray(data.rgb) && (data.rgb.length === 3)) {
          this.mqttCommand(this.colorCmnd, data.rgb.toString())
        } 
        else {
          this.warn('Invalid value for the \'rgb\' command (should be: [r,g,b] [0-255, 0-255, 0-255])')
        }
      }

      // hsb: array[h,s,b] or string "h,s,b" (0-360, 0-100, 0-100)
      if (data.hsb !== undefined) {
        if (typeof data.hsb === 'string') {
          this.mqttCommand('HsbColor', data.hsb)
        } 
        else if (Array.isArray(data.hsb) && data.hsb.length === 3) {
          this.mqttCommand('HsbColor', data.hsb.toString())
        } 
        else {
          this.warn('Invalid value for the \'hsb\' command (should be: [h,s,b] [0-360, 0-100, 0-100])')
        }
      }

      // hex: #CWWW, #RRGGBB, #RRGGBBWW or #RRGGBBCWWW (with or without #)
      if (data.hex !== undefined) {
        if (typeof data.hex === 'string') {
          data.hex = (data.hex[0] === '#') ? data.hex : '#' + data.hex
          if ((data.hex.length === 5) || (data.hex.length === 7) || (data.hex.length === 9) || (data.hex.length === 11)) {
            if (data.hex.length >  5) data.hex = (data.hex + '====').substring(0, 11)
            this.mqttCommand(this.colorCmnd, data.hex)
          } 
          else this.warn('Invalid length for the \'hex\' command (should be: #CWWW, #RRGGBB, #RRGGBBWW or #RRGGBBCWWW)')
        } 
        else this.warn('Invalid type for the \'hex\' command (should be: #CWWW, #RRGGBB, #RRGGBBWW or #RRGGBBCWWW)')
      }

      // color: ColorName or +/- (next/prev color)
      if (data.color !== undefined) {
        if (typeof data.color === 'string') {
          const colorCode = TASMOTA_COLORS[data.color.replace(/\s/g, '').toLowerCase()]
          if (colorCode !== undefined) {
            this.mqttCommand(this.colorCmnd, colorCode)
          } 
          else this.warn('Invalid value for the \'color\' command (should be a color name or +/-)')
        } 
        else this.warn('Invalid type for the \'color\' command (should be a string)')
      }

      // bright: 0-100
      const sendDimmer = (dimmer, idx) => {
        idx = idx && idx.toString() || ''
        dimmer = parseInt(dimmer)
        if (isNaN(dimmer) || (dimmer < 0) || (dimmer > 100)) {
          this.warn('Invalid value for the \'bright\' command (should be: 0-100)')
          return
        }
        this.mqttCommand('Dimmer' + idx, dimmer.toString())
      }
      if (data.bright !== undefined) sendDimmer(data.bright)
      if (data.dimmerc !== undefined) sendDimmer(data.dimmerc, 1)
      if (data.dimmerw !== undefined) sendDimmer(data.dimmerw, 2)

      // ct: 500-153, 2000-6500, 0-100 (warm to cold)
      if (data.ct !== undefined) {
        data.ct = parseInt(data.ct)
        if (isNaN(data.ct)) {
          this.warn('Invalid value for the \'ct\' command (should be: 0-100, 2000-6500 or 500-153)')
        } 
        else if ((data.ct >= 153) && (data.ct <= 500)) { // ct in mired (cold to warm)
          this.mqttCommand('CT', ct.toString())
        } 
        else if ((data.ct >= 0) && (data.ct <= 100)) { // ct in percent (warm to cold)
          data.ct = percent2mired(data.ct)
          this.mqttCommand('CT', data.ct.toString())
        } 
        else if ((data.ct >= 2000) && (data.ct <= 6500)) { // ct in kelvin (warm to cold)
          data.ct = kelvin2mired(data.ct)
          this.mqttCommand('CT', data.ct.toString())
        } 
        else {
          this.warn('Invalid value for the \'ct\' command (should be: 0-100, 2000-6500 or 500-153)')
        }
      }
    }

    onStat (mqttTopic, mqttPayloadBuf) {
      // const payloadSingle = {
      //   "POWER":"OFF",
      //   "Dimmer":0,
      //   "Color":"0,0,0,0",
      //   "HSBColor":"224,100,0",
      //   "White":0,
      //   "Channel":[0,0,0,0]
      // }
      // const payloadDual = { 
      //   "POWER1": "ON",
      //   "Dimmer1": 50,
      //   "POWER2": "ON",
      //   "Dimmer2": 100,
      //   "Color": "014080FF00",
      //   "HSBColor": "210,99,50",
      //   "White": 100,
      //   "CT": 153,
      //   "Channel": [1, 25, 50, 100, 0] 
      // }

      let data
      try {
        data = JSON.parse(mqttPayloadBuf.toString())
      } 
      catch (err) {
        this.setNodeStatus('red', 'Error parsing JSON data from device')
        this.error(err, 'Error parsing JSON data from device')
        return
      }

      // update cache with the received data
      if (data.POWER !== undefined) { this.cache.on = (data.POWER === onValue) }
      if (data.POWER1 !== undefined) { this.cache.on1 = (data.POWER1 === onValue) }
      if (data.POWER2 !== undefined) { this.cache.on2 = (data.POWER2 === onValue) }
      if (this.config.havedimmer) {
        if (data.Dimmer !== undefined) { this.cache.bright = data.Dimmer }
        if (data.Dimmer1 !== undefined) { this.cache.dimmer1 = data.Dimmer1 }
        if (data.Dimmer2 !== undefined) { this.cache.dimmer2 = data.Dimmer2 }
      }
      if (this.config.havetemp && data.CT !== undefined) {
        if (this.config.tempformat === 'K') {
          this.cache.ct = mired2kelvin(data.CT)
        } else if (this.config.tempformat === 'P') {
          this.cache.ct = mired2percent(data.CT)
        } else { // mired
          this.cache.ct = data.CT
        }
      }
      if (this.config.havecolors) {
        if (data.HSBColor !== undefined) {
          const hsb = data.HSBColor.split(',').map(Number)
          if (this.config.colorsformat === 'HSB') {
            this.cache.colors = hsb
          } 
          else if (this.config.colorsformat === 'RGB') {
            this.cache.colors = hsb2rgb(hsb[0], hsb[1], hsb[2])
          } 
          else if (this.config.colorsformat === 'HEX') {
            this.cache.colors = data.Color
          } 
          else { // Channels
            this.cache.colors = data.Channel
          }
        }
      }
      if (data.Channel !== undefined) {
        this.cache.channel = data.Channel
      }

      const msg = (payload) => (payload !== undefined) && { payload } || null
      // send all the cached data to the node output(s)
      // or send each value to the correct output
      if (this.config.outputs === 1 || this.config.outputs === '1') {
        // everything to the same (single) output, as a JSON dict object
        this.onSend({ payload: this.cache })
      } 
      else if (this.config.outputs === 2 || this.config.outputs === '2') {
        if (this.config.dualLights) this.onSend([
          msg(this.cache.on1), // Output 1: on/off status color
          msg(this.cache.on2) // Output 2: on/off status white
        ])
        else this.onSend([
          msg(this.cache.on), // Output 1: on/off status
          msg(this.cache.bright) // Output 2: brightness
        ])
      }
      else if (this.config.outputs === 3 || this.config.outputs === '3') {
        if (this.config.dualLights) return this.error('Invalide output count. must be odd for dual lights mode')
        this.onSend([
          msg(this.cache.on), // Output 1: on/off status
          msg(this.cache.bright), // Output 2: brightness
          msg(this.cache.ct) // Output 3: temperature
        ])
      }
      else if (this.config.outputs === 4 || this.config.outputs === '4') {
        if (this.config.dualLights) this.onSend([
          msg(this.cache.on1), // Output 1: on/off status color
          msg(this.cache.dimmer1), // Output 2: brightness color
          msg(this.cache.on2), // Output 3: on/off status white
          msg(this.cache.dimmer2) // Output 4: brightness white
        ])
        else this.onSend([
          msg(this.cache.on), // Output 1: on/off status
          msg(this.cache.bright), // Output 2: brightness
          msg(this.cache.ct), // Output 3: temperature
          msg(this.cache.colors) // Output 4: colors
        ])
      }
      else if (this.config.outputs === 5 || this.config.outputs === '5') {
        if (this.config.dualLights) this.onSend([
          msg(this.cache.on1), // Output 1: on/off status color
          msg(this.cache.dimmer1), // Output 2: brightness color
          msg(this.cache.on2), // Output 3: on/off status white
          msg(this.cache.dimmer2), // Output 4: brightness white
          msg(this.cache.ct), // Output 5: temperature color
        ])
      }
      else if (this.config.outputs === 6 || this.config.outputs === '6') {
        if (this.config.dualLights) this.onSend([
          msg(this.cache.on1), // Output 1: on/off status color
          msg(this.cache.dimmer1), // Output 2: brightness color
          msg(this.cache.on2), // Output 3: on/off status white
          msg(this.cache.dimmer2), // Output 4: brightness white
          msg(this.cache.ct), // Output 5: temperature color
          msg(this.cache.colors) // Output 6: colors
        ])
      }
      else return this.error('Invalide output count.')

      // update node status label
      let status
      if (this.cache.on !== undefined) {
        status = this.cache.on ? 'On' : 'Off'
      }
      if (this.cache.bright !== undefined) {
        status += ` bri:${this.cache.bright}%`
      }
      if ((this.cache.on1 !== undefined) && (this.cache.on1 !== undefined)) {
        status = `
${this.cache.on1 ? 'On' : 'Off'}${this.cache.dimmer1 ? ' (' + this.cache.dimmer1 + '%)' : ''} - 
${this.cache.on2 ? 'On' : 'Off'}${this.cache.dimmer2 ? ' (' + this.cache.dimmer2 + '%)' : ''}`
      }
      if (this.cache.ct !== undefined) {
        status += ` ct:${this.cache.ct}`
      }
      this.setNodeStatus(this.cache.on ? 'green' : 'grey', status)
    }
  }

  RED.nodes.registerType('tasmota-light', TasmotaLight)
}
