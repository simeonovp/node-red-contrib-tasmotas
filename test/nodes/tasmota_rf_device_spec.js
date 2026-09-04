'use strict'

const assert = require('assert')
const { helper } = require('../helpers/env')
const { waitUntil } = require('../helpers/wait')
const rfDeviceNodeModule = require('../../nodes/tasmota_rf_device.js')

// tasmota-rf-device only needs a "manager" config node behaving like a
// tasmota-rf-manager (EventEmitter + saveCodes/getTimings/sendRfCode) - no
// MQTT/broker needed for these tests.
function fakeRfManagerModule (RED) {
  function FakeRfManager (config) {
    RED.nodes.createNode(this, config)
    this.defaultBridge = 'bridge1'
    this.sendCalls = []
  }
  FakeRfManager.prototype.saveCodes = function () {}
  FakeRfManager.prototype.getTimings = function () { return { bridge1: { Sync: 1, Low: 2, High: 3 } } }
  FakeRfManager.prototype.sendRfCode = function (bridge, timings, code) { this.sendCalls.push({ bridge, timings, code }) }
  RED.nodes.registerType('fake-rf-manager', FakeRfManager)
}

const codes = JSON.stringify({ ABCDEF: { name: 'on' }, 123456: { name: 'off' } })

describe('tasmota-rf-device node', function () {
  afterEach(async function () { await helper.unload() })

  function baseFlow (overrides = {}) {
    return [
      { id: 'n1', type: 'fake-rf-manager' },
      Object.assign({ id: 'n2', type: 'tasmota-rf-device', manager: 'n1', group: 'default', name: 'remote1', codes, canReceive: true, wires: [['n3']] }, overrides),
      { id: 'n3', type: 'helper' }
    ]
  }

  it('loads and parses its configured codes', async function () {
    await helper.load([fakeRfManagerModule, rfDeviceNodeModule], baseFlow())
    const n2 = helper.getNode('n2')
    assert.deepStrictEqual(n2.codes, { ABCDEF: { name: 'on' }, 123456: { name: 'off' } })
    assert.strictEqual(n2.lastBridge, 'bridge1')
  })

  it('sends the matching RF code via the manager for a name payload', async function () {
    await helper.load([fakeRfManagerModule, rfDeviceNodeModule], baseFlow())
    const n1 = helper.getNode('n1')
    const n2 = helper.getNode('n2')

    n2.receive({ payload: 'on' })

    await waitUntil(() => n1.sendCalls.length >= 1)
    assert.strictEqual(n1.sendCalls[0].bridge, 'bridge1')
    assert.strictEqual(n1.sendCalls[0].code, 'ABCDEF')
  })

  it('forwards a received RF event resolved to its configured name', async function () {
    await helper.load([fakeRfManagerModule, rfDeviceNodeModule], baseFlow())
    const n1 = helper.getNode('n1')
    const n3 = helper.getNode('n3')

    const received = []
    n3.on('input', (msg) => received.push(msg))
    n1.emit('ABCDEF', { bridge: 'bridge1', time: 123, data: { Data: 'ABCDEF', Sync: 1, Low: 2, High: 3 } })

    await waitUntil(() => received.length >= 1)
    assert.strictEqual(received[0].payload, 'on')
  })

  it('throws constructing lastBridge when the configured manager id is stale (KNOWN BUG, see CHANGELOG)', async function () {
    // `const manager = config.manager && RED.nodes.getNode(config.manager)`
    // is `undefined` (not '') when config.manager is a *non-empty* id that
    // no longer resolves to a node (e.g. the manager was deleted). The next
    // line, `bridgeTopic || manager.defaultBridge || ''`, then throws
    // because it doesn't use optional chaining like the other `manager?.`
    // call sites in this file do.
    const flow = baseFlow({ manager: 'stale-id-does-not-exist' })
    let threw = false
    try {
      await helper.load([fakeRfManagerModule, rfDeviceNodeModule], flow)
    } catch (err) {
      threw = true
    }
    // Node-RED's runtime catches constructor exceptions per-node rather than
    // rejecting the whole flow load, so a failed construction can show up
    // either as a rejected load() or as the node simply never registering.
    const n2 = helper.getNode('n2')
    assert.ok(threw || !n2, 'expected the node to fail to construct due to the stale manager reference')
  })

  it('removes its per-code listeners from the manager on close (KNOWN BUG, see CHANGELOG)', async function () {
    // Same class of bug as tasmota-rf-manager: close() removes a freshly
    // bound function instead of the one passed to addListener() in the
    // constructor, so the listeners for each configured code are never
    // actually removed.
    await helper.load([fakeRfManagerModule, rfDeviceNodeModule], baseFlow())
    const n1 = helper.getNode('n1')
    assert.strictEqual(n1.listenerCount('ABCDEF'), 1)
    assert.strictEqual(n1.listenerCount('123456'), 1)

    await helper.unload()
    assert.strictEqual(n1.listenerCount('ABCDEF'), 0)
    assert.strictEqual(n1.listenerCount('123456'), 0)
  })
})
