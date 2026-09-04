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
