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
const sensorNodeModule = require('../../nodes/tasmota_sensor.js')

describe('tasmota-sensor node', function () {
  let broker

  beforeEach(async function () { broker = await setup() })
  afterEach(async function () { await teardown(broker) })

  function baseFlow (device, overrides = {}) {
    return [
      mqttBrokerConfig('n1', broker.port),
      deviceConfig('n2', 'n1', device),
      leafConfig('n3', 'tasmota-sensor', 'n2', Object.assign({ wires: [['n4']] }, overrides)),
      helperNode('n4')
    ]
  }

  it('loads correctly', async function () {
    const flow = baseFlow('sn01')
    await helper.load([brokerNodeModule, deviceNodeModule, sensorNodeModule], flow)
    const n3 = helper.getNode('n3')
    assert.strictEqual(n3.type, 'tasmota-sensor')
  })

  it('forwards a tele/SENSOR payload as-is when no rules are configured', async function () {
    const flow = baseFlow('sn02')
    await helper.load([brokerNodeModule, deviceNodeModule, sensorNodeModule], flow)
    const n3 = helper.getNode('n3')
    const n4 = helper.getNode('n4')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    const received = []
    n4.on('input', (msg) => received.push(msg))

    const payload = { Time: '2023-01-08T07:20:34', AM2301: { Temperature: 21.5, Humidity: 44.0 } }
    await publish(client, 'tele/sn02/SENSOR', JSON.stringify(payload))

    await waitUntil(() => received.length >= 1)
    assert.deepStrictEqual(received[0].payload, payload)

    await closeClient(client)
  })

  it('re-requests sensor data (STATUS 8) on any node input', async function () {
    const flow = baseFlow('sn03')
    await helper.load([brokerNodeModule, deviceNodeModule, sensorNodeModule], flow)
    const n3 = helper.getNode('n3')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    const received = []
    client.on('message', (topic, payload) => received.push({ topic, payload: payload.toString() }))
    await subscribe(client, 'cmnd/sn03/#')

    n3.receive({})

    await waitUntil(() => received.some((m) => m.topic === 'cmnd/sn03/STATUS'))
    assert.strictEqual(received.find((m) => m.topic === 'cmnd/sn03/STATUS').payload, '8')

    await closeClient(client)
  })
})
