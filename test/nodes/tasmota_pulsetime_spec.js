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
const pulseTimeNodeModule = require('../../nodes/tasmota_pulsetime.js')

describe('tasmota-pulsetime node', function () {
  let broker

  beforeEach(async function () { broker = await setup() })
  afterEach(async function () { await teardown(broker) })

  function baseFlow (device) {
    return [
      mqttBrokerConfig('n1', broker.port),
      deviceConfig('n2', 'n1', device),
      leafConfig('n3', 'tasmota-pulsetime', 'n2', { idx: 0, wires: [['n4'], ['n5']] }),
      helperNode('n4'),
      helperNode('n5')
    ]
  }

  it('loads and marks the underlying switch as supporting PulseTime', async function () {
    const flow = baseFlow('pt01')
    await helper.load([brokerNodeModule, deviceNodeModule, pulseTimeNodeModule], flow)
    const n3 = helper.getNode('n3')
    assert.strictEqual(n3.type, 'tasmota-pulsetime')
    assert.strictEqual(n3.switch.supportPulseTime, true)
  })

  it('publishes a PulseTime command (seconds encoded per Tasmota rules) on input', async function () {
    const flow = baseFlow('pt02')
    await helper.load([brokerNodeModule, deviceNodeModule, pulseTimeNodeModule], flow)
    const n3 = helper.getNode('n3')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    const received = []
    client.on('message', (topic, payload) => received.push({ topic, payload: payload.toString() }))
    await subscribe(client, 'cmnd/pt02/#')

    n3.receive({ payload: 30 }) // 30s -> Tasmota encodes as (30+100) for values > 11s

    await waitUntil(() => received.some((m) => m.topic === 'cmnd/pt02/PulseTime1'))
    const cmd = received.find((m) => m.topic === 'cmnd/pt02/PulseTime1')
    assert.strictEqual(cmd.payload, '130')

    await closeClient(client)
  })

  it('forwards a PulseTime.Set update from stat/RESULT as a timeout message', async function () {
    const flow = baseFlow('pt03')
    await helper.load([brokerNodeModule, deviceNodeModule, pulseTimeNodeModule], flow)
    const n3 = helper.getNode('n3')
    const n4 = helper.getNode('n4')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    const received = []
    n4.on('input', (msg) => received.push(msg))

    await publish(client, 'stat/pt03/RESULT', JSON.stringify({ PulseTime1: { Set: 130, Remaining: 0 } }))

    await waitUntil(() => received.length >= 1)
    assert.strictEqual(received[0].payload, 30)

    await closeClient(client)
  })
})
