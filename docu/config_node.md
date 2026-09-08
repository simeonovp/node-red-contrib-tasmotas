# tasmota-config — Command Reference

The `tasmota-config` node (type `tasmota-config`) is a thin dispatcher: it forwards one command ("action") to the `tasmota-manager` node it's configured with, puts the result on `msg.payload`, and sends the message on. This document lists every action it currently supports, its exact input/output signature, and a few non-obvious behaviours you'll otherwise only find by reading the source (`nodes/tasmota_config.js`, `nodes/tasmota_manager.js`).

## How to trigger an action

Send a message with `msg.action` set to one of the action names below. If `msg.action` is not set, `msg.topic` is used instead (`msg.action = msg.action || msg.topic`) - this is what lets a Dashboard button set its `topic` field directly to an action name (see the *Config node example flow* in the main [README](../README.md)) without a separate Change node.

A few actions (`findAP`, `httpCommand`) *also* fall back to `msg.topic` for their own primary argument. This only matters when something upstream has already set `msg.action` explicitly (e.g. a Change node) while leaving the original `msg.topic` value in place to be reused as that action's argument - see the individual actions below. If you rely on this, set `msg.action` and the dedicated field (`msg.bssid`, `msg.command`, ...) explicitly instead; it's clearer and avoids the fallback-onto-topic ambiguity entirely.

## Shared behaviour

- **No manager configured**: the node immediately calls `done('Manager not found')` and does nothing else.
- **Unknown action**: the node logs `node.warn('Unknown action:' + msg.action)` and returns *without* sending the message onward - nothing appears on the output wire.
- **Errors**: any exception a manager method throws (or, for `async` actions, rejects with) is passed to `done(err)`, which reports it through Node-RED's normal error path (Catch node, red triangle on the node, debug sidebar) - not through `msg.payload`. Note `backupResources()` catches its own errors internally and reports them via the *manager* node's `error()`, so a failed backup does **not** trigger `done(err)` on the config node.
- **Known action, success**: `msg.payload` is replaced with the action's result (see table), then `send(msg)` and `done()` are called - synchronous actions do this in the same tick, `async` ones after the awaited work completes.

## Actions at a glance

