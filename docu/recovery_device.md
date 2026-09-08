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

## decode-config.py's own Python dependencies

`decode-config.py` (used for the cached config download and the full-config restore below) has its own Python dependencies, e.g. `configargparse` - not installed by a default Python setup. Rather than requiring a manual `pip install` on every host, the manager detects a missing module from decode-config.py's own error output (`No module named 'x'`) and installs it automatically into a **local, per-manager folder** (`resources/<name>/configs/pylibs/`, via `pip install --target`) - not system-wide, no root needed. This needs the Pi to have internet access and a working `pip` for whichever `python` is on Node-RED's `PATH`; if that install itself fails (no internet, no pip, ...), the manager logs a clear error with the manual fallback command (`python -m pip install <module>`).

## Host setup for the automated assistant

The automated assistant (`NetHelper` in `nodes/lib/utils.js`, orchestrated by `recoveryDevice()` on `tasmota-manager`) scans for a device's fallback AP and hops the Pi's own WiFi onto it briefly to push the fix automatically, with a watchdog that unconditionally restores the Pi's original WiFi connection after a timeout - even if Node-RED crashes or is redeployed mid-hop. That watchdog is deliberately implemented as an independent `systemd` transient timer (`systemd-run --on-active=...`), not an in-process `setTimeout`, specifically so it survives the Node-RED process disappearing.

This means `NetHelper` needs to run several commands as root. All of them are invoked with `sudo -n` (fails immediately if not permitted, instead of hanging on a password prompt that can never be answered on a headless box) - so **passwordless sudo must be configured in advance** for exactly these binaries, on every Raspberry Pi host this assistant runs on:

- `nmcli`
- `wpa_cli`
- `iw`
- `systemd-run`
- `systemctl` (used to cancel an already-fired-early watchdog once `recoveryDevice()` has restored the connection itself)

### Setting up passwordless sudo

A blanket `NOPASSWD: /usr/bin/nmcli *`-style rule per binary is the quickest way to get this working, but it's needlessly broad - `systemd-run *` in particular is equivalent to unrestricted root code execution (`sudo systemd-run /bin/bash` would work just as well as our intended use), and `systemctl *` can stop/start/kill any unit on the system, not just our own watchdog timers. If the Node-RED process is ever compromised (a malicious flow, a vulnerable dependency, ...), those two blanket rules would hand over full root, not just "control WiFi". The rules below are scoped to exactly the command shapes `NetHelper` (`nodes/lib/utils.js`) actually generates instead.

1. Find the exact binary paths on your Pi (they can differ slightly between Raspberry Pi OS releases):
   ```shell
   which nmcli wpa_cli iw systemd-run systemctl
   ```
