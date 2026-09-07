'use strict'

const { exec } = require('child_process')
const { promisify } = require('util')
const execAsync = promisify(exec)

function extractChannelNum (str) {
  const numberRegexp = /\d+$/
  return Number(str.match(numberRegexp) || 1)
}

// Tasmota's setup AP is named tasmota_XXXXXX-Y[YYY], where XXXXXX is the
// last 3 bytes of the device's MAC in hex and Y[YYY] is (chipId & 0x1FFF) in
// decimal (0-8191, so 1-4 digits, not zero-padded).
const TASMOTA_AP_SSID_RE = /^tasmota_([0-9a-f]{6})-(\d{1,4})$/i

// WiFi scanning helpers for the (planned) AP-fallback recovery assistant:
// detect which network stack manages WiFi on this host, scan for visible
// networks, and pick out Tasmota fallback APs from the result.
class NetHelper {
  static NETWORK_MANAGERS = {
    NMCLI: 'nmcli',
    WPA_SUPPLICANT: 'wpa_supplicant',
    UNKNOWN: 'unknown'
  }

  // Probes for the network stack actually managing WiFi on this host: modern
  // Raspberry Pi OS defaults to NetworkManager (nmcli), older/lite images and
  // most other Linux hosts still use dhcpcd+wpa_supplicant. Checked in this
  // order because a NetworkManager install always ships wpa_supplicant as a
  // backend too, so wpa_cli alone can't tell them apart.
  static async detectNetworkManager () {
    try {
      await execAsync('sudo -n nmcli general status', { timeout: 5000 })
      return NetHelper.NETWORK_MANAGERS.NMCLI
    }
    catch (err) { /* nmcli missing or NetworkManager not running - try next */ }

    try {
      await execAsync('sudo -n wpa_cli status', { timeout: 5000 })
      return NetHelper.NETWORK_MANAGERS.WPA_SUPPLICANT
    }
    catch (err) { /* wpa_cli missing or no running wpa_supplicant - give up */ }

    return NetHelper.NETWORK_MANAGERS.UNKNOWN
  }

