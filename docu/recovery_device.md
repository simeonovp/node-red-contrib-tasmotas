# Tasmota AP-Fallback Recovery — Device & Host Guide

This is the operational companion to the AP-fallback recovery feature: what to do when a Tasmota device drops its configuration and starts broadcasting its own setup AP (`tasmota_XXXXXX-YYYY`), and what a Raspberry Pi host needs to be set up for so the automated assistant (`findTasmotaAPs`/`recoveryDevice`) can do this for you. For the underlying design decisions, see [recovery.md](./recovery.md); for the `tasmota-config` node's command signatures, see [config_node.md](./config_node.md).

## Manual recovery (available today)

1. **Find the device's MAC address.** Ideally already known from your own device list. Otherwise, connect your phone to `tasmota_XXXXXX-YYYY` and open `http://192.168.4.1/cm?cmnd=Status%205` - `StatusNET.Mac` shows it.
2. **Build the recovery command in Node-RED.** While still on your normal network, trigger a `tasmota-config` node (wired to your `tasmota-manager`) with:
   ```json
   { "action": "buildRecoveryCommand", "mac": "AA:BB:CC:DD:EE:FF" }
   ```
   The result on `msg.payload` includes a ready-to-open `url` (see [config_node.md](./config_node.md#buildrecoverycommand) for the full result shape). Get that URL onto your phone (debug sidebar, a message to yourself, ...).
3. **Join the device's AP** (`tasmota_XXXXXX-YYYY`) with your phone.
4. **Open the recovery URL** from step 2. This pushes SSID/password (and static IP, if known) to the device and restarts it.
5. **Rejoin your normal network** on your phone and confirm the device is back online (e.g. the manager's Devices tab).

If the result had `usedFallbackCredentials: true`, the SSID/password came from the `tasmota-manager` node's own `SSID`/`Password` settings fields rather than the device's cache - set those once if you haven't.

## Host setup for the automated assistant

The automated assistant (`NetHelper` in `nodes/lib/utils.js`, orchestrated by `recoveryDevice()` on `tasmota-manager`) scans for a device's fallback AP and hops the Pi's own WiFi onto it briefly to push the fix automatically, with a watchdog that unconditionally restores the Pi's original WiFi connection after a timeout - even if Node-RED crashes or is redeployed mid-hop. That watchdog is deliberately implemented as an independent `systemd` transient timer (`systemd-run --on-active=...`), not an in-process `setTimeout`, specifically so it survives the Node-RED process disappearing.

This means `NetHelper` needs to run several commands as root. All of them are invoked with `sudo -n` (fails immediately if not permitted, instead of hanging on a password prompt that can never be answered on a headless box) - so **passwordless sudo must be configured in advance** for exactly these binaries, on every Raspberry Pi host this assistant runs on:

- `nmcli`
- `wpa_cli`
- `iw`
- `systemd-run`
- `systemctl` (used to cancel an already-fired-early watchdog once `recoveryDevice()` has restored the connection itself)

### Setting up passwordless sudo

1. Find the exact binary paths on your Pi (they can differ slightly between Raspberry Pi OS releases):
   ```shell
   which nmcli wpa_cli iw systemd-run systemctl
   ```
2. Create a dedicated sudoers file (never edit `/etc/sudoers` directly - always use `visudo` so a syntax error can't lock you out):
   ```shell
   sudo visudo -f /etc/sudoers.d/tasmota-recovery
   ```
3. Add one `NOPASSWD` line per binary, using the paths from step 1 and the user Node-RED actually runs as (commonly `pi` or `node-red` - check with `systemctl show -p User node-red.service` or `ps -o user= -p $(pgrep -f node-red)`):
   ```
   node-red ALL=(root) NOPASSWD: /usr/bin/nmcli *
   node-red ALL=(root) NOPASSWD: /usr/sbin/wpa_cli *
   node-red ALL=(root) NOPASSWD: /usr/sbin/iw *
   node-red ALL=(root) NOPASSWD: /usr/bin/systemd-run *
   node-red ALL=(root) NOPASSWD: /usr/bin/systemctl *
   ```
   Save and exit - `visudo` validates the syntax before writing.
4. Verify each one **non-interactively**, the same way `NetHelper` calls them (`-n` fails fast instead of prompting if something's still wrong):
   ```shell
   sudo -n nmcli general status
   sudo -n wpa_cli status
   sudo -n iw dev wlan0 scan | head
   sudo -n systemd-run --unit=sudo-test --on-active=5 --collect -- /bin/true
   sudo -n systemctl stop sudo-test
   ```
   Each should run without asking for a password. If one fails with `sudo: a password is required`, double check the username and binary path in the sudoers file.

Keep the sudoers file scoped to exactly these five binaries - don't broaden it to `ALL` commands.

## Automated recovery (recoveryDevice)

Once the sudoers setup above is in place, triggering a `tasmota-config` node with `{ "action": "recoveryDevice", "ssid": "tasmota_XXXXXX-YYYY" }` (see [config_node.md](./config_node.md#recoverydevice) for the full signature) replaces manual steps 1-5 above with:

1. Captures the host's current WiFi connection (`NetHelper.getCurrentConnection()`).
2. Arms the watchdog **before touching anything** - if nothing was connected to begin with, it schedules a disconnect instead of an invented "activate", so the host always returns to its exact prior state.
3. Joins the given Tasmota AP (`NetHelper.connectToNetwork()`), waiting until the connection and a `192.168.4.x` DHCP lease are actually confirmed before continuing.
4. Queries the device's MAC (`Status 5`) and looks for a cached `decode-config.py` dump for it (via the same MAC-derived lookup `buildRecoveryCommand` uses) - this also works for a **brand-new device** that was never seen before (no DB entry, no cached config), as long as `override`/the manager's fallback fields supply enough to build a command (typically `override.ip` for its static IP, since a new device has no cache to pull that from).
5. Pushes the recovery config - which of two ways depends on whether step 4 found a cache:
   - **Cache found** (`mode: 'full-restore'`): the device's *entire* configuration is restored via `decode-config.py --restore-file` against `192.168.4.1` - not just network/IP, but module/GPIO assignment, relay/friendly names, rules, sensor config, everything that was in the cached dump. `override` is merged into a copy of that config first. This is the case the whole feature exists for: a device that lost its configuration outright (not just its WiFi credentials - Tasmota's normal WifiManager retry-AP mode leaves the rest of Settings intact and wouldn't need this) needs more than network settings back to actually be itself again. A best-effort `Restart 1` follows the restore - its failure is only logged, since the device may have already rebooted and left the AP on its own by the time it's sent. There's **no automatic fallback** to the minimal push if the restore itself fails - that's reported as an error, not silently downgraded to a partial fix (which could mask a deeper problem, e.g. the cached dump's schema not matching the device's current firmware version).
   - **No cache found** (`mode: 'backlog'`): falls back to the minimal `buildRecoveryCommand` Backlog push (`SSId1`/`Password1`/`IpAddress1-5`/`Restart 1`) - there's nothing to fully restore for a device that's never been backed up.
   
   Either way, if the device wasn't already in the device DB, a minimal stub row is added afterward so it doesn't stay invisible to `getDbDevices`/the Devices tab.
6. **Always** - success or failure, at any step - restores the original connection immediately (not waiting for the watchdog), removes the temporary WiFi profile the hop created, and cancels the now-unneeded watchdog. Any error is still reported normally through the node (`done(err)`); the cleanup happening doesn't change whether the call itself succeeded.

If step 6's own restore fails (rare - e.g. `nmcli`/`wpa_cli` itself misbehaving), that failure is only logged (`node.error`) - the watchdog armed in step 2 is the actual safety net at that point and will still fire after `Watchdog timeout` seconds.

**Known limitation**: a full restore (step 5, `mode: 'full-restore'`) can fail if the cached dump was taken with a different `decode-config.py`/firmware version than what the device is currently running, since the Settings binary layout can change between versions. This hasn't been verified against real hardware yet - the same goes for whether `--restore-file` triggers its own reboot (informing whether step 5's explicit `Restart 1` is redundant-but-harmless or actually load-bearing).

## GUI: the Assistants tab

The `tasmota-manager` editor also has an **Assistants** tab (**Recovery devices** block) that drives the same `findTasmotaAPs`/`recoveryDevice` functionality without building a flow:

- **Scan net** - triggers a scan and lists every visible Tasmota fallback AP, each flagged `known`/`unknown` (matched against the device DB by MAC). An `unknown` row isn't blocked - a genuinely new device is unknown by definition - but clicking its **Recovery** button asks for confirmation first, since it could just as easily be a neighbor's Tasmota device.
- **Repeat every (h)** (default 24, `0` disables it) re-runs the scan automatically in the background and caches the result, so the table has something to show the next time you open the tab without needing a fresh scan.
- **Use IP** is the same `override.ip` from step 4 above, applied to every Recovery click from this tab - mainly useful when recovering a brand-new device.
- Each row's **Recovery** button calls `recoveryDevice(ssid, override)` for that specific AP and reports success/failure as an editor notification.

This is implemented via three admin routes on `tasmota-manager` (`GET .../tasmota-aps`, `POST .../tasmota-aps/scan`, `POST .../recovery-device`) rather than through a `tasmota-config` node - see `nodes/tasmota_manager.js` if you need the exact request/response shapes.

### Inspecting a scheduled watchdog activation afterwards

`NetHelper.scheduleConnectionActivation()` only confirms the timer was armed - by design, nothing reports back to Node-RED about whether the activation itself later succeeded (that's the whole point of it being independent of the Node-RED process). To check what actually happened once the timeout has passed:

```shell
journalctl -u <unitName>
```

(`<unitName>` is returned by `scheduleConnectionActivation()`, and defaults to `tasmota-recovery-<timestamp>-<random>` if not given explicitly.) The unit auto-removes itself after running (`--collect`), so this only works for a little while after it fires - check it promptly if you need to confirm success.