2. Create a dedicated sudoers file (never edit `/etc/sudoers` directly - always use `visudo` so a syntax error can't lock you out):
   ```shell
   sudo visudo -f /etc/sudoers.d/tasmota-recovery
   ```
3. Add the following, using the paths from step 1 and the user Node-RED actually runs as (commonly `pi` or `node-red` - check with `systemctl show -p User node-red.service` or `ps -o user= -p $(pgrep -f node-red)`). Every `*` below stands in for a value that's inherently variable (an SSID, a connection name, a network interface, the watchdog's own generated timestamp/description) - nothing here allows a different *command* to run, only different *arguments* to the same fixed one:
   ```
   # nmcli - status/scan queries, and connect/disconnect/delete only
   # (the -f field list is left as a wildcard below to sidestep the question
   # of whether sudoers needs its embedded comma escaped - it's a read-only
   # query either way, so a wider match there is low-risk)
   node-red ALL=(root) NOPASSWD: /usr/bin/nmcli general status
   node-red ALL=(root) NOPASSWD: /usr/bin/nmcli -t -f * dev wifi list ifname * --rescan yes
   node-red ALL=(root) NOPASSWD: /usr/bin/nmcli -t -f * device status
   node-red ALL=(root) NOPASSWD: /usr/bin/nmcli -t -f * dev wifi
   node-red ALL=(root) NOPASSWD: /usr/bin/nmcli connection up *
   node-red ALL=(root) NOPASSWD: /usr/bin/nmcli device disconnect *
   node-red ALL=(root) NOPASSWD: /usr/bin/nmcli device wifi connect *
   node-red ALL=(root) NOPASSWD: /usr/bin/nmcli connection delete *

   # wpa_cli - status/scan queries, and the network-block lifecycle used to join/leave a fallback AP
   node-red ALL=(root) NOPASSWD: /usr/sbin/wpa_cli status
   node-red ALL=(root) NOPASSWD: /usr/sbin/wpa_cli -i * status
   node-red ALL=(root) NOPASSWD: /usr/sbin/wpa_cli -i * disconnect
   node-red ALL=(root) NOPASSWD: /usr/sbin/wpa_cli -i * select_network *
   node-red ALL=(root) NOPASSWD: /usr/sbin/wpa_cli -i * add_network
   node-red ALL=(root) NOPASSWD: /usr/sbin/wpa_cli -i * set_network * ssid *
   node-red ALL=(root) NOPASSWD: /usr/sbin/wpa_cli -i * set_network * psk *
   node-red ALL=(root) NOPASSWD: /usr/sbin/wpa_cli -i * set_network * key_mgmt NONE
   node-red ALL=(root) NOPASSWD: /usr/sbin/wpa_cli -i * enable_network *
   node-red ALL=(root) NOPASSWD: /usr/sbin/wpa_cli -i * remove_network *

   # iw - scan only
   node-red ALL=(root) NOPASSWD: /usr/sbin/iw dev * scan

   # systemd-run - ONLY the watchdog's own 4 possible payloads, unit name
   # forced to our own tasmota-recovery- prefix (never a bare shell/anything
   # else). Note the payload after "--" is the *bare* command name (nmcli/
   # wpa_cli, no /usr/bin/ prefix) - that's the literal string NetHelper puts
   # there (buildActivateCommand()/buildDisconnectCommand() in utils.js),
   # resolved via $PATH by systemd-run itself at run time, not by us.
   node-red ALL=(root) NOPASSWD: /usr/bin/systemd-run --unit=tasmota-recovery-* --on-active=* --collect --description=* -- nmcli connection up *
   node-red ALL=(root) NOPASSWD: /usr/bin/systemd-run --unit=tasmota-recovery-* --on-active=* --collect --description=* -- wpa_cli -i * select_network *
   node-red ALL=(root) NOPASSWD: /usr/bin/systemd-run --unit=tasmota-recovery-* --on-active=* --collect --description=* -- nmcli device disconnect *
   node-red ALL=(root) NOPASSWD: /usr/bin/systemd-run --unit=tasmota-recovery-* --on-active=* --collect --description=* -- wpa_cli -i * disconnect

   # systemctl - only stopping our own watchdog units, nothing else on the system
   node-red ALL=(root) NOPASSWD: /usr/bin/systemctl stop tasmota-recovery-*
   ```
   Save and exit - `visudo` validates the syntax before writing.

   **Constraint this introduces**: `NetHelper.scheduleConnectionActivation()` normally auto-generates a `tasmota-recovery-<timestamp>-<random>` unit name, which already matches. If you ever pass a custom `unitName` explicitly (only used in tests today, not in production code), it must also start with `tasmota-recovery-`, or these `systemd-run`/`systemctl` rules won't authorize it and the call will fail fast (`sudo: a password is required`, thanks to `-n`) rather than silently falling back to a password prompt.

