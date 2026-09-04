'use strict'

const assert = require('assert')
const { helper, setup, teardown } = require('../helpers/env')
const {
  mqttBrokerConfig, deviceConfig, leafConfig, helperNode,
  connectClient, closeClient, publish, subscribe
} = require('../helpers/flow')
const { waitUntil } = require('../helpers/wait')
const brokerNodeModule = require('../../nodes/mqtt_broker.js')
const deviceNodeModule = require('../../nodes/tasmota_device.js')
const switchNodeModule = require('../../nodes/tasmota_switch.js')

describe('tasmota-switch node', function () {
  let broker

  beforeEach(async function () { broker = await setup() })
  afterEach(async function () { await teardown(broker) })

  function baseFlow (device) {
    return [
      mqttBrokerConfig('n1', broker.port),
      deviceConfig('n2', 'n1', device),
      leafConfig('n3', 'tasmota-switch', 'n2', { idx: 0, wires: [['n4']] }),
      helperNode('n4')
    ]
  }

  it('loads with the configured name and device link', async function () {
    const flow = baseFlow('sw01')
    await helper.load([brokerNodeModule, deviceNodeModule, switchNodeModule], flow)
    const n3 = helper.getNode('n3')
    assert.strictEqual(n3.type, 'tasmota-switch')
    assert.strictEqual(n3.deviceNode.id, 'n2')
  })

  it('forwards an incoming stat/POWER as an on/off message and updates status', async function () {
    const flow = baseFlow('sw02')
    await helper.load([brokerNodeModule, deviceNodeModule, switchNodeModule], flow)
    const n3 = helper.getNode('n3')
    const n4 = helper.getNode('n4')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))

    const received = []
    n4.on('input', (msg) => received.push(msg))
    await publish(client, 'stat/sw02/POWER', 'ON')

    await waitUntil(() => received.length >= 1)
    assert.strictEqual(received[0].payload, true)
    assert.strictEqual(n3.switch.lastValue, true)

    await closeClient(client)
  })

  it('publishes a POWER command when it receives a boolean input', async function () {
    const flow = baseFlow('sw03')
    await helper.load([brokerNodeModule, deviceNodeModule, switchNodeModule], flow)
    const n3 = helper.getNode('n3')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    const received = []
    client.on('message', (topic, payload) => received.push({ topic, payload: payload.toString() }))
    await subscribe(client, 'cmnd/sw03/#')

    n3.receive({ payload: true })

    await waitUntil(() => received.some((m) => m.topic === 'cmnd/sw03/POWER1'))
    const cmd = received.find((m) => m.topic === 'cmnd/sw03/POWER1')
    assert.strictEqual(cmd.payload, 'ON')

    await closeClient(client)
  })
})
