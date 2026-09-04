'use strict'

const mqtt = require('mqtt')

// -- flow/config-node builders -----------------------------------------
// Mirror the *_DEFAULTS objects in nodes/*.js so tests build the same
// shape of config the Node-RED editor would produce.

function mqttBrokerConfig (id, port, overrides = {}) {
  return Object.assign({
    id,
    type: 'tasmota-mqtt-broker',
    broker: '127.0.0.1',
    port,
    clientid: '',
    usetls: false,
    verifyservercert: false,
    compatmode: false,
    keepalive: '15',
    cleansession: true
  }, overrides)
}

function deviceConfig (id, brokerId, device, overrides = {}) {
  return Object.assign({
    id,
    type: 'tasmota-device',
    broker: brokerId,
    device,
    name: '',
    group: '',
    ip: '',
    host: '',
    mac: '',
    version: 1,
    fullTopic: '%prefix%/%topic%/',
    cmndPrefix: 'cmnd',
    statPrefix: 'stat',
    telePrefix: 'tele',
    qos: 1,
    retain: false
  }, overrides)
}

function managerConfig (id, overrides = {}) {
  return Object.assign({
    id,
    type: 'tasmota-manager',
    name: id, // used as resources/<name> cache folder, keep unique per test
    dbUri: '', // no dbUri => no network access during tests
    network: ''
  }, overrides)
}

function rfManagerConfig (id, managerId, overrides = {}) {
  return Object.assign({
    id,
    type: 'tasmota-rf-manager',
    manager: managerId,
    debounce: 0
  }, overrides)
}

function leafConfig (id, type, deviceId, overrides = {}) {
  return Object.assign({
    id,
    type,
    device: deviceId,
    name: '',
    outputs: 1,
    sendDevice: true,
    uidisabler: false,
    wires: [[]]
  }, overrides)
}

function helperNode (id) {
  return { id, type: 'helper' }
}

// Minimal stub satisfying the "user" interface expected by
// TasmotaMQTTBrokerNode (onBrokerOnline/Offline/Connecting called on every
// registered user, e.g. from the client 'close' handler).
function fakeBrokerUser (id, overrides = {}) {
  return Object.assign({
    id,
    onBrokerOnline () {},
    onBrokerOffline () {},
    onBrokerConnecting () {}
  }, overrides)
}

// -- MQTT test client -----------------------------------------------------

function connectClient (port, overrides = {}) {
  return mqtt.connect(`mqtt://127.0.0.1:${port}`, Object.assign({ reconnectPeriod: 0 }, overrides))
}

function closeClient (client) {
  return new Promise((resolve) => client.end(false, {}, resolve))
}

function publish (client, topic, payload, opts = {}) {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, opts, (err) => (err ? reject(err) : resolve()))
  })
}

function subscribe (client, topic, opts = {}) {
  return new Promise((resolve, reject) => {
    client.subscribe(topic, opts, (err) => (err ? reject(err) : resolve()))
  })
}

// Collects every message received on `topic` (supports wildcards) into an array.
function collectMessages (client, topic) {
  const messages = []
  client.on('message', (t, payload) => messages.push({ topic: t, payload: payload.toString() }))
  return subscribe(client, topic).then(() => messages)
}

// Publishes a retained Tasmota LWT message so a device node currently (or about
// to be) subscribed picks it up regardless of subscribe/publish ordering.
function publishLwt (client, deviceTopic, online, fullTopic = '%prefix%/%topic%/') {
  const topic = fullTopic.replace('%prefix%', 'tele').replace('%topic%', deviceTopic) + 'LWT'
  return publish(client, topic, online ? 'Online' : 'Offline', { retain: true, qos: 1 })
}

module.exports = {
  mqttBrokerConfig,
  deviceConfig,
  managerConfig,
  rfManagerConfig,
  leafConfig,
  helperNode,
  fakeBrokerUser,
  connectClient,
  closeClient,
  publish,
  subscribe,
  collectMessages,
  publishLwt
}
