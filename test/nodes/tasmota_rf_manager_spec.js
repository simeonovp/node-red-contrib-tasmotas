'use strict'

const assert = require('assert')
const { helper } = require('../helpers/env')
const { waitUntil } = require('../helpers/wait')
const rfManagerNodeModule = require('../../nodes/tasmota_rf_manager.js')

// tasmota-rf-manager only needs a "manager" config node exposing
// getRf433Codes()/saveRf433Codes() and behaving like an EventEmitter (which
// every Node-RED node already is) - no MQTT/broker/filesystem needed here.
function fakeManagerModule (RED) {
  function FakeManager (config) {
    RED.nodes.createNode(this, config)
    this.rf433Data = { default: [] }
    this.saveCalls = 0
  }
  FakeManager.prototype.getRf433Codes = function () { return this.rf433Data }
  FakeManager.prototype.saveRf433Codes = function () { this.saveCalls++ }
  RED.nodes.registerType('fake-manager', FakeManager)
}

describe('tasmota-rf-manager node', function () {
  afterEach(async function () { await helper.unload() })

  function baseFlow (overrides = {}) {
    return [
      { id: 'n1', type: 'fake-manager' },
      Object.assign({ id: 'n2', type: 'tasmota-rf-manager', manager: 'n1', debounce: 0 }, overrides)
    ]
  }

  it('loads and links to the configured manager', async function () {
    await helper.load([fakeManagerModule, rfManagerNodeModule], baseFlow())
    const n2 = helper.getNode('n2')
    assert.strictEqual(n2.manager.id, 'n1')
  })

  it('emits a per-code event and remembers the first bridge as defaultBridge on rf-received', async function () {
    await helper.load([fakeManagerModule, rfManagerNodeModule], baseFlow())
    const n1 = helper.getNode('n1')
    const n2 = helper.getNode('n2')

    const events = []
    n2.on('ABCDEF', (msg) => events.push(msg))
    n1.emit('rf-received', 'bridge1', 12345, { Sync: 1, Low: 2, High: 3, Data: 'ABCDEF' })

    await waitUntil(() => events.length >= 1)
    assert.strictEqual(events[0].bridge, 'bridge1')
    assert.strictEqual(n2.defaultBridge, 'bridge1')
  })

  it('saveCodes()/getTimings() round-trip through the manager rf433 DB', async function () {
    await helper.load([fakeManagerModule, rfManagerNodeModule], baseFlow())
    const n1 = helper.getNode('n1')
    const n2 = helper.getNode('n2')

    n2.saveCodes('default', 'remote1', { ABCDEF: { name: 'on' } })
    assert.strictEqual(n1.saveCalls > 0, true)
    n2.saveTimings('default', 'remote1', { bridge1: { Sync: 1, Low: 2, High: 3 } })
    const timings = n2.getTimings('default', 'remote1')
    assert.deepStrictEqual(timings, { bridge1: { Sync: 1, Low: 2, High: 3 } })
  })

  it('removes its rf-received listener from the manager on close', async function () {
    await helper.load([fakeManagerModule, rfManagerNodeModule], baseFlow())
    const n1 = helper.getNode('n1')
    assert.strictEqual(n1.listenerCount('rf-received'), 1)

    await helper.unload()
    assert.strictEqual(n1.listenerCount('rf-received'), 0)
  })
})
