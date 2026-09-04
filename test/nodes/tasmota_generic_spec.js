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
const genericNodeModule = require('../../nodes/tasmota_generic.js')

describe('tasmota-generic node', function () {
  let broker

  beforeEach(async function () { broker = await setup() })
  afterEach(async function () { await teardown(broker) })

  function baseFlow (device, overrides = {}) {
    return [
      mqttBrokerConfig('n1', broker.port),
      deviceConfig('n2', 'n1', device),
      leafConfig('n3', 'tasmota-generic', 'n2', Object.assign({ wires: [['n4']] }, overrides)),
      helperNode('n4')
    ]
  }

  it('forwards a stat/RESULT payload as {topic, payload}', async function () {
    const flow = baseFlow('gn01')
    await helper.load([brokerNodeModule, deviceNodeModule, genericNodeModule], flow)
    const n3 = helper.getNode('n3')
    const n4 = helper.getNode('n4')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    const received = []
    n4.on('input', (msg) => received.push(msg))

    await publish(client, 'stat/gn01/RESULT', JSON.stringify({ POWER: 'ON' }))

    await waitUntil(() => received.length >= 1)
    assert.strictEqual(received[0].topic, 'stat/gn01/RESULT')
    assert.deepStrictEqual(received[0].payload, { POWER: 'ON' })

    await closeClient(client)
  })

  it('sends a raw "CMD param" string input as an MQTT command', async function () {
    const flow = baseFlow('gn02')
    await helper.load([brokerNodeModule, deviceNodeModule, genericNodeModule], flow)
    const n3 = helper.getNode('n3')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    const received = []
    client.on('message', (topic, payload) => received.push({ topic, payload: payload.toString() }))
    await subscribe(client, 'cmnd/gn02/#')

    n3.receive({ payload: 'Dimmer 55' })

    await waitUntil(() => received.some((m) => m.topic === 'cmnd/gn02/Dimmer'))
    assert.strictEqual(received.find((m) => m.topic === 'cmnd/gn02/Dimmer').payload, '55')

    await closeClient(client)
  })
})
