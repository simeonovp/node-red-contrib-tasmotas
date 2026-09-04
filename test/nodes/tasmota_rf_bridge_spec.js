'use strict'

const assert = require('assert')
const { helper, setup, teardown } = require('../helpers/env')
const {
  mqttBrokerConfig, deviceConfig, leafConfig, helperNode,
  connectClient, closeClient, publish
} = require('../helpers/flow')
const { waitUntil } = require('../helpers/wait')
const brokerNodeModule = require('../../nodes/mqtt_broker.js')
const deviceNodeModule = require('../../nodes/tasmota_device.js')
const rfBridgeNodeModule = require('../../nodes/tasmota_rf_bridge.js')

function fakeRfManagerModule (RED) {
  function FakeRfManager (config) {
    RED.nodes.createNode(this, config)
    this.sendCalls = []
  }
  FakeRfManager.prototype.sendRfCode = function (bridge, timings, code) { this.sendCalls.push({ bridge, timings, code }) }
  RED.nodes.registerType('fake-rf-manager', FakeRfManager)
}

describe('tasmota-rf-bridge node', function () {
  let broker

  beforeEach(async function () { broker = await setup() })
  afterEach(async function () { await teardown(broker) })

  function baseFlow (device) {
    return [
      mqttBrokerConfig('n1', broker.port),
      deviceConfig('n2', 'n1', device),
      { id: 'n0', type: 'fake-rf-manager' },
      leafConfig('n3', 'tasmota-rf-bridge', 'n2', { manager: 'n0', canReceive: true, wires: [['n4']] }),
      helperNode('n4')
    ]
  }

  it('loads correctly', async function () {
    const flow = baseFlow('rfb01')
    await helper.load([brokerNodeModule, deviceNodeModule, fakeRfManagerModule, rfBridgeNodeModule], flow)
    const n3 = helper.getNode('n3')
    assert.strictEqual(n3.type, 'tasmota-rf-bridge')
  })

  it('forwards a decoded RfReceived payload from tele/RESULT', async function () {
    const flow = baseFlow('rfb02')
    await helper.load([brokerNodeModule, deviceNodeModule, fakeRfManagerModule, rfBridgeNodeModule], flow)
    const n3 = helper.getNode('n3')
    const n4 = helper.getNode('n4')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    const received = []
    n4.on('input', (msg) => received.push(msg))

    const payload = { Time: '2023-01-08T07:20:34', RfReceived: { Sync: 1, Low: 2, High: 3, Data: 'ABCDEF' } }
    await publish(client, 'tele/rfb02/RESULT', JSON.stringify(payload))

    await waitUntil(() => received.length >= 1)
    assert.strictEqual(received[0].data, 'ABCDEF')

    await closeClient(client)
  })

  it('asks the manager to send an RF code for a timed input message', async function () {
    const flow = baseFlow('rfb03')
    await helper.load([brokerNodeModule, deviceNodeModule, fakeRfManagerModule, rfBridgeNodeModule], flow)
    const n0 = helper.getNode('n0')
    const n3 = helper.getNode('n3')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)

    n3.receive({ timings: { Sync: 1, Low: 2, High: 3 }, payload: 'ABCDEF' })

    await waitUntil(() => n0.sendCalls.length >= 1)
    assert.strictEqual(n0.sendCalls[0].bridge, 'rfb03')
    assert.strictEqual(n0.sendCalls[0].code, 'ABCDEF')
  })
})
