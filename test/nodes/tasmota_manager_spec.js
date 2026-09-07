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

  it('getDbDevices() does not crash on a brand-new install with no devices.json yet', async function () {
    const name = uniqueName('freshdb')
    const flow = [managerConfig('n1', { name })]
    await helper.load(managerNodeModule, flow)
    const n1 = helper.getNode('n1')

    assert.deepStrictEqual(n1.getDbDevices(), [])
  })

  it('does not shadow the inherited status() method', async function () {
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

  it('listRegisteredDevices() summarizes name/status/ap/ip of each registered device node', async function () {
    const name = uniqueName('listregistered')
    const flow = [managerConfig('n1', { name })]
    await helper.load(managerNodeModule, flow)
    const n1 = helper.getNode('n1')

    n1.registerDevice({ id: 'dev1', isOnline: true, ap: 'ap-livingroom', config: { name: 'Plug 1', ip: '10.0.0.5' } })
    n1.registerDevice({ id: 'dev2', isOnline: false, ap: '', config: { device: 'plug2', ip: '' } })

    assert.deepStrictEqual(n1.listRegisteredDevices(), [
      { id: 'dev1', name: 'Plug 1', online: true, ap: 'ap-livingroom', ip: '10.0.0.5' },
      { id: 'dev2', name: 'plug2', online: false, ap: '', ip: '' }
    ])
  })

  it('listRegisteredDevices() falls back to the AP BSSID only when its hostname could not be resolved', async function () {
    const name = uniqueName('apfallback')
    const flow = [managerConfig('n1', { name })]
    await helper.load(managerNodeModule, flow)
    const n1 = helper.getNode('n1')

    // ap (hostname) resolved -> takes priority over bssid
    n1.registerDevice({ id: 'dev1', isOnline: true, ap: 'ap-livingroom', bssid: 'AA:BB:CC:DD:EE:01', config: { name: 'Plug 1' } })
    // ap not resolved -> falls back to the raw bssid
    n1.registerDevice({ id: 'dev2', isOnline: true, ap: '', bssid: 'AA:BB:CC:DD:EE:02', config: { name: 'Plug 2' } })
    // neither known yet -> empty
    n1.registerDevice({ id: 'dev3', isOnline: false, config: { name: 'Plug 3' } })

    const byId = Object.fromEntries(n1.listRegisteredDevices().map((d) => [d.id, d.ap]))
    assert.deepStrictEqual(byId, {
      dev1: 'ap-livingroom',
      dev2: 'AA:BB:CC:DD:EE:02',
      dev3: ''
    })
  })

  it('exposes the registered devices over the editor admin API (GET /tasmota-manager/:id/devices)', async function () {
    const name = uniqueName('adminapi')
    const flow = [managerConfig('n1', { name })]
    await helper.load(managerNodeModule, flow)
    const n1 = helper.getNode('n1')
    n1.registerDevice({ id: 'dev1', isOnline: true, ap: 'ap1', config: { name: 'Plug 1', ip: '10.0.0.5' } })

    const res = await helper.request().get('/tasmota-manager/n1/devices')

    assert.strictEqual(res.status, 200)
    assert.deepStrictEqual(res.body, [
      { id: 'dev1', name: 'Plug 1', online: true, ap: 'ap1', ip: '10.0.0.5' }
    ])
  })

  it('returns 404 from the admin API for an unknown/non-manager id', async function () {
    const name = uniqueName('adminapi404')
    const flow = [managerConfig('n1', { name })]
    await helper.load(managerNodeModule, flow)

    const res = await helper.request().get('/tasmota-manager/does-not-exist/devices')

    assert.strictEqual(res.status, 404)
  })

  describe('buildRecoveryCommand()', function () {
    function seedDevice (n1, mac, ip, host = 'plug1') {
      n1.devicesDb.ensureData().devices.push({ mac, ip, host })
    }

    function writeCachedConfig (n1, ip, config) {
      fs.writeFileSync(path.join(n1.confdir, ip + '.json'), JSON.stringify(config))
    }

    it('builds a full Backlog command from the device\'s own cached config', async function () {
      const name = uniqueName('recoveryfull')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      seedDevice(n1, 'AA:BB:CC:DD:EE:01', '10.0.0.9')
      writeCachedConfig(n1, '10.0.0.9', {
        sta_ssid: ['myssid', ''],
        sta_pwd: ['mypass', ''],
        ip_address: ['10.0.0.9', '10.0.0.1', '255.255.255.0', '8.8.8.8', '8.8.4.4']
      })

      const result = n1.buildRecoveryCommand('AA:BB:CC:DD:EE:01')

      assert.strictEqual(result.found, true)
      assert.strictEqual(result.usedFallbackCredentials, false)
      assert.strictEqual(result.hasStaticIp, true)
      assert.strictEqual(result.command, 'Backlog SSId1 myssid;Password1 mypass;IpAddress1 10.0.0.9;IpAddress2 10.0.0.1;IpAddress3 255.255.255.0;IpAddress4 8.8.8.8;IpAddress5 8.8.4.4;Restart 1')
      assert.strictEqual(result.url, 'http://192.168.4.1/cm?cmnd=' + encodeURIComponent(result.command))
    })

    it('falls back to the manager-level password when the cached config has none', async function () {
      const name = uniqueName('recoverypwfallback')
      const flow = [managerConfig('n1', { name, ssid: 'fallbackssid', password: 'fallbackpass' })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      seedDevice(n1, 'AA:BB:CC:DD:EE:02', '10.0.0.10')
      writeCachedConfig(n1, '10.0.0.10', {
        sta_ssid: ['myssid', ''],
        sta_pwd: ['', ''],
        ip_address: ['10.0.0.10', '10.0.0.1', '255.255.255.0', '8.8.8.8']
      })

      const result = n1.buildRecoveryCommand('AA:BB:CC:DD:EE:02')

      assert.strictEqual(result.usedFallbackCredentials, true)
      assert.ok(result.command.includes('SSId1 myssid;Password1 fallbackpass'))
    })

    it('falls back to manager-level ssid/password and omits IpAddress when no cached config exists', async function () {
      const name = uniqueName('recoverynocache')
      const flow = [managerConfig('n1', { name, ssid: 'fallbackssid', password: 'fallbackpass' })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      seedDevice(n1, 'AA:BB:CC:DD:EE:03', '10.0.0.11')

      const result = n1.buildRecoveryCommand('AA:BB:CC:DD:EE:03')

      assert.strictEqual(result.usedFallbackCredentials, true)
      assert.strictEqual(result.hasStaticIp, false)
      assert.strictEqual(result.command, 'Backlog SSId1 fallbackssid;Password1 fallbackpass;Restart 1')
    })

    it('omits IpAddress when the cached config was on DHCP', async function () {
      const name = uniqueName('recoverydhcp')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      seedDevice(n1, 'AA:BB:CC:DD:EE:04', '10.0.0.12')
      writeCachedConfig(n1, '10.0.0.12', {
        sta_ssid: ['myssid', ''],
        sta_pwd: ['mypass', ''],
        ip_address: ['0.0.0.0', '0.0.0.0', '0.0.0.0', '0.0.0.0']
      })

      const result = n1.buildRecoveryCommand('AA:BB:CC:DD:EE:04')

      assert.strictEqual(result.hasStaticIp, false)
      assert.strictEqual(result.command, 'Backlog SSId1 myssid;Password1 mypass;Restart 1')
    })

    it('returns found:false for an unknown MAC without throwing', async function () {
      const name = uniqueName('recoveryunknown')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      const result = n1.buildRecoveryCommand('00:00:00:00:00:00')

      assert.deepStrictEqual(result, { found: false, mac: '00:00:00:00:00:00' })
    })
  })
})