| Action | Sync/Async | Required | Optional | `msg.payload` result |
| --- | --- | --- | --- | --- |
| `backupResources` | sync | - | `msg.payload` (backup dir, default `'./backup'`) | unchanged (passthrough) - side effect only |
| `loadMqttMap` | sync | - | - | `{ "<ip>": "<mqttTopic>", ... }` |
| `findAP` | sync | `msg.bssid` or `msg.topic` | - | matched device-DB row, or `undefined` if newly seen |
| `listDevices` | sync | - | - | `[{ "<mqttTopic>": "<ip>" }, ...]` |
| `listDeviceNodes` | sync | - | - | `[{ "<name-or-host>": "<nodeId>" }, ...]` |
| `listDbDevices` | sync | - | `msg.payload` (`'ip'` \| `'host'` \| other) | array, shape depends on `msg.payload` - see below |
| `getDbDevices` | sync | - | - | `[{ fw, grp, host, ip, mac, name }, ...]` |
| `httpCommand` | async | `msg.ip` or `msg.host`; `msg.command` or `msg.topic` | `msg.payload` (command argument) | parsed JSON/text response from the device |
| `downloadConfig` | async | `msg.ip` or `msg.host` | `msg.force` | full parsed `decode-config.py` dump, or `undefined` on failure |
| `downloadAllConfigs` | async | - | `msg.force` | unchanged (passthrough) - side effect only |
| `scanNetwork` | async | - (manager's `Network` field must be set) | - | unchanged (passthrough) - side effect only |
| `buildRecoveryCommand` | sync | `msg.mac` | `msg.override` (`{ ssid, password, ip, mask, gateway }`) | `{ found, alreadyKnown, mac, ip, host, command, url, usedFallbackCredentials, hasStaticIp }` |
| `findTasmotaAPs` | async | - | `msg.iface` (default manager's `WiFi interface`, else `'wlan0'`) | `[{ ssid, signal, unit, macSuffix, chipId }, ...]` |
| `recoveryDevice` | async | `msg.ssid` (the Tasmota AP to join) | `msg.override` (`{ ssid, password, ip, mask, gateway }`) | `{ mac, mode, found, alreadyKnown, ip, host, command, url, usedFallbackCredentials, hasStaticIp }` |

## Action details

### `backupResources`
Copies the manager's entire resource folder (`resources/<manager-name>/` - device DB, cached configs, icons, mqtt map) to `<msg.payload || './backup'>/<manager-name>_<YYMMDD>/`.
```js
msg.action = 'backupResources'
msg.payload = './backups'  // optional, defaults to './backup'
```
`msg.payload` is **not** overwritten with a result - it still holds whatever backup-dir value you passed in.

### `loadMqttMap`
Returns (and refreshes from disk) the manager's IP → MQTT-topic map, used internally to locate each device's cached config file.
```js
msg.payload // -> { "10.0.0.9": "tasmota_A1B2C3", "10.0.0.12": "tasmota_D4E5F6" }
```

### `findAP`
Looks up a device by its WiFi access-point BSSID/MAC (case-insensitive), typically one seen in another device's `STATUS 11` response.
```js
msg.action = 'findAP'
msg.bssid = 'AA:BB:CC:DD:EE:FF' // or use msg.topic instead of msg.bssid
```
If the BSSID is already a known device, returns its full device-DB row (`{ fw, grp, host, ip, mac, name }`). If it's not yet known, the manager adds a stub row (`{ mac }`) for future resolution and this call returns `undefined` - check for a truthy result, don't assume the AP is one of your own devices.

### `listDevices`
All IP addresses the manager has ever resolved a Tasmota MQTT topic for, from its cached configs.
```js
msg.payload // -> [{ "tasmota_A1B2C3": "10.0.0.9" }, ...]
```

### `listDeviceNodes`
The `tasmota-device` config nodes currently registered with this manager from a **deployed flow** (not the persisted device DB).
```js
msg.payload // -> [{ "Living Room Plug": "1a88b745512d3c2f" }, ...]
```

### `listDbDevices`
Reads the persisted device DB (`resources/<name>/devices.json`). `msg.payload` on input selects the shape of the result:
```js
msg.action = 'listDbDevices'
msg.payload = 'ip' // or 'host', or omitted
```
- `'ip'`: one entry per device with both `fw` and `ip` set - `{ "<mqttTopic>": "<ip>" }` if the topic is known, otherwise the plain `ip` string.
- `'host'`: same idea keyed by `host` (skips devices with no host or `host === '?'`).
- anything else / omitted: plain array of MQTT topic strings, only for devices where `fw`, `ip` **and** a resolved MQTT topic are all present.

### `getDbDevices`
All device-DB rows the manager considers "known" (i.e. `fw` is set - it has actually replied to a discovery/config download at some point).
```js
msg.payload // -> [{ fw: 1, grp: 0, host: 'plug1', ip: '10.0.0.9', mac: 'AA:BB:...', name: 'Plug 1' }, ...]
```

### `httpCommand`
Sends a raw Tasmota HTTP command (`GET http://<ip>/cm?cmnd=<command>[ <value>]`) and returns the parsed response.
```js
msg.action = 'httpCommand'
msg.ip = '10.0.0.9'       // or msg.host
msg.command = 'Status'    // or msg.topic
msg.payload = '11'        // optional command argument
```
```js
msg.payload // -> { "StatusNET": { "Mac": "AA:BB:CC:DD:EE:FF", ... } }
```

### `downloadConfig`
Runs `decode-config.py` against a device (or reuses the cached JSON if one already exists and `msg.force` is falsy) and returns it.
```js
msg.action = 'downloadConfig'
msg.ip = '10.0.0.9' // or msg.host
msg.force = true    // optional, re-download even if a cache file exists
```
`msg.payload` becomes the full decode-config JSON (dozens of fields, e.g. `sta_ssid`, `sta_pwd`, `ip_address`, `mqtt_topic`, `friendlyname`, `hostname`, ...), or `undefined` if the download failed (commonly: python/`decode-config.py` not available).

### `downloadAllConfigs`
Refreshes the cached config for every known device (`fw` + `ip` set) that doesn't already have one, unless `msg.force` is set.
```js
msg.action = 'downloadAllConfigs'
msg.force = true // optional
```
Side effect only - `msg.payload` passes through unchanged.

### `scanNetwork`
Probes every address in the manager's configured `Network` (CIDR, e.g. `192.168.1.0/24`) for a Tasmota device (`Topic` command) and downloads its config on discovery. Silently does nothing if a scan is already running on that manager, or if `Network` isn't configured (logs an error in that case).
```js
msg.action = 'scanNetwork'
```
Side effect only - `msg.payload` passes through unchanged.

### `buildRecoveryCommand`
Builds a ready-to-use Tasmota recovery command/URL for a device that has fallen back to its own setup AP (SSID `tasmota_XXXXXX-YYYY`) - see [recovery_device.md](./recovery_device.md) for the full manual recovery workflow this supports.
```js
msg.action = 'buildRecoveryCommand'
msg.mac = 'AA:BB:CC:DD:EE:FF'
msg.override = { ssid: 'homessid', password: 'homepass' } // optional, see below
```
Field priority for `ssid`/`password`/`ip`/`gateway`/`mask`: `msg.override` > the device's own cached `decode-config.py` dump > the manager's fallback `ssid`/`password` fields (WiFi credentials only - there's no manager-level fallback for `ip`/`gateway`/`mask`, only cache or an explicit override). Each `IpAddress*` line is only included when that specific field actually has a value (from override or cache) - a partial override (e.g. just `ip`+`gateway`) is combined with whatever the cache still provides for the rest.

The device doesn't need to be in the device DB already - a brand-new device (never seen before, no cached config) still works as long as `msg.override`/the manager's fallback fields supply `ssid`+`password` (e.g. `msg.override.ip` for its static IP, since there's no cache to pull that from). `found` only means "a command could be built" - check `alreadyKnown` if you need to distinguish a previously-known device from a new one.

The device DB is treated as the least trustworthy source (it can go stale - a device's IP changes, a name gets edited, ...), so it's only ever a *fallback*. The cached config is located by scanning every cached `.json` file's own *content* (not by guessing a filename from the DB) - a file whose `mqtt_topic`/`hostname` matches the MAC-derived default Tasmota topic name (`tasmota_XXXXXX`, from the last 3 MAC bytes - same identifier `findTasmotaAPs` extracts from a fallback-AP SSID) wins first, then a file matching the DB's `host` (e.g. a manually renamed topic), then a file matching the DB's `ip`, in that order - the filename itself is never used to identify a device. Likewise the result's `ip`/`host` prefer the cache's own `ip_address`/`hostname` over the DB row whenever both exist.
```js
msg.payload
// found:
// {
//   found: true, alreadyKnown: true, mac: 'AA:BB:CC:DD:EE:FF', ip: '10.0.0.9', host: 'plug1',
//   command: 'Backlog SSId1 myssid;Password1 mypass;IpAddress1 10.0.0.9;...;Restart 1',
//   url: 'http://192.168.4.1/cm?cmnd=Backlog%20SSId1%20myssid...',
//   usedFallbackCredentials: false, // true if SSID/password came from the manager's fallback fields, not override/cache
//   hasStaticIp: true               // false if the device was on DHCP or has no cached config/override at all
// }
// no ssid/password available from override, cache, or manager fallback:
// { found: false, mac: 'AA:BB:CC:DD:EE:FF' }
```

### `findTasmotaAPs`
Scans for currently visible Tasmota fallback APs (`tasmota_XXXXXX-YYYY`) using the manager's `WiFi interface` setting (or `msg.iface` to override it for this call). Shares a busy-guard with `recoveryDevice` - both use the same WiFi radio and refuse to run concurrently (`done(err)` with "a WiFi scan/recovery is already in progress").
```js
msg.action = 'findTasmotaAPs'
msg.iface = 'wlan0' // optional
```
```js
msg.payload // -> [{ ssid: 'tasmota_A1B2C3-4210', signal: 55, unit: 'percent', macSuffix: 'A1B2C3', chipId: 4210 }, ...]
```

### `recoveryDevice`
Automates the manual `buildRecoveryCommand` workflow end to end: captures this host's current WiFi connection, arms an independent systemd watchdog (see [recovery_device.md](./recovery_device.md#automated-recovery-recoverydevice)), hops onto the given Tasmota AP, queries its MAC, then pushes its recovery config, then **always** - on success or failure - explicitly restores the original connection, removes the temporary WiFi profile the hop created, and cancels the watchdog.

What actually gets pushed depends on whether a cached `decode-config.py` dump exists for the device (`msg.payload.mode` in the result tells you which happened):
- **`mode: 'full-restore'`** - a cached config exists, so the device's *entire* configuration is restored via `decode-config.py --restore-file` (module/GPIO, relay names, rules, sensors, ... - not just network/IP). `msg.override` is merged into a copy of the cached config first (same fields/priority as `buildRecoveryCommand`). This is the important case: a device that genuinely lost its configuration (not just its WiFi credentials) needs more than network settings back to be itself again. There's no automatic fallback to the minimal push if this fails - a failed restore is reported as an error rather than silently downgrading to a partial fix. A best-effort `Restart 1` follows the restore (failure here is only logged - the device may have already rebooted and left the AP on its own).
- **`mode: 'backlog'`** - no cached config (a brand-new device, or one whose cache was never downloaded) - falls back to the minimal `buildRecoveryCommand` Backlog push (same `msg.override` shape and priority rules) - there's nothing to fully restore for a device that's never been backed up.
```js
msg.action = 'recoveryDevice'
msg.ssid = 'tasmota_A1B2C3-4210'          // the Tasmota AP to join (distinct from msg.override.ssid below)
msg.override = { ssid: 'homessid', password: 'homepass' } // optional, values written to the device
```
```js
msg.payload // -> { mac: 'AA:BB:CC:DD:EE:FF', mode: 'full-restore', found: true, ip: ..., host: ..., command: ..., url: ..., usedFallbackCredentials: ..., hasStaticIp: ... }
```
Any failure (couldn't join the AP, no known configuration for the discovered MAC, the restore itself failing, ...) is reported via `done(err)` as usual - the restore/cleanup still happens regardless, it just doesn't change whether the action itself succeeded or failed. If the recovered device wasn't already in the device DB (`alreadyKnown: false`), a minimal stub row (`mac` + whatever IP was used) is added automatically so it doesn't stay permanently invisible to `getDbDevices`/the Devices tab.

The `tasmota-manager` editor's **Assistants** tab drives this same functionality (plus a periodic re-scan and a known/unknown-device warning) through dedicated admin routes rather than through this node - see [recovery_device.md](./recovery_device.md#automated-recovery-recoverydevice).
