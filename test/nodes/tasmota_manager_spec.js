'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { helper } = require('../helpers/env')
const { managerConfig } = require('../helpers/flow')
const managerNodeModule = require('../../nodes/tasmota_manager.js')

// tasmota-manager writes a local resources/<name> cache on disk (device DB,
// mqtt map, downloaded configs/icons). No dbUri is set in these tests, so it
// never reaches out over the network - but it does touch the filesystem, so
// each test uses a unique name and the folder is removed afterwards.
const resourcesRoot = path.resolve(path.join(__dirname, '../../resources'))

describe('tasmota-manager node', function () {
  const usedNames = []

  afterEach(async function () {
    await helper.unload()
    for (const name of usedNames.splice(0)) {
      fs.rmSync(path.join(resourcesRoot, name), { recursive: true, force: true })
    }
  })

  function uniqueName (label) {
    const name = `__test_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    usedNames.push(name)
    return name
  }

  it('loads and creates its resource cache folder', async function () {
    const name = uniqueName('load')
    const flow = [managerConfig('n1', { name })]
    await helper.load(managerNodeModule, flow)
    const n1 = helper.getNode('n1')

    assert.strictEqual(fs.existsSync(path.join(resourcesRoot, name, 'configs')), true)
    assert.deepStrictEqual(n1.listDevices(), [])
  })

  it('getDbDevices() does not crash on a brand-new install with no devices.json yet (NEW BUG found via this test, see CHANGELOG)', async function () {
    // DbBase#load() sets `this.data = {}` (no `.devices` array) when the
    // backing file does not exist yet, but getDbDevices() does
    // `this.dbDevices['devices'].filter(...)` unconditionally - a fresh
    // install (no resources/<name>/devices.json yet) throws a TypeError
    // instead of returning an empty list.
    const name = uniqueName('freshdb')
    const flow = [managerConfig('n1', { name })]
    await helper.load(managerNodeModule, flow)
    const n1 = helper.getNode('n1')

    assert.deepStrictEqual(n1.getDbDevices(), [])
  })

  it('overwrites the inherited status() method with a plain string (NEW BUG found via this test, see CHANGELOG)', async function () {
    // The constructor does `this.status = 'unconfigured'`, shadowing the
    // Node-RED Node.prototype.status() function every node relies on to show
    // its status dot/text in the editor - calling n.status(...) after this
    // throws "n.status is not a function".
    const name = uniqueName('status')
    const flow = [managerConfig('n1', { name })]
    await helper.load(managerNodeModule, flow)
    const n1 = helper.getNode('n1')

    assert.strictEqual(typeof n1.status, 'function')
  })

  it('registerDevice() adds a new entry to the devices DB keyed by ip', async function () {
    const name = uniqueName('register')
    const flow = [managerConfig('n1', { name })]
    await helper.load(managerNodeModule, flow)
    const n1 = helper.getNode('n1')

    n1.registerDevice({ id: 'dev1', config: { ip: '10.0.0.5', host: 'plug1', name: 'Plug 1', version: 1 } })

    const devices = n1.getDbDevices()
    assert.strictEqual(devices.length, 1)
    assert.strictEqual(devices[0].ip, '10.0.0.5')
    assert.strictEqual(devices[0].host, 'plug1')
  })
})