  // nmcli's terse (-t) output escapes a literal ':' inside a field's value as
  // '\:', since ':' is otherwise the field separator - a plain split(':')
  // would wrongly cut SSIDs that themselves contain a colon.
  static #splitNmcliTerseLine (line) {
    const fields = []
    let current = ''
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\' && i + 1 < line.length) {
        current += line[i + 1]
        i++
        continue
      }
      if (line[i] === ':') {
        fields.push(current)
        current = ''
        continue
      }
      current += line[i]
    }
    fields.push(current)
    return fields
  }

  // nmcli's SIGNAL field is a 0-100 quality percentage, not dBm.
  static parseNmcliWifiList (output) {
    return (output || '').split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [ssid, signal] = NetHelper.#splitNmcliTerseLine(line)
        return { ssid, signal: Number(signal), unit: 'percent' }
      })
      .filter((network) => network.ssid)
  }

  static async scanWifiNetworksNmcli (iface = 'wlan0') {
    const { stdout } = await execAsync(`sudo -n nmcli -t -f SSID,SIGNAL dev wifi list ifname ${NetHelper.shellQuote(iface)} --rescan yes`, { timeout: 15000 })
    return NetHelper.parseNmcliWifiList(stdout)
  }

  // `iw scan` reports one "BSS <mac> ..." block per access point, each with
  // its own indented "signal: -NN.00 dBm" and "SSID: <name>" lines - in dBm,
  // not the 0-100 percentage nmcli reports.
  static parseIwScan (output) {
    const networks = []
    let current = null
    ;(output || '').split('\n').forEach((rawLine) => {
      const line = rawLine.trim()
      if (line.startsWith('BSS ')) {
        if (current && current.ssid) networks.push(current)
        current = { ssid: '', signal: undefined, unit: 'dbm' }
        return
      }
      if (!current) return
      const signalMatch = line.match(/^signal:\s*(-?\d+(?:\.\d+)?)\s*dBm/)
      if (signalMatch) { current.signal = Number(signalMatch[1]); return }
      const ssidMatch = line.match(/^SSID:\s*(.*)$/)
      if (ssidMatch) current.ssid = ssidMatch[1]
    })
    if (current && current.ssid) networks.push(current)
    return networks
  }

  static async scanWifiNetworksIw (iface = 'wlan0') {
    const { stdout } = await execAsync(`sudo -n iw dev ${NetHelper.shellQuote(iface)} scan`, { timeout: 15000 })
    return NetHelper.parseIwScan(stdout)
  }

  // Returns [{ ssid, signal, unit }, ...] for every network currently visible
  // on `iface`. `signal`'s meaning depends on `unit` ('percent' for nmcli,
  // 'dbm' for iw) - the two are not directly comparable, so don't sort/compare
  // signal values across a mixed result set.
  static async scanWifiNetworks (iface = 'wlan0', manager) {
    const resolved = manager || await NetHelper.detectNetworkManager()
    switch (resolved) {
      case NetHelper.NETWORK_MANAGERS.NMCLI: return NetHelper.scanWifiNetworksNmcli(iface)
      case NetHelper.NETWORK_MANAGERS.WPA_SUPPLICANT: return NetHelper.scanWifiNetworksIw(iface)
      default: throw new Error(`Cannot scan WiFi networks: no supported network manager detected (got "${resolved}")`)
    }
  }

  static findTasmotaAPs (networks) {
    return (networks || [])
      .map((network) => ({ network, match: network.ssid && network.ssid.match(TASMOTA_AP_SSID_RE) }))
      .filter(({ match }) => match)
      .map(({ network, match }) => ({ ...network, macSuffix: match[1].toUpperCase(), chipId: Number(match[2]) }))
  }

  // -- current connection --------------------------------------------------

  static parseNmcliDeviceStatus (output) {
    return (output || '').split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [device, state, connection] = NetHelper.#splitNmcliTerseLine(line)
        return { device, state, connection: connection || null }
      })
  }

  static parseNmcliActiveSsid (output) {
    const rows = (output || '').split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => NetHelper.#splitNmcliTerseLine(line))
    const active = rows.find(([inUse]) => inUse === '*')
    return active ? active[1] : null
  }

  static async getCurrentConnectionNmcli (iface = 'wlan0') {
    const { stdout } = await execAsync('sudo -n nmcli -t -f DEVICE,STATE,CONNECTION device status', { timeout: 5000 })
    const row = NetHelper.parseNmcliDeviceStatus(stdout).find((d) => d.device === iface)
    const connected = !!row && /connected/i.test(row.state)
    let ssid = null
    if (connected) {
      try {
        const { stdout: wifiOut } = await execAsync('sudo -n nmcli -t -f IN-USE,SSID dev wifi', { timeout: 10000 })
        ssid = NetHelper.parseNmcliActiveSsid(wifiOut)
      }
      catch (err) { /* best-effort only - connectionId is the part that matters for a restore */ }
    }
    return { manager: NetHelper.NETWORK_MANAGERS.NMCLI, iface, connected, connectionId: connected ? row.connection : null, ssid }
  }

  static parseWpaCliStatus (output) {
    const result = {}
    ;(output || '').split('\n').forEach((line) => {
      const idx = line.indexOf('=')
      if (idx === -1) return
      result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    })
    return result
  }

  static async getCurrentConnectionWpaCli (iface = 'wlan0') {
    const { stdout } = await execAsync(`sudo -n wpa_cli -i ${NetHelper.shellQuote(iface)} status`, { timeout: 5000 })
    const status = NetHelper.parseWpaCliStatus(stdout)
    const connected = status.wpa_state === 'COMPLETED'
    return {
      manager: NetHelper.NETWORK_MANAGERS.WPA_SUPPLICANT,
      iface,
      connected,
      connectionId: connected && status.id !== undefined ? status.id : null,
      ssid: connected ? (status.ssid || null) : null
    }
  }

  // Returns { manager, iface, connected, connectionId, ssid } for whatever
  // `iface` is currently associated with. `connectionId` is the value later
  // accepted by scheduleConnectionActivation()/buildActivateCommand() to
  // reactivate this same connection: an nmcli connection-profile name, or a
  // wpa_supplicant network id (a small integer, possibly 0 - check with
  // `!== null`, not truthiness).
  static async getCurrentConnection (iface = 'wlan0', manager) {
    const resolved = manager || await NetHelper.detectNetworkManager()
    switch (resolved) {
      case NetHelper.NETWORK_MANAGERS.NMCLI: return NetHelper.getCurrentConnectionNmcli(iface)
      case NetHelper.NETWORK_MANAGERS.WPA_SUPPLICANT: return NetHelper.getCurrentConnectionWpaCli(iface)
      default: throw new Error(`Cannot get current connection: no supported network manager detected (got "${resolved}")`)
    }
  }

  // -- scheduled (watchdog) connection activation --------------------------
  //
  // The commands below all need root (nmcli/wpa_cli/iw device control,
  // systemd-run creating a system-scope unit) and are invoked with `sudo -n`
  // rather than plain `sudo`: "-n" makes sudo fail immediately if passwordless
  // sudo isn't correctly configured for that command, instead of silently
  // blocking forever on a password prompt that can never be answered on a
  // headless box - see docu/recovery_device.md for the exact sudoers setup.

  // Wraps a value as a single-quoted POSIX shell argument, safe against
  // spaces/other shell metacharacters in an SSID, connection name, etc.
  static shellQuote (value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`
  }

  static isValidSystemdUnitName (name) {
    return /^[a-zA-Z0-9_.-]+$/.test(name)
  }

  // Builds the (unprefixed, no sudo) command that actually reactivates a
  // connection - this is what ends up as the ExecStart of the transient
  // systemd unit, run directly (no shell) once armed.
  static buildActivateCommand (manager, iface, connectionId) {
    switch (manager) {
      case NetHelper.NETWORK_MANAGERS.NMCLI:
        return `nmcli connection up ${NetHelper.shellQuote(connectionId)}`
      case NetHelper.NETWORK_MANAGERS.WPA_SUPPLICANT:
        return `wpa_cli -i ${NetHelper.shellQuote(iface)} select_network ${NetHelper.shellQuote(connectionId)}`
      default:
        throw new Error(`Cannot build activate command: unsupported network manager "${manager}"`)
    }
  }

  // Counterpart to buildActivateCommand() for hosts that weren't connected to
  // anything before a hop - the correct "restore" target then is "no
  // connection", not an invented one.
  static buildDisconnectCommand (manager, iface) {
    switch (manager) {
      case NetHelper.NETWORK_MANAGERS.NMCLI:
        return `nmcli device disconnect ${NetHelper.shellQuote(iface)}`
      case NetHelper.NETWORK_MANAGERS.WPA_SUPPLICANT:
        return `wpa_cli -i ${NetHelper.shellQuote(iface)} disconnect`
      default:
        throw new Error(`Cannot build disconnect command: unsupported network manager "${manager}"`)
    }
  }

  // Pure command-builder for scheduleConnectionActivation(), split out so the
  // exact command (validation, quoting, unit naming) can be unit-tested
  // without actually touching systemd - see test/lib/utils_spec.js.
  // `connectionId === null` deliberately schedules a disconnect instead of an
  // activation (the correct watchdog target when nothing was connected
  // before the hop); `undefined`/`''` remain rejected as a caller mistake.
  static buildScheduleActivationCommand (connectionId, timeoutSeconds, { iface = 'wlan0', manager, unitName } = {}) {
    if (connectionId === undefined || connectionId === '') {
      throw new Error('buildScheduleActivationCommand: connectionId is required (pass null to schedule a disconnect)')
    }
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new Error('buildScheduleActivationCommand: timeoutSeconds must be a positive number of seconds')
    }
    if (!manager || manager === NetHelper.NETWORK_MANAGERS.UNKNOWN) {
      throw new Error('buildScheduleActivationCommand: a supported network manager must be given')
    }
    const name = unitName || `tasmota-recovery-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    if (!NetHelper.isValidSystemdUnitName(name)) {
      throw new Error(`buildScheduleActivationCommand: invalid unitName "${name}" (allowed: letters, digits, "_", ".", "-")`)
    }
    const seconds = Math.round(timeoutSeconds)
    const restoreCmd = connectionId === null
      ? NetHelper.buildDisconnectCommand(manager, iface)
      : NetHelper.buildActivateCommand(manager, iface, connectionId)
    const description = NetHelper.shellQuote(connectionId === null ? 'tasmota recovery: disconnect' : `tasmota recovery: activate ${connectionId}`)
    const command = `sudo -n systemd-run --unit=${name} --on-active=${seconds} --collect --description=${description} -- ${restoreCmd}`
    return { unitName: name, timeoutSeconds: seconds, command }
  }

  // Arms a root-owned, independent systemd transient timer that activates
  // `connectionId` exactly `timeoutSeconds` after this call returns - no
  // matter what happens to the calling Node-RED process afterwards (crash,
  // redeploy, service restart, ...), because systemd (PID 1), not this
  // process, owns the timer. This is the only NetHelper function that
  // changes system state; see docu/recovery_device.md for the sudoers setup
  // it depends on and for the intended dead-man's-switch usage pattern
  // (capture the known-good connection via getCurrentConnection() *before*
  // hopping networks, arm this, then hop).
  //
  // Success here only means the timer was armed - by design nothing reports
  // back to this process about whether the activation itself later
  // succeeded; check `journalctl -u <unitName>` on the host afterwards.
  static async scheduleConnectionActivation (connectionId, timeoutSeconds, { iface = 'wlan0', manager, unitName } = {}) {
    const resolvedManager = manager || await NetHelper.detectNetworkManager()
    const { unitName: name, timeoutSeconds: seconds, command } = NetHelper.buildScheduleActivationCommand(
      connectionId, timeoutSeconds, { iface, manager: resolvedManager, unitName }
    )
    await execAsync(command, { timeout: 10000 })
    return { unitName: name, connectionId, iface, manager: resolvedManager, timeoutSeconds: seconds }
  }

  // Immediate (non-scheduled) counterpart to scheduleConnectionActivation(),
  // for restoring the original connection right away on the happy/error path
  // instead of waiting for the watchdog to fire.
  static async activateConnection (connectionId, { iface = 'wlan0', manager } = {}) {
    const resolved = manager || await NetHelper.detectNetworkManager()
    await execAsync(`sudo -n ${NetHelper.buildActivateCommand(resolved, iface, connectionId)}`, { timeout: 20000 })
  }

  static async disconnect ({ iface = 'wlan0', manager } = {}) {
    const resolved = manager || await NetHelper.detectNetworkManager()
    await execAsync(`sudo -n ${NetHelper.buildDisconnectCommand(resolved, iface)}`, { timeout: 10000 })
  }

  // Cancels a timer armed by scheduleConnectionActivation() - call this once
  // an explicit restore has already succeeded, so the watchdog doesn't fire
  // again later on a connection the host may have deliberately switched away
  // from since. Needs its own sudoers entry for `systemctl` (see
  // docu/recovery_device.md) in addition to the ones scheduleConnectionActivation() needs.
  static async cancelScheduledActivation (unitName) {
    if (!NetHelper.isValidSystemdUnitName(unitName)) {
      throw new Error(`cancelScheduledActivation: invalid unitName "${unitName}"`)
    }
    await execAsync(`sudo -n systemctl stop ${NetHelper.shellQuote(unitName)}`, { timeout: 10000 })
  }

  // -- joining a Tasmota fallback AP ----------------------------------------

  // `wpa_cli add_network` prints the new network's id as the last non-blank
  // line of stdout (just the bare number, nothing else).
  static parseWpaCliNetworkId (output) {
    const lines = (output || '').split('\n').map((line) => line.trim()).filter(Boolean)
    const last = lines[lines.length - 1]
    if (!last || !/^\d+$/.test(last)) {
      throw new Error(`parseWpaCliNetworkId: could not find a network id in wpa_cli output: ${JSON.stringify(output)}`)
    }
    return last
  }

  static async connectToNetworkNmcli (ssid, iface, password) {
    const pwPart = password ? `password ${NetHelper.shellQuote(password)} ` : ''
    await execAsync(`sudo -n nmcli device wifi connect ${NetHelper.shellQuote(ssid)} ${pwPart}ifname ${NetHelper.shellQuote(iface)}`, { timeout: 30000 })
    return { manager: NetHelper.NETWORK_MANAGERS.NMCLI, iface, ssid }
  }

  // No single-shot "connect to this open SSID" command exists for
  // wpa_supplicant - a temporary network block is added, configured, and
  // selected step by step, since the id assigned by add_network is needed
  // for every call after it.
  static async connectToNetworkWpaCli (ssid, iface, password) {
    const quotedIface = NetHelper.shellQuote(iface)
    const { stdout } = await execAsync(`sudo -n wpa_cli -i ${quotedIface} add_network`, { timeout: 5000 })
    const networkId = NetHelper.parseWpaCliNetworkId(stdout)
    const qid = NetHelper.shellQuote(networkId)

    await execAsync(`sudo -n wpa_cli -i ${quotedIface} set_network ${qid} ssid ${NetHelper.shellQuote(`"${ssid}"`)}`, { timeout: 5000 })
    if (password) {
      await execAsync(`sudo -n wpa_cli -i ${quotedIface} set_network ${qid} psk ${NetHelper.shellQuote(`"${password}"`)}`, { timeout: 5000 })
    }
    else {
      await execAsync(`sudo -n wpa_cli -i ${quotedIface} set_network ${qid} key_mgmt NONE`, { timeout: 5000 })
    }
    await execAsync(`sudo -n wpa_cli -i ${quotedIface} enable_network ${qid}`, { timeout: 5000 })
    await execAsync(`sudo -n wpa_cli -i ${quotedIface} select_network ${qid}`, { timeout: 5000 })

    return { manager: NetHelper.NETWORK_MANAGERS.WPA_SUPPLICANT, iface, ssid, networkId }
  }

  // Joins a (normally open) WiFi network by SSID - used to hop onto a
  // Tasmota device's fallback AP. Returns a manager-agnostic handle to later
  // pass to forgetNetwork() for cleanup.
  static async connectToNetwork (ssid, { iface = 'wlan0', manager, password } = {}) {
    const resolved = manager || await NetHelper.detectNetworkManager()
    switch (resolved) {
      case NetHelper.NETWORK_MANAGERS.NMCLI: return NetHelper.connectToNetworkNmcli(ssid, iface, password)
      case NetHelper.NETWORK_MANAGERS.WPA_SUPPLICANT: return NetHelper.connectToNetworkWpaCli(ssid, iface, password)
      default: throw new Error(`Cannot connect to network: no supported network manager detected (got "${resolved}")`)
    }
  }

  // Removes what connectToNetwork() created (the handle it returned) - nmcli
  // auto-saves a new connection profile named after the SSID on every
  // connect, and a leftover wpa_supplicant network block would otherwise
  // stick around too. Without this, repeated recoveries accumulate stale
  // tasmota_XXXXXX-YYYY profiles that could even cause an unwanted
  // auto-reconnect to a long-gone AP later.
  static async forgetNetwork (handle) {
    switch (handle.manager) {
      case NetHelper.NETWORK_MANAGERS.NMCLI:
        return execAsync(`sudo -n nmcli connection delete ${NetHelper.shellQuote(handle.ssid)}`, { timeout: 10000 })
      case NetHelper.NETWORK_MANAGERS.WPA_SUPPLICANT:
        return execAsync(`sudo -n wpa_cli -i ${NetHelper.shellQuote(handle.iface)} remove_network ${NetHelper.shellQuote(handle.networkId)}`, { timeout: 5000 })
      default:
        throw new Error(`Cannot forget network: unsupported network manager "${handle.manager}"`)
    }
  }

  // Polls getCurrentConnection() until `iface` is actually connected to
  // `ssid` (including the DHCP lease settling), or throws once `timeoutMs`
  // elapses - confirms a hop actually landed before anything is queried over
  // HTTP through it.
  static async waitForConnection (ssid, { iface = 'wlan0', manager, timeoutMs = 15000, pollIntervalMs = 1000 } = {}) {
    const resolved = manager || await NetHelper.detectNetworkManager()
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const current = await NetHelper.getCurrentConnection(iface, resolved)
      if (current.connected && current.ssid === ssid) return current
      if (Date.now() >= deadline) {
        throw new Error(`waitForConnection: timed out waiting for ${iface} to connect to "${ssid}"`)
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
  }
}

module.exports = { extractChannelNum, NetHelper }
