'use strict'

const assert = require('assert')
const { helper, setup, teardown } = require('../helpers/env')
const {
  mqttBrokerConfig, deviceConfig, leafConfig, helperNode,
  connectClient, closeClient, publish, publishLwt, subscribe
} = require('../helpers/flow')
const { waitUntil } = require('../helpers/wait')
const brokerNodeModule = require('../../nodes/mqtt_broker.js')
const deviceNodeModule = require('../../nodes/tasmota_device.js')
const shutterNodeModule = require('../../nodes/tasmota_shutter.js')

describe('tasmota-shutter node', function () {
  let broker

  beforeEach(async function () { broker = await setup() })
  afterEach(async function () { await teardown(broker) })

  function baseFlow (device) {
    return [
      mqttBrokerConfig('n1', broker.port),
      deviceConfig('n2', 'n1', device),
      leafConfig('n3', 'tasmota-shutter', 'n2', { idx: 0, wires: [['n4']] }),
      helperNode('n4')
    ]
  }

  it('loads and links to its Shutter helper on the device node', async function () {
    const flow = baseFlow('sh01')
    await helper.load([brokerNodeModule, deviceNodeModule, shutterNodeModule], flow)
    const n3 = helper.getNode('n3')
    assert.strictEqual(n3.type, 'tasmota-shutter')
    assert.strictEqual(n3.shutter, n3.deviceNode.shutters[0])
  })

  it('publishes a ShutterPosition command for a position input', async function () {
    const flow = baseFlow('sh02')
    await helper.load([brokerNodeModule, deviceNodeModule, shutterNodeModule], flow)
    const n3 = helper.getNode('n3')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    const received = []
    client.on('message', (topic, payload) => received.push({ topic, payload: payload.toString() }))
    await subscribe(client, 'cmnd/sh02/#')

    n3.receive({ topic: 'position', payload: 42 })

    await waitUntil(() => received.some((m) => m.topic === 'cmnd/sh02/ShutterPosition1'))
    const cmd = received.find((m) => m.topic === 'cmnd/sh02/ShutterPosition1')
    assert.strictEqual(cmd.payload, '42')

    await closeClient(client)
  })

  it('reports an updated position from stat/RESULT and sets status to Open at 100%', async function () {
    const flow = baseFlow('sh03')
    await helper.load([brokerNodeModule, deviceNodeModule, shutterNodeModule], flow)
    const n3 = helper.getNode('n3')
    const n4 = helper.getNode('n4')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    const received = []
    n4.on('input', (msg) => received.push(msg))

    await publish(client, 'stat/sh03/RESULT', JSON.stringify({ Shutter1: { Position: 100, Direction: 0, Target: 100 } }))

    await waitUntil(() => received.length >= 1)
    assert.strictEqual(received[0].payload, 100)

    await closeClient(client)
  })

  it('shows a green Open/Closed status at the end stops', async function () {
    const flow = baseFlow('sh04')
    await helper.load([brokerNodeModule, deviceNodeModule, shutterNodeModule], flow)
    const n3 = helper.getNode('n3')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    await publishLwt(client, 'sh04', true)
    await waitUntil(() => n3.deviceNode.isOnline === true)
    n3.status.resetHistory()

    await publish(client, 'stat/sh04/RESULT', JSON.stringify({ Shutter1: { Position: 100, Direction: 0, Target: 100 } }))
    await waitUntil(() => n3.status.called)

    const lastStatus = n3.status.lastCall.args[0]
    assert.strictEqual(lastStatus.fill, 'green')
    assert.strictEqual(lastStatus.text, 'Closed')

    await closeClient(client)
  })
})
