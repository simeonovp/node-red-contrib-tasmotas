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
const buttonNodeModule = require('../../nodes/tasmota_button.js')

describe('tasmota-button node', function () {
  let broker

  beforeEach(async function () { broker = await setup() })
  afterEach(async function () { await teardown(broker) })

  function baseFlow (device) {
    return [
      mqttBrokerConfig('n1', broker.port),
      deviceConfig('n2', 'n1', device),
      leafConfig('n3', 'tasmota-button', 'n2', { idx: 0, wires: [['n4']] }),
      helperNode('n4')
    ]
  }

  it('loads correctly', async function () {
    const flow = baseFlow('bt01')
    await helper.load([brokerNodeModule, deviceNodeModule, buttonNodeModule], flow)
    const n3 = helper.getNode('n3')
    assert.strictEqual(n3.type, 'tasmota-button')
  })

  it('forwards a Button1 SINGLE action from stat/RESULT for its own channel only', async function () {
    const flow = baseFlow('bt02')
    await helper.load([brokerNodeModule, deviceNodeModule, buttonNodeModule], flow)
    const n3 = helper.getNode('n3')
    const n4 = helper.getNode('n4')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    const received = []
    n4.on('input', (msg) => received.push(msg))

    // channel 2 (a different idx) must be ignored by our idx:0 node
    await publish(client, 'stat/bt02/RESULT', JSON.stringify({ Button2: { Action: 'SINGLE' } }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.strictEqual(received.length, 0)

    await publish(client, 'stat/bt02/RESULT', JSON.stringify({ Button1: { Action: 'SINGLE' } }))
    await waitUntil(() => received.length >= 1)
    assert.strictEqual(received[0].topic, 'button1')
    assert.strictEqual(received[0].payload, 'SINGLE')

    await closeClient(client)
  })
})
