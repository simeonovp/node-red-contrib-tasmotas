'use strict'

const assert = require('assert')
const { helper } = require('../helpers/env')
const { helperNode } = require('../helpers/flow')
const { waitUntil } = require('../helpers/wait')
const configNodeModule = require('../../nodes/tasmota_config.js')

// tasmota-config only talks to a "manager" config node (normally
// tasmota-manager) - no MQTT/broker involved, so this spec doesn't need the
// aedes broker helper at all, just a lightweight fake manager node.
function fakeManagerModule (RED) {
  function FakeManager (config) {
    RED.nodes.createNode(this, config)
    this.calls = []
    this.backupResources = (dir) => this.calls.push(['backupResources', dir])
    this.loadMqttMap = () => { this.calls.push(['loadMqttMap']); return { '1.2.3.4': 'dev1' } }
    this.findAP = (bssid) => { this.calls.push(['findAP', bssid]); return { host: 'ap1' } }
    this.listDevices = () => { this.calls.push(['listDevices']); return [{ dev1: '1.2.3.4' }] }
    this.listDeviceNodes = () => { this.calls.push(['listDeviceNodes']); return [] }
    this.listDbDevices = (field) => { this.calls.push(['listDbDevices', field]); return [] }
    this.getDbDevices = () => { this.calls.push(['getDbDevices']); return [] }
    this.httpCommand = async (ip, cmnd, val) => { this.calls.push(['httpCommand', ip, cmnd, val]); return { Topic: 'dev1' } }
    this.buildRecoveryCommand = (mac, override) => { this.calls.push(['buildRecoveryCommand', mac, override]); return { found: true, mac, command: 'Backlog ...', url: 'http://192.168.4.1/cm?cmnd=...' } }
    this.findTasmotaAPs = async (iface) => { this.calls.push(['findTasmotaAPs', iface]); return [{ ssid: 'tasmota_A1B2C3-4210', signal: 55, unit: 'percent', macSuffix: 'A1B2C3', chipId: 4210 }] }
    this.recoveryDevice = async (ssid, override) => { this.calls.push(['recoveryDevice', ssid, override]); return { mac: 'AA:BB:CC:DD:EE:01', found: true, command: 'Backlog ...', url: 'http://192.168.4.1/cm?cmnd=...' } }
  }
  RED.nodes.registerType('fake-manager', FakeManager)
}

