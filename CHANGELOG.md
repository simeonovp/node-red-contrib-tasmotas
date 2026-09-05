TODOs:
-------------------
Code review findings (2026-09-04)
-------------------
Bugs:
 - tasmota_rf_device.js: `this.lastBridge = bridgeTopic || manager.defaultBridge || ''` throws when the configured manager id no longer resolves to a node (e.g. a stale/deleted reference after a partial redeploy) - `manager` is `undefined` in that case, not the empty string you'd get when unconfigured, and this line (unlike the other `manager?.` call sites in the same file) doesn't use optional chaining. Confirmed by a regression test.
 - tasmota_rf_manager.js: getTimings()/saveTimings() call .find(...) on this.rf433Data[group] without checking the result, throws if device/group not found yet
 - tasmota_rf_manager.js + tasmota_rf_device.js: addListener(code, fn.bind(this)) / removeListener(code, fn.bind(this)) use a new bound function each time, so removeListener never actually removes the original listener -> listener leak on node close/redeploy
 - tasmota_manager.js: _spawnDecodeConfig() spawns 'python' with no 'error' handler and no check whether python/python3 is installed -> unhandled error event / unclear failure for users
 - tasmota_shutter.js: onSend() branches on `this.shutter.position` to show a green "Open"/"Closed" status at the 0%/100% end stops, but the Shutter class (tasmota_device.js) only ever sets `this.data.Position` - `.position` is always undefined, so the green status is never shown, only the grey "N%" fallback, even fully open/closed. Test: tasmota_shutter_spec.js.
 - tasmota_manager.js: getDbDevices() does `this.dbDevices['devices'].filter(...)` unconditionally, but DbBase#load() leaves `data = {}` (no `.devices` key) when the backing JSON file doesn't exist yet - throws a TypeError on a brand-new install before devices.json has ever been downloaded/created, instead of returning an empty list. Test: tasmota_manager_spec.js.
 - tasmota_manager.js: the constructor does `this.status = 'unconfigured'`, which shadows the inherited Node-RED `Node.prototype.status()` function with a plain string on the instance - any later `this.status({...})` call would throw "this.status is not a function". Test: tasmota_manager_spec.js.

Dependencies (outdated / risky):
 - "child_process": "^1.0.2" listed as an npm dependency, but child_process is a Node core module - this pulls in an unnecessary/confusing package, should just be removed
 - "request" is deprecated since 2020 (no more updates, known vulnerable transitive deps like tough-cookie) - migrate to native fetch (Node >=18) or undici
 - "mqtt": "4.2.6" pinned to an old major version (5.x available) - review breaking changes and update
 - "fs-extra": "10.0.0" pinned old, no reason not to allow newer versions
 - no "engines" field to declare minimum supported Node.js / Node-RED version, even though the code relies on modern syntax (optional chaining, nullish-ish patterns)

Code quality / maintainability:
 - mix of callback-style done()/send() and async/await/Promises across nodes (tasmota_config.js, tasmota_manager.js) - inconsistent error propagation (some catch blocks swallow err instead of calling done(err)). Left for a behavioral-fix pass since resolving it means deciding a consistent error-handling pattern per call site, not a mechanical change.

Test suite:
Regression test suite lives under test/ (mocha + node-red-node-test-helper +
an embedded aedes MQTT broker, see test/helpers/), covering all 14 node
types. Run via `npm run test:unit`, or `npm test` which additionally gates
on `eslint .` first. Bugs above that have a red test tracking them will turn
that test green once fixed - don't "fix" a red test by changing the
assertion, fix the underlying node code and re-run.
-------------------
v2.2.0
-------------------
 - Fixed: tasmota-device and tasmota-manager nodes failed to load entirely (missing dependency)
 - Fixed: tasmota-light rejected color temperature (CT) values in the 153-500 range instead of sending them
 - Fixed: tasmota-light ignored individual values when given as an object payload (e.g. {bright: 50})
 - Fixed: tasmota-light no longer silently accepts invalid/malformed input without a warning
 - Fixed: a device could throw and stop processing incoming messages when telemetry arrived before any node had subscribed to it (e.g. an RF-only setup with no sensor node)
 - Fixed: a tasmota-device node added to an already-running flow (partial redeploy) could stay stuck showing offline and never receive any MQTT data
-------------------
v1.0.4
-------------------
 - Fixed bug RF bridge node on try sending raw codes
 - tasmota_manager: Avoid load error in case of corrupt JSON 
-------------------
v1.0.3
-------------------
 - Fixed bug in sensor subscription 
-------------------
v1.0.2
-------------------
 - Fixed critical error on using tasmota-manager (Project)
-------------------
v1.0.1
-------------------
 - Added soppurt for RF devices
-------------------
v1.0.0
-------------------
 - First public release
