'use strict'

const assert = require('assert')
const { helper, setup, teardown } = require('../helpers/env')
const { mqttBrokerConfig, fakeBrokerUser, connectClient, closeClient, publish } = require('../helpers/flow')
const { waitUntil } = require('../helpers/wait')
const brokerNodeModule = require('../../nodes/mqtt_broker.js')

describe('tasmota-mqtt-broker node', function () {
  let broker

  beforeEach(async function () { broker = await setup() })
  afterEach(async function () { await teardown(broker) })

  it('connects to the configured MQTT broker', async function () {
    const flow = [mqttBrokerConfig('n1', broker.port)]
    await helper.load(brokerNodeModule, flow)
    const n1 = helper.getNode('n1')
    await waitUntil(() => n1.connected === true)
    assert.strictEqual(n1.connected, true)
  })

  it('only dispatches messages on subscriptions whose topic pattern matches (matchTopic)', async function () {
    const flow = [mqttBrokerConfig('n1', broker.port)]
    await helper.load(brokerNodeModule, flow)
    const n1 = helper.getNode('n1')
    await waitUntil(() => n1.connected === true)

    const received = []
    const fakeDevice = fakeBrokerUser('dev1')
    n1.register(fakeDevice)
    n1.subscribe(fakeDevice, 'tasmota/+/tele/SENSOR', 0, (topic, payload) => {
      received.push(topic)
    })

    const client = connectClient(broker.port)
    await new Promise((resolve) => client.on('connect', resolve))
    await publish(client, 'tasmota/dev1/tele/SENSOR', 'match-1')
    await publish(client, 'tasmota/dev1/tele/STATE', 'no-match')
    await publish(client, 'tasmota/dev1/dev2/tele/SENSOR', 'no-match-extra-level')

    await waitUntil(() => received.length >= 1)
    // give a moment to make sure no extra (wrong) messages arrive
    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.deepStrictEqual(received, ['tasmota/dev1/tele/SENSOR'])
    await closeClient(client)
  })

  it('deregisters a user and forwards broker online/offline transitions', async function () {
    const flow = [mqttBrokerConfig('n1', broker.port)]
    await helper.load(brokerNodeModule, flow)
    const n1 = helper.getNode('n1')
    await waitUntil(() => n1.connected === true)

    const events = []
    const fakeDevice = fakeBrokerUser('dev1', {
      onBrokerOnline: () => events.push('online'),
      onBrokerOffline: () => events.push('offline'),
      onBrokerConnecting: () => events.push('connecting')
    })
    n1.register(fakeDevice)
    assert.strictEqual(n1.users[fakeDevice.id], fakeDevice)
    n1.deregister(fakeDevice)
    assert.strictEqual(n1.users[fakeDevice.id], undefined)
  })
})
