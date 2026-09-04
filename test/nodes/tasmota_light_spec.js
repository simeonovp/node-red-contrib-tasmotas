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
const lightNodeModule = require('../../nodes/tasmota_light.js')

describe('tasmota-light node', function () {
  let broker

  beforeEach(async function () { broker = await setup() })
  afterEach(async function () { await teardown(broker) })

  function baseFlow (device, overrides = {}) {
    return [
      mqttBrokerConfig('n1', broker.port),
      deviceConfig('n2', 'n1', device),
      leafConfig('n3', 'tasmota-light', 'n2', Object.assign({ wires: [['n4']] }, overrides)),
      helperNode('n4')
    ]
  }

  async function connectAndCollectCmnd (device) {
    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    const received = []
    client.on('message', (topic, payload) => received.push({ topic, payload: payload.toString() }))
    await subscribe(client, `cmnd/${device}/#`)
    return { client, received }
  }

  it('publishes a POWER1 command for a plain boolean input', async function () {
    const flow = baseFlow('lt01')
    await helper.load([brokerNodeModule, deviceNodeModule, lightNodeModule], flow)
    const n3 = helper.getNode('n3')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)
    const { client, received } = await connectAndCollectCmnd('lt01')

    n3.receive({ payload: true })

    await waitUntil(() => received.some((m) => m.topic === 'cmnd/lt01/POWER1'))
    assert.strictEqual(received.find((m) => m.topic === 'cmnd/lt01/POWER1').payload, 'ON')

    await closeClient(client)
  })

  it('publishes a CT command for a mired-range ct input (KNOWN BUG, see CHANGELOG)', async function () {
    // onNodeInput() does `this.mqttCommand('CT', ct.toString())` for the
    // 153-500 (mired) branch, but `ct` is never defined there (it should be
    // `data.ct`) - this throws a ReferenceError instead of publishing.
    const flow = baseFlow('lt02')
    await helper.load([brokerNodeModule, deviceNodeModule, lightNodeModule], flow)
    const n3 = helper.getNode('n3')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)
    const { client, received } = await connectAndCollectCmnd('lt02')

    n3.receive({ topic: 'ct', payload: 300 })

    await waitUntil(() => received.some((m) => m.topic === 'cmnd/lt02/CT'))
    assert.strictEqual(received.find((m) => m.topic === 'cmnd/lt02/CT').payload, '300')

    await closeClient(client)
  })

  it('reads the per-key value from an object payload (KNOWN BUG, see CHANGELOG)', async function () {
    // onNodeInput() MODE 3 (object payload) iterates Object.entries(msg.payload)
    // but calls processCmd(key) without first setting msg.payload = value, so
    // every key ends up reading the *whole* payload object instead of its own
    // value - `{bright: 50}` never results in a `Dimmer 50` command.
    const flow = baseFlow('lt03')
    await helper.load([brokerNodeModule, deviceNodeModule, lightNodeModule], flow)
    const n3 = helper.getNode('n3')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)
    const { client, received } = await connectAndCollectCmnd('lt03')

    n3.receive({ payload: { bright: 50 } })

    await waitUntil(() => received.some((m) => m.topic === 'cmnd/lt03/Dimmer'))
    assert.strictEqual(received.find((m) => m.topic === 'cmnd/lt03/Dimmer').payload, '50')

    await closeClient(client)
  })

  it('updates the cache and forwards the combined status on stat/RESULT', async function () {
    const flow = baseFlow('lt04')
    await helper.load([brokerNodeModule, deviceNodeModule, lightNodeModule], flow)
    const n3 = helper.getNode('n3')
    const n4 = helper.getNode('n4')
    await waitUntil(() => n3.deviceNode.brokerNode.connected === true)

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    const received = []
    n4.on('input', (msg) => received.push(msg))

    await publish(client, 'stat/lt04/RESULT', JSON.stringify({ POWER: 'ON', Dimmer: 80 }))

    await waitUntil(() => received.length >= 1)
    assert.strictEqual(received[0].payload.on, true)

    await closeClient(client)
  })
})