4. Verify each one **non-interactively**, the same way `NetHelper` calls them (`-n` fails fast instead of prompting if something's still wrong). The `systemd-run`/`systemctl` pair is the trickiest to get exactly right (multi-word pattern matching) - test that combination specifically, not just the simpler single-command rules:
   ```shell
   sudo -n nmcli general status
   sudo -n wpa_cli status
   sudo -n iw dev wlan0 scan | head
   sudo -n systemd-run --unit=tasmota-recovery-sudotest --on-active=5 --collect --description='sudo test' -- nmcli connection up test
   sudo -n systemctl stop tasmota-recovery-sudotest
   ```
   Each should run without asking for a password (the `nmcli connection up test` inside the timer will itself fail immediately after it fires, since "test" isn't a real connection - that's fine, this is only checking that `sudo`/`systemd-run` accepted the invocation, not that the fake connection exists). If one fails with `sudo: a password is required`, compare the exact command it's trying against the rule text character-for-character - a mismatched flag or path silently breaks the match.

Keep the sudoers file scoped to exactly the lines above - resist the urge to collapse them back into `nmcli *`/`systemd-run *` for convenience, since that's exactly the broad access this section exists to avoid. Whenever `NetHelper`'s command-building changes, revisit this list too - it's a hand-maintained mirror of what the code generates, not derived from it automatically.

## Automated recovery (recoveryDevice)

Once the sudoers setup above is in place, triggering a `tasmota-config` node with `{ "action": "recoveryDevice", "ssid": "tasmota_XXXXXX-YYYY" }` (see [config_node.md](./config_node.md#recoverydevice) for the full signature) replaces manual steps 1-5 above with:

1. Captures the host's current WiFi connection (`NetHelper.getCurrentConnection()`).
2. Arms the watchdog **before touching anything** - if nothing was connected to begin with, it schedules a disconnect instead of an invented "activate", so the host always returns to its exact prior state.
3. Joins the given Tasmota AP (`NetHelper.connectToNetwork()`), waiting until the connection and a `192.168.4.x` DHCP lease are actually confirmed before continuing (`wpa_supplicant` hosts only for now - `NetHelper.getCurrentConnectionNmcli()` doesn't query an IP yet, so this wait is a no-op there; see its comment in `nodes/lib/utils.js`).
4. Queries the device's MAC (`Status 5`) and looks for a cached `decode-config.py` dump for it (via the same content-based scan `buildRecoveryCommand` uses - every cached `.json` file is checked for a `mqtt_topic`/`hostname`/`ip_address` match, not just a guessed filename, since recovery is rare enough that the extra robustness is worth more than the extra I/O) - this also works for a **brand-new device** that was never seen before (no DB entry, no cached config), as long as `override`/the manager's fallback fields supply enough to build a command (typically `override.ip` for its static IP, since a new device has no cache to pull that from).
5. Pushes the recovery config - which of two ways depends on whether step 4 found a cache:
   - **Cache found** (`mode: 'full-restore'`): the device's *entire* configuration is restored via `decode-config.py --restore-file` against `192.168.4.1` - not just network/IP, but module/GPIO assignment, relay/friendly names, rules, sensor config, everything that was in the cached dump. `override` is merged into a copy of that config first. This is the case the whole feature exists for: a device that lost its configuration outright (not just its WiFi credentials - Tasmota's normal WifiManager retry-AP mode leaves the rest of Settings intact and wouldn't need this) needs more than network settings back to actually be itself again. A best-effort `Restart 1` follows the restore - its failure is only logged, since the device may have already rebooted and left the AP on its own by the time it's sent. There's **no automatic fallback** to the minimal push if the restore itself fails - that's reported as an error, not silently downgraded to a partial fix (which could mask a deeper problem, e.g. the cached dump's schema not matching the device's current firmware version).
   - **No cache found** (`mode: 'backlog'`): falls back to the minimal `buildRecoveryCommand` Backlog push (`SSId1`/`Password1`/`IpAddress1-5`/`Restart 1`) - there's nothing to fully restore for a device that's never been backed up.
   
   Either way, if the device wasn't already in the device DB, a minimal stub row is added afterward so it doesn't stay invisible to `getDbDevices`/the Devices tab.
6. **Always** - success or failure, at any step - restores the original connection immediately (not waiting for the watchdog), removes the temporary WiFi profile the hop created, and cancels the now-unneeded watchdog. Any error is still reported normally through the node (`done(err)`); the cleanup happening doesn't change whether the call itself succeeded.

If step 6's own restore fails (rare - e.g. `nmcli`/`wpa_cli` itself misbehaving), that failure is only logged (`node.error`) - the watchdog armed in step 2 is the actual safety net at that point and will still fire after `Watchdog timeout` seconds.

**Verified against real hardware** (2026-09-08): a full restore (step 5, `mode: 'full-restore'`) has completed successfully end-to-end on an actual device, `SUCCESS after 16912ms - mode=full-restore`. `--restore-file` does **not** trigger its own reboot by itself - the device was still responsive enough afterward for the explicit `Restart 1` to be acknowledged before it rebooted - so that explicit restart is load-bearing, not redundant-but-harmless as originally suspected.

**Known limitation**: a full restore can still fail if the cached dump was taken with a different `decode-config.py`/firmware version than what the device is currently running, since the Settings binary layout can change between versions - that would surface as a normal error, not something this feature works around.

## GUI: the Assistants tab

The `tasmota-manager` editor also has an **Assistants** tab (**Recovery devices** block) that drives the same `findTasmotaAPs`/`recoveryDevice` functionality without building a flow:

- **Scan net** - triggers a scan and lists every visible Tasmota fallback AP, each flagged `known`/`unknown` (matched against the device DB by MAC). An `unknown` row isn't blocked - a genuinely new device is unknown by definition - but clicking its **Recovery** button asks for confirmation first, since it could just as easily be a neighbor's Tasmota device.
- **Repeat every (h)** (default 24, `0` disables it) re-runs the scan automatically in the background and caches the result, so the table has something to show the next time you open the tab without needing a fresh scan.
- **Use IP** is the same `override.ip` from step 4 above, applied to every Recovery click from this tab - mainly useful when recovering a brand-new device.
- Each row's **Recovery** button calls `recoveryDevice(ssid, override)` for that specific AP and reports success/failure as an editor notification.

This is implemented via three admin routes on `tasmota-manager` (`GET .../tasmota-aps`, `POST .../tasmota-aps/scan`, `POST .../recovery-device`) rather than through a `tasmota-config` node - see `nodes/tasmota_manager.js` if you need the exact request/response shapes.

### Why a recovered device doesn't linger in the scan table

A device that was just recovered is, by definition, being told to leave AP mode - but a live WiFi scan run right after `Restart 1` would likely still catch it mid-reboot and report it as still there, since Tasmota needs a few seconds to actually reboot and drop its fallback AP. On success, `recoveryDevice()` therefore removes that SSID from the cached scan (`lastTasmotaScan`) immediately, so reopening the editor - which only re-reads that cache (`GET .../tasmota-aps`) rather than scanning live - reflects the fix right away instead of showing the device as still broken. The editor also waits 15s after a Recovery click before running its own confirmation re-scan, giving the device time to actually reboot first; that scan is not time-critical, so waiting is cheaper than a premature one re-adding the device to the cache it was just removed from.

### Inspecting a scheduled watchdog activation afterwards

`NetHelper.scheduleConnectionActivation()` only confirms the timer was armed - by design, nothing reports back to Node-RED about whether the activation itself later succeeded (that's the whole point of it being independent of the Node-RED process). To check what actually happened once the timeout has passed:

```shell
journalctl -u <unitName>
```

(`<unitName>` is returned by `scheduleConnectionActivation()`, and defaults to `tasmota-recovery-<timestamp>-<random>` if not given explicitly.) The unit auto-removes itself after running (`--collect`), so this only works for a little while after it fires - check it promptly if you need to confirm success.