describe('tasmota-config node', function () {
  afterEach(async function () { await helper.unload() })

  it('dispatches the listDevices action against the configured manager', async function () {
    const flow = [
      { id: 'n1', type: 'fake-manager' },
      { id: 'n2', type: 'tasmota-config', manager: 'n1', wires: [['n3']] },
      helperNode('n3')
    ]
    await helper.load([fakeManagerModule, configNodeModule], flow)
    const n2 = helper.getNode('n2')
    const n3 = helper.getNode('n3')

    const received = []
    n3.on('input', (msg) => received.push(msg))
    n2.receive({ action: 'listDevices' })

    await waitUntil(() => received.length >= 1)
    assert.deepStrictEqual(received[0].payload, [{ dev1: '1.2.3.4' }])
  })

  it('dispatches httpCommand (async action) with ip/command/payload', async function () {
    const flow = [
      { id: 'n1', type: 'fake-manager' },
      { id: 'n2', type: 'tasmota-config', manager: 'n1', wires: [['n3']] },
      helperNode('n3')
    ]
    await helper.load([fakeManagerModule, configNodeModule], flow)
    const n1 = helper.getNode('n1')
    const n2 = helper.getNode('n2')
    const n3 = helper.getNode('n3')

    const received = []
    n3.on('input', (msg) => received.push(msg))
    n2.receive({ action: 'httpCommand', ip: '1.2.3.4', command: 'Topic', payload: '' })

    await waitUntil(() => received.length >= 1)
    assert.deepStrictEqual(n1.calls, [['httpCommand', '1.2.3.4', 'Topic', '']])
    assert.deepStrictEqual(received[0].payload, { Topic: 'dev1' })
  })

  it('dispatches buildRecoveryCommand with msg.mac', async function () {
    const flow = [
      { id: 'n1', type: 'fake-manager' },
      { id: 'n2', type: 'tasmota-config', manager: 'n1', wires: [['n3']] },
      helperNode('n3')
    ]
    await helper.load([fakeManagerModule, configNodeModule], flow)
    const n1 = helper.getNode('n1')
    const n2 = helper.getNode('n2')
    const n3 = helper.getNode('n3')

    const received = []
    n3.on('input', (msg) => received.push(msg))
    n2.receive({ action: 'buildRecoveryCommand', mac: 'AA:BB:CC:DD:EE:01' })

    await waitUntil(() => received.length >= 1)
    assert.deepStrictEqual(n1.calls, [['buildRecoveryCommand', 'AA:BB:CC:DD:EE:01', {}]])
    assert.strictEqual(received[0].payload.found, true)
  })

  it('dispatches buildRecoveryCommand with msg.mac and msg.override', async function () {
    const flow = [
      { id: 'n1', type: 'fake-manager' },
      { id: 'n2', type: 'tasmota-config', manager: 'n1', wires: [['n3']] },
      helperNode('n3')
    ]
    await helper.load([fakeManagerModule, configNodeModule], flow)
    const n1 = helper.getNode('n1')
    const n2 = helper.getNode('n2')
    const n3 = helper.getNode('n3')

    const received = []
    n3.on('input', (msg) => received.push(msg))
    n2.receive({ action: 'buildRecoveryCommand', mac: 'AA:BB:CC:DD:EE:01', override: { ssid: 'overridessid' } })

    await waitUntil(() => received.length >= 1)
    assert.deepStrictEqual(n1.calls, [['buildRecoveryCommand', 'AA:BB:CC:DD:EE:01', { ssid: 'overridessid' }]])
  })

  it('dispatches findTasmotaAPs with msg.iface', async function () {
    const flow = [
      { id: 'n1', type: 'fake-manager' },
      { id: 'n2', type: 'tasmota-config', manager: 'n1', wires: [['n3']] },
      helperNode('n3')
    ]
    await helper.load([fakeManagerModule, configNodeModule], flow)
    const n1 = helper.getNode('n1')
    const n2 = helper.getNode('n2')
    const n3 = helper.getNode('n3')

    const received = []
    n3.on('input', (msg) => received.push(msg))
    n2.receive({ action: 'findTasmotaAPs', iface: 'wlan1' })

    await waitUntil(() => received.length >= 1)
    assert.deepStrictEqual(n1.calls, [['findTasmotaAPs', 'wlan1']])
    assert.deepStrictEqual(received[0].payload, [{ ssid: 'tasmota_A1B2C3-4210', signal: 55, unit: 'percent', macSuffix: 'A1B2C3', chipId: 4210 }])
  })

  it('dispatches recoveryDevice with msg.ssid and msg.override', async function () {
    const flow = [
      { id: 'n1', type: 'fake-manager' },
      { id: 'n2', type: 'tasmota-config', manager: 'n1', wires: [['n3']] },
      helperNode('n3')
    ]
    await helper.load([fakeManagerModule, configNodeModule], flow)
    const n1 = helper.getNode('n1')
    const n2 = helper.getNode('n2')
    const n3 = helper.getNode('n3')

    const received = []
    n3.on('input', (msg) => received.push(msg))
    n2.receive({ action: 'recoveryDevice', ssid: 'tasmota_A1B2C3-4210', override: { ssid: 'homessid' } })

    await waitUntil(() => received.length >= 1)
    assert.deepStrictEqual(n1.calls, [['recoveryDevice', 'tasmota_A1B2C3-4210', { ssid: 'homessid' }]])
    assert.strictEqual(received[0].payload.mac, 'AA:BB:CC:DD:EE:01')
  })

  it('reports an error when recoveryDevice is dispatched without an SSID', async function () {
    const flow = [
      { id: 'n1', type: 'fake-manager' },
      { id: 'n2', type: 'tasmota-config', manager: 'n1', wires: [['n3']] },
      helperNode('n3')
    ]
    await helper.load([fakeManagerModule, configNodeModule], flow)
    const n2 = helper.getNode('n2')

    n2.receive({ action: 'recoveryDevice' })

    await waitUntil(() => n2.error.called)
    assert.strictEqual(n2.error.lastCall.args[0], 'Tasmota AP SSID not selected')
  })

  it('reports an error when buildRecoveryCommand is dispatched without a MAC address', async function () {
    const flow = [
      { id: 'n1', type: 'fake-manager' },
      { id: 'n2', type: 'tasmota-config', manager: 'n1', wires: [['n3']] },
      helperNode('n3')
    ]
    await helper.load([fakeManagerModule, configNodeModule], flow)
    const n2 = helper.getNode('n2')

    n2.receive({ action: 'buildRecoveryCommand' })

    await waitUntil(() => n2.error.called)
    assert.strictEqual(n2.error.lastCall.args[0], 'MAC address not selected')
  })

  it('reports an error via done(err) when a synchronous action throws', async function () {
    // Regression: sync actions (listDevices, findAP, ...) used to run outside
    // any try/catch, so a thrown error would escape uncaught by this node's
    // own logic instead of going through done(err).
    const flow = [
      { id: 'n1', type: 'fake-manager' },
      { id: 'n2', type: 'tasmota-config', manager: 'n1', wires: [['n3']] },
      helperNode('n3')
    ]
    await helper.load([fakeManagerModule, configNodeModule], flow)
    const n1 = helper.getNode('n1')
    const n2 = helper.getNode('n2')
    n1.listDevices = () => { throw new Error('boom') }

    n2.receive({ action: 'listDevices' })

    await waitUntil(() => n2.error.called)
    assert.strictEqual(n2.error.lastCall.args[0].message, 'boom')
  })

  it('reports an error when no manager is configured', async function () {
    const flow = [
      { id: 'n2', type: 'tasmota-config', manager: '', wires: [['n3']] },
      helperNode('n3')
    ]
    await helper.load([fakeManagerModule, configNodeModule], flow)
    const n2 = helper.getNode('n2')

    n2.receive({ action: 'listDevices' })

    await waitUntil(() => n2.error.called)
    assert.strictEqual(n2.error.lastCall.args[0], 'Manager not found')
  })
})
