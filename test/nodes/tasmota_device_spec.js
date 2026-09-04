'use strict'

const assert = require('assert')
const { helper, setup, teardown } = require('../helpers/env')
const {
  mqttBrokerConfig, deviceConfig,
  connectClient, closeClient, publish, publishLwt, collectMessages
} = require('../helpers/flow')
const { waitUntil } = require('../helpers/wait')
const brokerNodeModule = require('../../nodes/mqtt_broker.js')
const deviceNodeModule = require('../../nodes/tasmota_device.js')

describe('tasmota-device node', function () {
  let broker

  beforeEach(async function () { broker = await setup() })
  afterEach(async function () { await teardown(broker) })

  // A minimal stand-in for a leaf node (tasmota-switch, tasmota-light, ...):
  // registering one is what makes tasmota-device actually connect to the
  // broker and subscribe to its topics (see tasmota_device.js register()).
  function registerFakeLeaf (device, type = 'tasmota-switch', idx = 0) {
    device.register({ id: `leaf-${type}-${idx}`, type, config: { idx } })
  }

  it('comes online on a retained LWT and requests STATUS 5 (no configured ip)', async function () {
    const flow = [
      mqttBrokerConfig('n1', broker.port),
      deviceConfig('n2', 'n1', 'plug01')
    ]
    await helper.load([brokerNodeModule, deviceNodeModule], flow)
    const device = helper.getNode('n2')

    // Register the leaf synchronously, right after the flow is loaded and
    // before any `await` runs: this mirrors real Node-RED deploys, where all
    // node constructors (incl. leaf nodes registering with their device) run
    // before the broker's async MQTT connect actually completes. The device
    // only ever receives onBrokerOnline() for users registered *before* the
    // broker node's 'connect' event fires (see mqtt_broker.js `client.on
    // ('connect', ...)` / `register()` - a late-registering device is never
    // notified and never subscribes - a real, timing-dependent bug, tracked
    // separately in CHANGELOG.md).
    registerFakeLeaf(device)

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    const cmndMessages = await collectMessages(client, 'cmnd/plug01/#')

    await waitUntil(() => device.brokerNode.connected === true)
    await publishLwt(client, 'plug01', true)

    await waitUntil(() => device.isOnline === true)
    await waitUntil(() => cmndMessages.some((m) => m.topic === 'cmnd/plug01/STATUS'))
    const statusMsg = cmndMessages.find((m) => m.topic === 'cmnd/plug01/STATUS')
    assert.strictEqual(statusMsg.payload, '5')

    await closeClient(client)
  })

  it('goes offline again on a retained LWT Offline', async function () {
    const flow = [
      mqttBrokerConfig('n1', broker.port),
      deviceConfig('n2', 'n1', 'plug02')
    ]
    await helper.load([brokerNodeModule, deviceNodeModule], flow)
    const device = helper.getNode('n2')
    registerFakeLeaf(device)
    await waitUntil(() => device.brokerNode.connected === true)

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))

    await publishLwt(client, 'plug02', true)
    await waitUntil(() => device.isOnline === true)

    await publishLwt(client, 'plug02', false)
    await waitUntil(() => device.isOnline === false)

    await closeClient(client)
  })

  it('routes an incoming stat/<device>/RESULT message to the right subscriber only', async function () {
    const flow = [
      mqttBrokerConfig('n1', broker.port),
      deviceConfig('n2', 'n1', 'plug03')
    ]
    await helper.load([brokerNodeModule, deviceNodeModule], flow)
    const device = helper.getNode('n2')
    registerFakeLeaf(device)
    await waitUntil(() => device.brokerNode.connected === true)

    const resultMsgs = []
    const otherMsgs = []
    device.mqttSubscribeStat(device, 'RESULT', (topic, payload) => resultMsgs.push(payload.toString()))
    device.mqttSubscribeStat(device, 'SOME_OTHER_COMMAND', (topic, payload) => otherMsgs.push(payload.toString()))

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    await publish(client, 'stat/plug03/RESULT', '{"POWER":"ON"}')

    await waitUntil(() => resultMsgs.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepStrictEqual(resultMsgs, ['{"POWER":"ON"}'])
    assert.deepStrictEqual(otherMsgs, [])

    await closeClient(client)
  })

  it('creates one distinct Power switch per shutter half (KNOWN BUG, see CHANGELOG)', async function () {
    // A tasmota-shutter node with idx N internally drives two relays/switches
    // (idx*2 and idx*2+1) through the Shutter helper class in
    // nodes/tasmota_device.js. Its constructor currently assigns
    // `this.switch1` twice by copy/paste instead of setting `this.switch2`
    // for the second one, so the first switch reference is lost.
    const flow = [
      mqttBrokerConfig('n1', broker.port),
      deviceConfig('n2', 'n1', 'shutter01')
    ]
    await helper.load([brokerNodeModule, deviceNodeModule], flow)
    const device = helper.getNode('n2')

    device.register({ id: 'leaf-shutter-0', type: 'tasmota-shutter', config: { idx: 0 } })
    // let the broker connection settle before the test (and teardown) moves
    // on - ending it while mqtt.js is still mid-handshake can leave aedes'
    // server.close() hanging waiting for that socket to finish.
    await waitUntil(() => device.brokerNode.connected === true)
    const shutter = device.shutters[0]

    assert.ok(shutter.switch1, 'switch1 should be set')
    assert.ok(shutter.switch2, 'switch2 should be set')
    assert.notStrictEqual(shutter.switch1, shutter.switch2, 'switch1 and switch2 must be different Power instances')
    assert.strictEqual(shutter.switch1, device.switches[0])
    assert.strictEqual(shutter.switch2, device.switches[1])
  })

  it('deregisters a leaf and drops the broker registration when the last user leaves', async function () {
    const flow = [
      mqttBrokerConfig('n1', broker.port),
      deviceConfig('n2', 'n1', 'plug04')
    ]
    await helper.load([brokerNodeModule, deviceNodeModule], flow)
    const device = helper.getNode('n2')
    const brokerNode = helper.getNode('n1')

    const leaf = { id: 'leaf-switch-0', type: 'tasmota-switch', config: { idx: 0 } }
    device.register(leaf)
    await waitUntil(() => device.brokerNode.connected === true)
    assert.strictEqual(brokerNode.users[device.id], device)

    device.deregister(leaf)
    assert.strictEqual(brokerNode.users[device.id], undefined)
  })
})
