'use strict'

const assert = require('assert')
const { NetHelper } = require('../../nodes/lib/utils.js')

// detectNetworkManager()/scanWifiNetworks*()/getCurrentConnection*()/
// scheduleConnectionActivation() shell out to nmcli/iw/wpa_cli/systemd-run,
// which aren't available in CI/dev environments - only the pure
// parsing/filtering/command-building logic (fed with captured real-world
// command output, or asserting the exact command string produced) is
// covered here.

describe('NetHelper', function () {
  describe('parseNmcliWifiList()', function () {
    it('parses SSID/SIGNAL pairs from nmcli terse output', function () {
      const output = 'MyHomeWifi:78\ntasmota_A1B2C3-4210:55\n'
      assert.deepStrictEqual(NetHelper.parseNmcliWifiList(output), [
        { ssid: 'MyHomeWifi', signal: 78, unit: 'percent' },
        { ssid: 'tasmota_A1B2C3-4210', signal: 55, unit: 'percent' }
      ])
    })

    it('unescapes a literal colon inside an SSID', function () {
      const output = 'Home\\:Net:67\n'
      assert.deepStrictEqual(NetHelper.parseNmcliWifiList(output), [
        { ssid: 'Home:Net', signal: 67, unit: 'percent' }
      ])
    })

    it('skips blank lines and entries with an empty SSID (hidden networks)', function () {
      const output = '\n:42\nRealSsid:90\n'
      assert.deepStrictEqual(NetHelper.parseNmcliWifiList(output), [
        { ssid: 'RealSsid', signal: 90, unit: 'percent' }
      ])
    })
  })

  describe('parseIwScan()', function () {
    it('parses SSID/signal pairs from iw scan output blocks', function () {
      const output = [
        'BSS aa:bb:cc:dd:ee:ff(on wlan0)',
        '\tTSF: 123456789 usec (1d, 10:17:36)',
        '\tfreq: 2412',
        '\tsignal: -45.00 dBm',
        '\tlast seen: 120 ms ago',
        '\tSSID: MyHomeWifi',
        'BSS 11:22:33:44:55:66(on wlan0)',
        '\tsignal: -70.00 dBm',
        '\tSSID: tasmota_A1B2C3-4210'
      ].join('\n')

      assert.deepStrictEqual(NetHelper.parseIwScan(output), [
        { ssid: 'MyHomeWifi', signal: -45, unit: 'dbm' },
        { ssid: 'tasmota_A1B2C3-4210', signal: -70, unit: 'dbm' }
      ])
    })

    it('skips BSS blocks with no SSID (hidden networks)', function () {
      const output = [
        'BSS aa:bb:cc:dd:ee:ff(on wlan0)',
        '\tsignal: -60.00 dBm',
        'BSS 11:22:33:44:55:66(on wlan0)',
        '\tsignal: -70.00 dBm',
        '\tSSID: RealSsid'
      ].join('\n')

      assert.deepStrictEqual(NetHelper.parseIwScan(output), [
        { ssid: 'RealSsid', signal: -70, unit: 'dbm' }
      ])
    })
  })

  describe('findTasmotaAPs()', function () {
    it('picks out tasmota_XXXXXX-YYYY entries and extracts mac suffix/chipId', function () {
      const networks = [
        { ssid: 'MyHomeWifi', signal: 78, unit: 'percent' },
        { ssid: 'tasmota_a1b2c3-4210', signal: 55, unit: 'percent' },
        { ssid: 'tasmota_FF00AA-7', signal: 40, unit: 'percent' },
        { ssid: 'not-a-tasmota-ap', signal: 30, unit: 'percent' }
      ]

      assert.deepStrictEqual(NetHelper.findTasmotaAPs(networks), [
        { ssid: 'tasmota_a1b2c3-4210', signal: 55, unit: 'percent', macSuffix: 'A1B2C3', chipId: 4210 },
        { ssid: 'tasmota_FF00AA-7', signal: 40, unit: 'percent', macSuffix: 'FF00AA', chipId: 7 }
      ])
    })

    it('returns an empty array when nothing matches', function () {
      assert.deepStrictEqual(NetHelper.findTasmotaAPs([{ ssid: 'MyHomeWifi', signal: 78, unit: 'percent' }]), [])
    })
  })

  describe('parseNmcliDeviceStatus()', function () {
    it('parses DEVICE/STATE/CONNECTION rows', function () {
      const output = 'wlan0:100 (connected):MyHomeWifi\neth0:100 (connected):Wired connection 1\nlo:unmanaged:\n'
      assert.deepStrictEqual(NetHelper.parseNmcliDeviceStatus(output), [
        { device: 'wlan0', state: '100 (connected)', connection: 'MyHomeWifi' },
        { device: 'eth0', state: '100 (connected)', connection: 'Wired connection 1' },
        { device: 'lo', state: 'unmanaged', connection: null }
      ])
    })
  })

  describe('parseNmcliActiveSsid()', function () {
    it('picks the SSID marked in-use with "*"', function () {
      const output = ':OtherNetwork\n*:MyHomeWifi\n'
      assert.strictEqual(NetHelper.parseNmcliActiveSsid(output), 'MyHomeWifi')
    })

    it('returns null when nothing is marked in-use', function () {
      assert.strictEqual(NetHelper.parseNmcliActiveSsid(':OtherNetwork\n'), null)
    })
  })

  describe('parseWpaCliStatus()', function () {
    it('parses key=value lines into an object', function () {
      const output = 'bssid=aa:bb:cc:dd:ee:ff\nssid=MyHomeWifi\nid=0\nwpa_state=COMPLETED\nip_address=192.168.1.23\n'
      assert.deepStrictEqual(NetHelper.parseWpaCliStatus(output), {
        bssid: 'aa:bb:cc:dd:ee:ff',
        ssid: 'MyHomeWifi',
        id: '0',
        wpa_state: 'COMPLETED',
        ip_address: '192.168.1.23'
      })
    })
  })

  describe('shellQuote()', function () {
    it('wraps a plain value in single quotes', function () {
      assert.strictEqual(NetHelper.shellQuote('MyHomeWifi'), "'MyHomeWifi'")
    })

    it('escapes an embedded single quote', function () {
      assert.strictEqual(NetHelper.shellQuote("O'Brien's AP"), "'O'\\''Brien'\\''s AP'")
    })
  })

  describe('isValidSystemdUnitName()', function () {
    it('accepts letters, digits, "_", ".", "-"', function () {
      assert.strictEqual(NetHelper.isValidSystemdUnitName('tasmota-recovery_1.service-ish'), true)
    })

    it('rejects spaces, quotes, and shell metacharacters', function () {
      assert.strictEqual(NetHelper.isValidSystemdUnitName('bad name'), false)
      assert.strictEqual(NetHelper.isValidSystemdUnitName('bad;rm -rf /'), false)
      assert.strictEqual(NetHelper.isValidSystemdUnitName("bad'quote"), false)
    })
  })

  describe('buildActivateCommand()', function () {
    it('builds an nmcli connection-up command', function () {
      assert.strictEqual(
        NetHelper.buildActivateCommand(NetHelper.NETWORK_MANAGERS.NMCLI, 'wlan0', 'MyHomeWifi'),
        "nmcli connection up 'MyHomeWifi'"
      )
    })

    it('builds a wpa_cli select_network command', function () {
      assert.strictEqual(
        NetHelper.buildActivateCommand(NetHelper.NETWORK_MANAGERS.WPA_SUPPLICANT, 'wlan0', '0'),
        "wpa_cli -i 'wlan0' select_network '0'"
      )
    })

    it('throws for an unsupported manager', function () {
      assert.throws(() => NetHelper.buildActivateCommand('unknown', 'wlan0', '0'), /unsupported network manager/)
    })
  })

  describe('buildDisconnectCommand()', function () {
    it('builds an nmcli device-disconnect command', function () {
      assert.strictEqual(
        NetHelper.buildDisconnectCommand(NetHelper.NETWORK_MANAGERS.NMCLI, 'wlan0'),
        "nmcli device disconnect 'wlan0'"
      )
    })

    it('builds a wpa_cli disconnect command', function () {
      assert.strictEqual(
        NetHelper.buildDisconnectCommand(NetHelper.NETWORK_MANAGERS.WPA_SUPPLICANT, 'wlan0'),
        "wpa_cli -i 'wlan0' disconnect"
      )
    })

    it('throws for an unsupported manager', function () {
      assert.throws(() => NetHelper.buildDisconnectCommand('unknown', 'wlan0'), /unsupported network manager/)
    })
  })

  describe('parseWpaCliNetworkId()', function () {
    it('extracts the network id from the last non-blank line', function () {
      assert.strictEqual(NetHelper.parseWpaCliNetworkId('5\n'), '5')
    })

    it('ignores leading blank lines/noise', function () {
      assert.strictEqual(NetHelper.parseWpaCliNetworkId('\n\n3\n'), '3')
    })

    it('throws when no bare-number line is found', function () {
      assert.throws(() => NetHelper.parseWpaCliNetworkId('FAIL\n'), /could not find a network id/)
    })
  })

  describe('buildScheduleActivationCommand()', function () {
    const nmcli = NetHelper.NETWORK_MANAGERS.NMCLI

    it('builds the full sudo systemd-run command with an explicit unit name', function () {
      const result = NetHelper.buildScheduleActivationCommand('MyHomeWifi', 30, { manager: nmcli, unitName: 'tasmota-recovery-test' })
      assert.strictEqual(result.unitName, 'tasmota-recovery-test')
      assert.strictEqual(result.timeoutSeconds, 30)
      assert.strictEqual(
        result.command,
        "sudo -n systemd-run --unit=tasmota-recovery-test --on-active=30 --collect --description='tasmota recovery: activate MyHomeWifi' -- nmcli connection up 'MyHomeWifi'"
      )
    })

    it('auto-generates a valid unit name when none is given', function () {
      const result = NetHelper.buildScheduleActivationCommand('MyHomeWifi', 30, { manager: nmcli })
      assert.strictEqual(NetHelper.isValidSystemdUnitName(result.unitName), true)
      assert.ok(result.unitName.startsWith('tasmota-recovery-'))
    })

    it('rounds a fractional timeout to whole seconds', function () {
      const result = NetHelper.buildScheduleActivationCommand('MyHomeWifi', 30.6, { manager: nmcli, unitName: 'tasmota-recovery-test' })
      assert.strictEqual(result.timeoutSeconds, 31)
      assert.ok(result.command.includes('--on-active=31'))
    })

    it('allows connectionId 0 (a valid wpa_supplicant network id)', function () {
      const result = NetHelper.buildScheduleActivationCommand(0, 30, { manager: NetHelper.NETWORK_MANAGERS.WPA_SUPPLICANT, iface: 'wlan0', unitName: 'tasmota-recovery-test' })
      assert.ok(result.command.includes("select_network '0'"))
    })

    it('builds a disconnect-timer command when connectionId is null (nothing was connected before)', function () {
      const result = NetHelper.buildScheduleActivationCommand(null, 30, { manager: nmcli, iface: 'wlan0', unitName: 'tasmota-recovery-test' })
      assert.strictEqual(
        result.command,
        "sudo -n systemd-run --unit=tasmota-recovery-test --on-active=30 --collect --description='tasmota recovery: disconnect' -- nmcli device disconnect 'wlan0'"
      )
    })

    it('rejects a missing connectionId', function () {
      assert.throws(() => NetHelper.buildScheduleActivationCommand('', 30, { manager: nmcli }), /connectionId is required/)
      assert.throws(() => NetHelper.buildScheduleActivationCommand(undefined, 30, { manager: nmcli }), /connectionId is required/)
    })

    it('rejects a non-positive or non-finite timeout', function () {
      assert.throws(() => NetHelper.buildScheduleActivationCommand('MyHomeWifi', 0, { manager: nmcli }), /positive number of seconds/)
      assert.throws(() => NetHelper.buildScheduleActivationCommand('MyHomeWifi', -5, { manager: nmcli }), /positive number of seconds/)
      assert.throws(() => NetHelper.buildScheduleActivationCommand('MyHomeWifi', NaN, { manager: nmcli }), /positive number of seconds/)
    })

    it('rejects an unsupported/missing manager', function () {
      assert.throws(() => NetHelper.buildScheduleActivationCommand('MyHomeWifi', 30, {}), /supported network manager must be given/)
      assert.throws(() => NetHelper.buildScheduleActivationCommand('MyHomeWifi', 30, { manager: NetHelper.NETWORK_MANAGERS.UNKNOWN }), /supported network manager must be given/)
    })

    it('rejects an invalid custom unit name', function () {
      assert.throws(() => NetHelper.buildScheduleActivationCommand('MyHomeWifi', 30, { manager: nmcli, unitName: 'bad name' }), /invalid unitName/)
    })
  })
})
