'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { helper } = require('../helpers/env')
const { managerConfig } = require('../helpers/flow')
const managerNodeModule = require('../../nodes/tasmota_manager.js')
const { NetHelper } = require('../../nodes/lib/utils.js')

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

  function seedDevice (n1, mac, ip, host = 'plug1') {
    n1.devicesDb.ensureData().devices.push({ mac, ip, host })
  }

  function writeCachedConfig (n1, ip, config) {
    fs.writeFileSync(path.join(n1.confdir, ip + '.json'), JSON.stringify(config))
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
      assert.strictEqual(result.alreadyKnown, true)
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

    it('prefers explicit overrides over both the cached config and the manager-level fallback', async function () {
      const name = uniqueName('recoveryoverride')
      const flow = [managerConfig('n1', { name, ssid: 'managerssid', password: 'managerpass' })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      seedDevice(n1, 'AA:BB:CC:DD:EE:06', '10.0.0.20')
      writeCachedConfig(n1, '10.0.0.20', {
        sta_ssid: ['cachedssid', ''],
        sta_pwd: ['cachedpass', ''],
        ip_address: ['10.0.0.20', '10.0.0.1', '255.255.255.0', '8.8.8.8']
      })

      const result = n1.buildRecoveryCommand('AA:BB:CC:DD:EE:06', {
        ssid: 'overridessid', password: 'overridepass', ip: '10.0.0.99', gateway: '10.0.0.254', mask: '255.255.0.0'
      })

      assert.strictEqual(result.usedFallbackCredentials, false)
      assert.strictEqual(
        result.command,
        'Backlog SSId1 overridessid;Password1 overridepass;IpAddress1 10.0.0.99;IpAddress2 10.0.0.254;IpAddress3 255.255.0.0;IpAddress4 8.8.8.8;Restart 1'
      )
    })

    it('mixes a partial override (ip/gateway only) with the remaining fields from the cached config', async function () {
      const name = uniqueName('recoverypartialoverride')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      seedDevice(n1, 'AA:BB:CC:DD:EE:07', '10.0.0.21')
      writeCachedConfig(n1, '10.0.0.21', {
        sta_ssid: ['cachedssid', ''],
        sta_pwd: ['cachedpass', ''],
        ip_address: ['10.0.0.21', '10.0.0.1', '255.255.255.0', '8.8.8.8']
      })

      const result = n1.buildRecoveryCommand('AA:BB:CC:DD:EE:07', { ip: '10.0.0.50', gateway: '10.0.0.253' })

      assert.strictEqual(
        result.command,
        'Backlog SSId1 cachedssid;Password1 cachedpass;IpAddress1 10.0.0.50;IpAddress2 10.0.0.253;IpAddress3 255.255.255.0;IpAddress4 8.8.8.8;Restart 1'
      )
    })

    it('builds a command for a brand-new device (no DB row, no cache) purely from overrides', async function () {
      // Regression: buildRecoveryCommand() used to bail out with {found:false}
      // for any MAC not already in the device DB, before even looking at
      // overrides - which made first-time setup of a brand-new device
      // (never in the DB, no cached config) impossible no matter what was
      // passed in.
      const name = uniqueName('recoverynewdevice')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      const result = n1.buildRecoveryCommand('AA:BB:CC:DD:EE:99', { ssid: 'homessid', password: 'homepass', ip: '10.0.0.40' })

      assert.strictEqual(result.found, true)
      assert.strictEqual(result.alreadyKnown, false)
      assert.strictEqual(result.command, 'Backlog SSId1 homessid;Password1 homepass;IpAddress1 10.0.0.40;Restart 1')
    })

    it('still returns found:false for a brand-new device when neither override nor manager fallback supply credentials', async function () {
      const name = uniqueName('recoverynewdevicenocreds')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      const result = n1.buildRecoveryCommand('AA:BB:CC:DD:EE:98', { ip: '10.0.0.41' })

      assert.deepStrictEqual(result, { found: false, mac: 'AA:BB:CC:DD:EE:98' })
    })

    it('finds the cached config via the MAC-derived filename even when the DB row\'s host/ip are stale', async function () {
      // Regression: the lookup used to go DB row.ip -> mqttMap[row.ip] -> filename,
      // so a stale DB ip meant the (still-present, still-correct) cached
      // config could never be found at all - silently losing all cached
      // data instead of using it. The DB is not the reliable source here;
      // the cache (read straight from the device) is.
      const name = uniqueName('recoverymacfile')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      seedDevice(n1, 'AA:BB:A1:B2:C3', '10.0.0.200', 'stale-host')
      writeCachedConfig(n1, 'tasmota_A1B2C3', {
        sta_ssid: ['myssid', ''],
        sta_pwd: ['mypass', ''],
        ip_address: ['10.0.0.9', '10.0.0.1', '255.255.255.0', '8.8.8.8'],
        hostname: 'plug1'
      })

      const result = n1.buildRecoveryCommand('AA:BB:A1:B2:C3')

      assert.strictEqual(result.found, true)
      assert.ok(result.command.includes('SSId1 myssid;Password1 mypass'))
      assert.strictEqual(result.ip, '10.0.0.9', 'should come from the cache, not the stale DB row (10.0.0.200)')
      assert.strictEqual(result.host, 'plug1', 'should come from the cache, not the stale DB row (stale-host)')
    })

    it('falls back to the DB row\'s ip/host only when no cached config is found at all', async function () {
      const name = uniqueName('recoveryfallbackiphost')
      const flow = [managerConfig('n1', { name, ssid: 'fallbackssid', password: 'fallbackpass' })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      seedDevice(n1, 'AA:BB:CC:DD:EE:05', '10.0.0.15', 'plug15')

      const result = n1.buildRecoveryCommand('AA:BB:CC:DD:EE:05')

      assert.strictEqual(result.ip, '10.0.0.15')
      assert.strictEqual(result.host, 'plug15')
    })
  })

  describe('findTasmotaAPs()', function () {
    let originalDetect, originalScan

    beforeEach(function () {
      originalDetect = NetHelper.detectNetworkManager
      originalScan = NetHelper.scanWifiNetworks
    })

    afterEach(function () {
      NetHelper.detectNetworkManager = originalDetect
      NetHelper.scanWifiNetworks = originalScan
    })

    it('scans and filters for Tasmota fallback APs, defaulting to wlan0', async function () {
      const name = uniqueName('findtasmotaaps')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      let scannedIface
      NetHelper.scanWifiNetworks = async (iface) => {
        scannedIface = iface
        return [
          { ssid: 'MyHomeWifi', signal: 80, unit: 'percent' },
          { ssid: 'tasmota_A1B2C3-4210', signal: 55, unit: 'percent' }
        ]
      }

      const result = await n1.findTasmotaAPs()

      assert.strictEqual(scannedIface, 'wlan0')
      assert.strictEqual(result.length, 1)
      assert.strictEqual(result[0].ssid, 'tasmota_A1B2C3-4210')
    })

    it('uses an explicit iface argument over the manager\'s configured default', async function () {
      const name = uniqueName('findtasmotaapsiface')
      const flow = [managerConfig('n1', { name, wifiInterface: 'wlan1' })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      let scannedIface
      NetHelper.scanWifiNetworks = async (iface) => { scannedIface = iface; return [] }

      await n1.findTasmotaAPs('wlan2')
      assert.strictEqual(scannedIface, 'wlan2')

      await n1.findTasmotaAPs()
      assert.strictEqual(scannedIface, 'wlan1')
    })

    it('rejects a concurrent call while wifiBusy is already set', async function () {
      const name = uniqueName('findtasmotaapsbusy')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')
      n1.wifiBusy = true

      await assert.rejects(() => n1.findTasmotaAPs(), /already in progress/)
    })
  })

  describe('recoveryDevice()', function () {
    const NM = NetHelper.NETWORK_MANAGERS.NMCLI
    const netHelperMethods = [
      'detectNetworkManager', 'getCurrentConnection', 'scheduleConnectionActivation',
      'connectToNetwork', 'waitForConnection', 'activateConnection', 'disconnect',
      'forgetNetwork', 'cancelScheduledActivation'
    ]
    let originals

    beforeEach(function () {
      originals = {}
      netHelperMethods.forEach((m) => { originals[m] = NetHelper[m] })
    })

    afterEach(function () {
      netHelperMethods.forEach((m) => { NetHelper[m] = originals[m] })
    })

    // Stubs every NetHelper call recoveryDevice() makes, recording call order
    // in `calls` - the point is verifying the *orchestration* (watchdog
    // arm/cancel, restore-on-any-outcome, cleanup order), not real networking.
    function stubNetHelper (calls, { connected = true, connectionId = 'MyHomeWifi' } = {}) {
      NetHelper.detectNetworkManager = async () => NM
      NetHelper.getCurrentConnection = async (iface, manager) => {
        calls.push(['getCurrentConnection', iface, manager])
        return { manager: NM, iface, connected, connectionId, ssid: connected ? 'MyHomeWifi' : null }
      }
      NetHelper.scheduleConnectionActivation = async (connId, seconds, opts) => {
        calls.push(['scheduleConnectionActivation', connId, seconds, opts])
        return { unitName: 'tasmota-recovery-test', connectionId: connId, iface: opts.iface, manager: opts.manager, timeoutSeconds: seconds }
      }
      NetHelper.connectToNetwork = async (ssid, opts) => {
        calls.push(['connectToNetwork', ssid, opts])
        return { manager: NM, iface: opts.iface, ssid }
      }
      NetHelper.waitForConnection = async (ssid, opts) => {
        calls.push(['waitForConnection', ssid, opts])
        return { connected: true, ssid }
      }
      NetHelper.activateConnection = async (connId, opts) => { calls.push(['activateConnection', connId, opts]) }
      NetHelper.disconnect = async (opts) => { calls.push(['disconnect', opts]) }
      NetHelper.forgetNetwork = async (handle) => { calls.push(['forgetNetwork', handle]) }
      NetHelper.cancelScheduledActivation = async (unitName) => { calls.push(['cancelScheduledActivation', unitName]) }
    }

    it('captures the connection, arms the watchdog, hops, pushes the config, then restores/forgets/cancels in order', async function () {
      // No cached config seeded on purpose - this test is about the
      // watchdog/restore/cleanup orchestration (the "backlog" push path),
      // not the config-push mechanism itself; see the dedicated
      // full-restore-branch tests below for that.
      const name = uniqueName('recoverydevice-happy')
      const flow = [managerConfig('n1', { name, ssid: 'homessid', password: 'homepass' })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      seedDevice(n1, 'AA:BB:CC:DD:EE:10', '10.0.0.30')

      const calls = []
      stubNetHelper(calls, { connected: true, connectionId: 'MyHomeWifi' })
      n1.httpCommand = async (ip, cmnd, val) => { calls.push(['httpCommand', ip, cmnd, val]); return { StatusNET: { Mac: 'AA:BB:CC:DD:EE:10' } } }
      n1.getRequest = async (url) => { calls.push(['getRequest', url]); return { Backlog: 'Done' } }

      const result = await n1.recoveryDevice('tasmota_AABBCC-1234')

      assert.strictEqual(result.mac, 'AA:BB:CC:DD:EE:10')
      assert.strictEqual(result.found, true)
      assert.strictEqual(result.mode, 'backlog')
      assert.deepStrictEqual(calls.map((c) => c[0]), [
        'getCurrentConnection', 'scheduleConnectionActivation', 'connectToNetwork', 'waitForConnection',
        'httpCommand', 'getRequest', 'activateConnection', 'forgetNetwork', 'cancelScheduledActivation'
      ])
      assert.strictEqual(calls.find((c) => c[0] === 'scheduleConnectionActivation')[1], 'MyHomeWifi')
      assert.strictEqual(calls.find((c) => c[0] === 'activateConnection')[1], 'MyHomeWifi')
      assert.strictEqual(n1.wifiBusy, false)
    })

    it('arms the watchdog with null and disconnects on restore when nothing was connected beforehand', async function () {
      const name = uniqueName('recoverydevice-disconnected')
      const flow = [managerConfig('n1', { name, ssid: 'homessid', password: 'homepass' })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      seedDevice(n1, 'AA:BB:CC:DD:EE:11', '10.0.0.31')

      const calls = []
      stubNetHelper(calls, { connected: false, connectionId: null })
      n1.httpCommand = async () => ({ StatusNET: { Mac: 'AA:BB:CC:DD:EE:11' } })
      n1.getRequest = async () => ({ Backlog: 'Done' })

      await n1.recoveryDevice('tasmota_AABBCC-1234')

      assert.strictEqual(calls.find((c) => c[0] === 'scheduleConnectionActivation')[1], null)
      assert.ok(calls.some((c) => c[0] === 'disconnect'))
      assert.ok(!calls.some((c) => c[0] === 'activateConnection'))
    })

    it('still restores/forgets/cancels and rethrows when a step fails before the MAC query', async function () {
      const name = uniqueName('recoverydevice-failure')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      const calls = []
      stubNetHelper(calls, { connected: true, connectionId: 'MyHomeWifi' })
      NetHelper.waitForConnection = async (ssid, opts) => {
        calls.push(['waitForConnection', ssid, opts])
        throw new Error('boom: never connected')
      }
      n1.httpCommand = async () => { calls.push(['httpCommand']); return {} }

      await assert.rejects(() => n1.recoveryDevice('tasmota_AABBCC-1234'), /boom: never connected/)

      const names = calls.map((c) => c[0])
      assert.ok(names.includes('activateConnection'), 'should still restore the original connection')
      assert.ok(names.includes('forgetNetwork'), 'should still forget the temporary network')
      assert.ok(names.includes('cancelScheduledActivation'), 'should still cancel the watchdog')
      assert.ok(!names.includes('httpCommand'), 'should not have reached the MAC query')
      assert.strictEqual(n1.wifiBusy, false)
    })

    it('throws when the queried MAC has no known configuration, but still cleans up', async function () {
      const name = uniqueName('recoverydevice-unknownmac')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      const calls = []
      stubNetHelper(calls, { connected: true, connectionId: 'MyHomeWifi' })
      n1.httpCommand = async () => ({ StatusNET: { Mac: '00:00:00:00:00:00' } })

      await assert.rejects(() => n1.recoveryDevice('tasmota_AABBCC-1234'), /no known configuration/)

      const names = calls.map((c) => c[0])
      assert.ok(names.includes('activateConnection'))
      assert.ok(names.includes('forgetNetwork'))
      assert.ok(names.includes('cancelScheduledActivation'))
    })

    it('rejects a concurrent call while wifiBusy is set, without touching NetHelper at all', async function () {
      const name = uniqueName('recoverydevice-busy')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')
      n1.wifiBusy = true

      const calls = []
      stubNetHelper(calls)

      await assert.rejects(() => n1.recoveryDevice('tasmota_AABBCC-1234'), /already in progress/)
      assert.deepStrictEqual(calls, [])
    })

    it('rejects a missing apSsid', async function () {
      const name = uniqueName('recoverydevice-noapssid')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      await assert.rejects(() => n1.recoveryDevice(''), /Tasmota AP SSID is required/)
    })

    it('passes overrides through to buildRecoveryCommand', async function () {
      const name = uniqueName('recoverydevice-overrides')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      seedDevice(n1, 'AA:BB:CC:DD:EE:12', '10.0.0.32')

      const calls = []
      stubNetHelper(calls, { connected: true, connectionId: 'MyHomeWifi' })
      n1.httpCommand = async () => ({ StatusNET: { Mac: 'AA:BB:CC:DD:EE:12' } })
      n1.getRequest = async (url) => { calls.push(['getRequest', url]); return {} }

      const result = await n1.recoveryDevice('tasmota_AABBCC-1234', { ssid: 'overridessid', password: 'overridepass' })

      assert.ok(result.command.includes('SSId1 overridessid;Password1 overridepass'))
    })

    it('registers a stub DB row for a previously-unknown device after a successful recovery', async function () {
      const name = uniqueName('recoverydevice-autoregister')
      const flow = [managerConfig('n1', { name, ssid: 'homessid', password: 'homepass' })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      const calls = []
      stubNetHelper(calls, { connected: true, connectionId: 'MyHomeWifi' })
      n1.httpCommand = async () => ({ StatusNET: { Mac: 'AA:BB:CC:DD:EE:13' } })
      n1.getRequest = async () => ({ Backlog: 'Done' })

      assert.strictEqual(n1.devicesDb.findTableRaw('devices', 'mac', 'AA:BB:CC:DD:EE:13', true), undefined)

      await n1.recoveryDevice('tasmota_AABBCC-1234', { ip: '10.0.0.60' })

      const row = n1.devicesDb.findTableRaw('devices', 'mac', 'AA:BB:CC:DD:EE:13', true)
      assert.ok(row, 'a DB row should have been created')
      assert.strictEqual(row.ip, '10.0.0.60')
    })

    it('does not duplicate the DB row for an already-known device after recovery', async function () {
      const name = uniqueName('recoverydevice-noduplicate')
      const flow = [managerConfig('n1', { name, ssid: 'homessid', password: 'homepass' })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      seedDevice(n1, 'AA:BB:CC:DD:EE:14', '10.0.0.61')

      const calls = []
      stubNetHelper(calls, { connected: true, connectionId: 'MyHomeWifi' })
      n1.httpCommand = async () => ({ StatusNET: { Mac: 'AA:BB:CC:DD:EE:14' } })
      n1.getRequest = async () => ({ Backlog: 'Done' })

      await n1.recoveryDevice('tasmota_AABBCC-1234')

      const rows = n1.devicesDb.data.devices.filter((d) => d.mac === 'AA:BB:CC:DD:EE:14')
      assert.strictEqual(rows.length, 1)
    })

    it('does a full config restore (not the minimal Backlog push) when a cached config exists, with overrides merged in', async function () {
      const name = uniqueName('recoverydevice-fullrestore')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      seedDevice(n1, 'AA:BB:CC:DD:EE:15', '10.0.0.62')
      writeCachedConfig(n1, '10.0.0.62', {
        sta_ssid: ['cachedssid', ''],
        sta_pwd: ['cachedpass', ''],
        ip_address: ['10.0.0.62', '10.0.0.1', '255.255.255.0', '8.8.8.8'],
        module: 17 // stand-in for the extra config a Backlog push never covers
      })

      const calls = []
      stubNetHelper(calls, { connected: true, connectionId: 'MyHomeWifi' })
      n1.httpCommand = async (ip, cmnd, val) => { calls.push(['httpCommand', ip, cmnd, val]); return ip === '192.168.4.1' && cmnd === 'Status' ? { StatusNET: { Mac: 'AA:BB:CC:DD:EE:15' } } : {} }
      n1.getRequest = async (url) => { calls.push(['getRequest', url]) }
      n1.restoreFullConfig = async (ip, config) => { calls.push(['restoreFullConfig', ip, config]) }

      const result = await n1.recoveryDevice('tasmota_AABBCC-1234', { ssid: 'overridessid' })

      assert.strictEqual(result.mode, 'full-restore')
      assert.ok(!calls.some((c) => c[0] === 'getRequest'), 'should not have used the minimal Backlog push')
      const restoreCall = calls.find((c) => c[0] === 'restoreFullConfig')
      assert.ok(restoreCall, 'restoreFullConfig should have been called')
      assert.strictEqual(restoreCall[1], '192.168.4.1')
      assert.strictEqual(restoreCall[2].sta_ssid[0], 'overridessid', 'override should be merged into the restored config')
      assert.strictEqual(restoreCall[2].sta_pwd[0], 'cachedpass', 'non-overridden fields keep the cached value')
      assert.strictEqual(restoreCall[2].module, 17, 'fields a Backlog push never covers still get restored')
      // best-effort explicit restart after the restore
      assert.ok(calls.some((c) => c[0] === 'httpCommand' && c[1] === '192.168.4.1' && c[2] === 'Restart'))
    })

    it('tolerates the best-effort restart after a full restore failing (device likely already rebooted)', async function () {
      const name = uniqueName('recoverydevice-restartfails')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      seedDevice(n1, 'AA:BB:CC:DD:EE:16', '10.0.0.63')
      writeCachedConfig(n1, '10.0.0.63', { sta_ssid: ['cachedssid', ''], sta_pwd: ['cachedpass', ''], ip_address: [] })

      const calls = []
      stubNetHelper(calls, { connected: true, connectionId: 'MyHomeWifi' })
      n1.httpCommand = async (ip, cmnd) => {
        calls.push(['httpCommand', ip, cmnd])
        if (cmnd === 'Status') return { StatusNET: { Mac: 'AA:BB:CC:DD:EE:16' } }
        throw new Error('device unreachable (already rebooted)')
      }
      n1.restoreFullConfig = async (ip, config) => { calls.push(['restoreFullConfig', ip, config]) }

      const result = await n1.recoveryDevice('tasmota_AABBCC-1234')

      assert.strictEqual(result.mode, 'full-restore')
      assert.ok(calls.some((c) => c[0] === 'activateConnection'), 'the finally-cleanup should still run normally')
    })

    it('propagates a full-restore failure and still runs the finally cleanup, without falling back to the Backlog push', async function () {
      const name = uniqueName('recoverydevice-fullrestorefails')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      seedDevice(n1, 'AA:BB:CC:DD:EE:17', '10.0.0.64')
      writeCachedConfig(n1, '10.0.0.64', { sta_ssid: ['cachedssid', ''], sta_pwd: ['cachedpass', ''], ip_address: [] })

      const calls = []
      stubNetHelper(calls, { connected: true, connectionId: 'MyHomeWifi' })
      n1.httpCommand = async () => ({ StatusNET: { Mac: 'AA:BB:CC:DD:EE:17' } })
      n1.getRequest = async (url) => { calls.push(['getRequest', url]) }
      n1.restoreFullConfig = async () => { throw new Error('restore boom') }

      await assert.rejects(() => n1.recoveryDevice('tasmota_AABBCC-1234'), /restore boom/)

      assert.ok(!calls.some((c) => c[0] === 'getRequest'), 'must not silently fall back to the Backlog push')
      const names = calls.map((c) => c[0])
      assert.ok(names.includes('activateConnection'))
      assert.ok(names.includes('forgetNetwork'))
      assert.ok(names.includes('cancelScheduledActivation'))
    })
  })

  describe('_applyConfigOverrides()', function () {
    it('merges ssid/password/ip/gateway/mask into a copy of the config', async function () {
      const name = uniqueName('applyoverrides')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      const config = { sta_ssid: ['cachedssid', ''], sta_pwd: ['cachedpass', ''], ip_address: ['10.0.0.1', '10.0.0.254', '255.255.255.0', '8.8.8.8'], module: 17 }
      const merged = n1._applyConfigOverrides(config, { ssid: 'newssid', password: 'newpass', ip: '10.0.0.2', gateway: '10.0.0.253', mask: '255.255.0.0' })

      assert.deepStrictEqual(merged.sta_ssid, ['newssid', ''])
      assert.deepStrictEqual(merged.sta_pwd, ['newpass', ''])
      assert.deepStrictEqual(merged.ip_address, ['10.0.0.2', '10.0.0.253', '255.255.0.0', '8.8.8.8'])
      assert.strictEqual(merged.module, 17, 'fields with no override stay untouched')
    })

    it('leaves fields untouched when no matching override is given', async function () {
      const name = uniqueName('applyoverridesnone')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      const config = { sta_ssid: ['cachedssid', ''], sta_pwd: ['cachedpass', ''], ip_address: ['10.0.0.1', '10.0.0.254', '255.255.255.0'] }
      const merged = n1._applyConfigOverrides(config, {})

      assert.deepStrictEqual(merged, config)
    })

    it('does not mutate the original config object', async function () {
      const name = uniqueName('applyoverridesnomutate')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      const config = { sta_ssid: ['cachedssid', ''], ip_address: ['10.0.0.1'] }
      n1._applyConfigOverrides(config, { ssid: 'newssid', ip: '10.0.0.2' })

      assert.deepStrictEqual(config.sta_ssid, ['cachedssid', ''])
      assert.deepStrictEqual(config.ip_address, ['10.0.0.1'])
    })
  })

  describe('restoreFullConfig()', function () {
    it('writes the config to a temp file, restores it via decode-config.py, and deletes the temp file', async function () {
      const name = uniqueName('restorefullconfig-ok')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      let capturedParams
      let tmpPathAtCallTime
      n1._spawnDecodeConfig = async (params) => {
        capturedParams = params
        tmpPathAtCallTime = params[3]
        assert.strictEqual(fs.existsSync(tmpPathAtCallTime), true)
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(tmpPathAtCallTime, 'utf8')), { sta_ssid: ['x', ''] })
        return 0
      }

      await n1.restoreFullConfig('192.168.4.1', { sta_ssid: ['x', ''] })

      assert.deepStrictEqual(capturedParams.slice(0, 3), ['-d', '192.168.4.1', '--restore-file'])
      assert.strictEqual(fs.existsSync(tmpPathAtCallTime), false, 'temp file should be removed afterward')
    })

    it('throws when decode-config.py exits with a non-zero code, and still removes the temp file', async function () {
      const name = uniqueName('restorefullconfig-nonzero')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      let tmpPathAtCallTime
      n1._spawnDecodeConfig = async (params) => { tmpPathAtCallTime = params[3]; return 2 }

      await assert.rejects(() => n1.restoreFullConfig('192.168.4.1', { sta_ssid: ['x', ''] }), /exit code 2/)
      assert.strictEqual(fs.existsSync(tmpPathAtCallTime), false)
    })

    it('still removes the temp file when _spawnDecodeConfig itself rejects', async function () {
      const name = uniqueName('restorefullconfig-reject')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      let tmpPathAtCallTime
      n1._spawnDecodeConfig = async (params) => { tmpPathAtCallTime = params[3]; throw new Error('spawn boom') }

      await assert.rejects(() => n1.restoreFullConfig('192.168.4.1', { sta_ssid: ['x', ''] }), /spawn boom/)
      assert.strictEqual(fs.existsSync(tmpPathAtCallTime), false)
    })
  })

  describe('scanTasmotaAPs() / _enrichTasmotaAPs()', function () {
    let originalScan

    beforeEach(function () {
      originalScan = NetHelper.scanWifiNetworks
    })

    afterEach(function () {
      NetHelper.scanWifiNetworks = originalScan
    })

    it('flags an AP as known when its macSuffix matches a device already in the DB', async function () {
      const name = uniqueName('scantasmotaaps-known')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      seedDevice(n1, 'AA:BB:A1:B2:C3', '10.0.0.70', 'plug70')
      n1.devicesDb.data.devices[0].name = 'Living Room Plug'
      NetHelper.scanWifiNetworks = async () => [{ ssid: 'tasmota_A1B2C3-4210', signal: 55, unit: 'percent' }]

      const scan = await n1.scanTasmotaAPs()

      assert.strictEqual(scan.results.length, 1)
      assert.strictEqual(scan.results[0].known, true)
      assert.strictEqual(scan.results[0].deviceName, 'Living Room Plug')
      assert.strictEqual(scan.results[0].deviceIp, '10.0.0.70')
    })

    it('flags an AP as unknown when no device in the DB matches', async function () {
      const name = uniqueName('scantasmotaaps-unknown')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      NetHelper.scanWifiNetworks = async () => [{ ssid: 'tasmota_A1B2C3-4210', signal: 55, unit: 'percent' }]

      const scan = await n1.scanTasmotaAPs()

      assert.strictEqual(scan.results[0].known, false)
    })

    it('caches the result on lastTasmotaScan with a timestamp', async function () {
      const name = uniqueName('scantasmotaaps-cache')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      assert.deepStrictEqual(n1.lastTasmotaScan, { at: null, results: [] })

      NetHelper.scanWifiNetworks = async () => []
      await n1.scanTasmotaAPs()

      assert.strictEqual(typeof n1.lastTasmotaScan.at, 'string')
      assert.deepStrictEqual(n1.lastTasmotaScan.results, [])
    })
  })

  describe('Assistants tab admin routes', function () {
    let originalScan

    beforeEach(function () {
      originalScan = NetHelper.scanWifiNetworks
    })

    afterEach(function () {
      NetHelper.scanWifiNetworks = originalScan
    })

    it('GET .../tasmota-aps returns the empty initial state, then a prior scan result', async function () {
      const name = uniqueName('adminroute-tasmotaaps')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      const before = await helper.request().get('/tasmota-manager/n1/tasmota-aps')
      assert.strictEqual(before.status, 200)
      assert.deepStrictEqual(before.body, { at: null, results: [] })

      NetHelper.scanWifiNetworks = async () => [{ ssid: 'tasmota_A1B2C3-4210', signal: 55, unit: 'percent' }]
      await n1.scanTasmotaAPs()

      const after = await helper.request().get('/tasmota-manager/n1/tasmota-aps')
      assert.strictEqual(after.status, 200)
      assert.strictEqual(after.body.results.length, 1)
    })

    it('POST .../tasmota-aps/scan triggers a fresh scan and returns it', async function () {
      const name = uniqueName('adminroute-scan')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)

      NetHelper.scanWifiNetworks = async () => [{ ssid: 'tasmota_A1B2C3-4210', signal: 55, unit: 'percent' }]

      const res = await helper.request().post('/tasmota-manager/n1/tasmota-aps/scan').send({})

      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.body.results.length, 1)
      assert.strictEqual(res.body.results[0].ssid, 'tasmota_A1B2C3-4210')
    })

    it('POST .../tasmota-aps/scan returns 500 with an error message when the scan throws', async function () {
      const name = uniqueName('adminroute-scanerror')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)

      NetHelper.scanWifiNetworks = async () => { throw new Error('scan boom') }

      const res = await helper.request().post('/tasmota-manager/n1/tasmota-aps/scan').send({})

      assert.strictEqual(res.status, 500)
      assert.strictEqual(res.body.error, 'scan boom')
    })

    it('POST .../recovery-device requires a ssid in the body', async function () {
      const name = uniqueName('adminroute-recoverynoSsid')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)

      const res = await helper.request().post('/tasmota-manager/n1/recovery-device').send({})

      assert.strictEqual(res.status, 400)
    })

    it('POST .../recovery-device dispatches to recoveryDevice() and returns its result', async function () {
      const name = uniqueName('adminroute-recovery')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')
      n1.recoveryDevice = async (ssid, override) => ({ mac: 'AA:BB:CC:DD:EE:20', ssid, override })

      const res = await helper.request().post('/tasmota-manager/n1/recovery-device').send({ ssid: 'tasmota_A1B2C3-4210', override: { ip: '10.0.0.80' } })

      assert.strictEqual(res.status, 200)
      assert.deepStrictEqual(res.body, { mac: 'AA:BB:CC:DD:EE:20', ssid: 'tasmota_A1B2C3-4210', override: { ip: '10.0.0.80' } })
    })

    it('POST .../recovery-device returns 500 with an error message when recoveryDevice() throws', async function () {
      const name = uniqueName('adminroute-recoveryerror')
      const flow = [managerConfig('n1', { name })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')
      n1.recoveryDevice = async () => { throw new Error('recovery boom') }

      const res = await helper.request().post('/tasmota-manager/n1/recovery-device').send({ ssid: 'tasmota_A1B2C3-4210' })

      assert.strictEqual(res.status, 500)
      assert.strictEqual(res.body.error, 'recovery boom')
    })
  })

  describe('_scheduleRecoveryScan()', function () {
    it('does not create a timer when recoveryScanRepeatHours is 0', async function () {
      const name = uniqueName('scheduletimer-off')
      const flow = [managerConfig('n1', { name, recoveryScanRepeatHours: 0 })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      assert.strictEqual(n1._scanTimer, null)
    })

    it('creates a timer when recoveryScanRepeatHours is positive', async function () {
      const name = uniqueName('scheduletimer-on')
      const flow = [managerConfig('n1', { name, recoveryScanRepeatHours: 24 })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')

      assert.ok(n1._scanTimer, 'a timer should have been scheduled')
    })

    it('clears the timer when the node closes', async function () {
      const name = uniqueName('scheduletimer-close')
      const flow = [managerConfig('n1', { name, recoveryScanRepeatHours: 24 })]
      await helper.load(managerNodeModule, flow)
      const n1 = helper.getNode('n1')
      const timer = n1._scanTimer
      assert.ok(timer)

      const originalClearInterval = global.clearInterval
      let clearedWith
      global.clearInterval = (t) => { clearedWith = t; return originalClearInterval(t) }
      try {
        await helper.unload()
      }
      finally {
        global.clearInterval = originalClearInterval
      }

      assert.strictEqual(clearedWith, timer)
    })
  })
})
