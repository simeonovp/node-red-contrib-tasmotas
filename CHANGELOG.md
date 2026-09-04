TODOs:
-------------------
Code review findings (2026-09-04)
-------------------
Bugs:
 - tasmota_light.js: onNodeInput uses undefined variable `ct` instead of `data.ct` when CT is given in mired range (153-500) -> ReferenceError, command never sent
 - tasmota_light.js: onNodeInput MODE 3 (object payload) calls processCmd(key) but never assigns `msg.payload = value` first, so every key ends up using the whole payload object instead of its own value
 - tasmota_light.js: `if (!Object.keys.length)` checks the Object.keys function itself (always truthy), the intended `Object.keys(data).length` check never triggers
 - tasmota_device.js: Shutter constructor assigns `this.switch1` twice (copy/paste bug), the first switch reference is overwritten and switch2 is never set
 - tasmota_device.js: _onMqttMessage() calls this.mqttSubscribeTete(this) (typo of mqttSubscribeTele), method does not exist -> TypeError if that code path is hit
 - tasmota_rf_device.js: `this.lastBridge = bridgeTopic || manager.defaultBridge || ''` throws when the configured manager id no longer resolves to a node (e.g. a stale/deleted reference after a partial redeploy) - `manager` is `undefined` in that case, not the empty string you'd get when unconfigured, and this line (unlike the other `manager?.` call sites in the same file) doesn't use optional chaining. Confirmed by a regression test.
 - tasmota_rf_manager.js: getTimings()/saveTimings() call .find(...) on this.rf433Data[group] without checking the result, throws if device/group not found yet
 - tasmota_rf_manager.js + tasmota_rf_device.js: addListener(code, fn.bind(this)) / removeListener(code, fn.bind(this)) use a new bound function each time, so removeListener never actually removes the original listener -> listener leak on node close/redeploy
 - [FIXED 2026-09-04] tasmota_manager.js / tasmota_device.js: required `socket.io`, which is not listed in package.json and was not resolvable at all (confirmed, not just a risk) -> `Cannot find module 'socket.io'` on every attempt to load the tasmota-device or tasmota-manager node, in this session's dev install and presumably for any real user too. `io`/`socketio` was never actually used anywhere in either file, so the dead `require('socket.io')` line was removed from both (no behavior change) so the test suite below could even load these modules.
 - tasmota_manager.js: _spawnDecodeConfig() spawns 'python' with no 'error' handler and no check whether python/python3 is installed -> unhandled error event / unclear failure for users
 - [FIXED 2026-09-04] mqtt_broker.js: leftover debug comment "// sip-- ???" and dead commented-out code in register() - both removed (no behavior change)

Dependencies (outdated / risky):
 - "child_process": "^1.0.2" listed as an npm dependency, but child_process is a Node core module - this pulls in an unnecessary/confusing package, should just be removed
 - "request" is deprecated since 2020 (no more updates, known vulnerable transitive deps like tough-cookie) - migrate to native fetch (Node >=18) or undici
 - "mqtt": "4.2.6" pinned to an old major version (5.x available) - review breaking changes and update
 - "fs-extra": "10.0.0" pinned old, no reason not to allow newer versions
 - [RESOLVED 2026-09-04] socket.io was required but missing from package.json entirely - resolved by removing the dead require (see bug above), not by adding the dependency
 - no "engines" field to declare minimum supported Node.js / Node-RED version, even though the code relies on modern syntax (optional chaining, nullish-ish patterns)

Code quality / maintainability:
 - [FIXED 2026-09-04] consistent typo "swiches" instead of "switches" throughout tasmota_device.js/tasmota_switch.js/tasmota_pulsetime.js (this.swiches, device.swiches) - renamed to `switches` everywhere (nodes + tests)
 - [FIXED 2026-09-04] "timimgs" typo (should be "timings") used consistently in tasmota_rf_manager.js - renamed
 - [FIXED 2026-09-04] duplicate extractChannelNum() implementation in tasmota_base.js (class method) and tasmota_device.js (module function - not tasmota_manager.js as originally noted here, corrected) - both now delegate to a single implementation in the new nodes/lib/utils.js
 - [FIXED 2026-09-04] tasmota_device.js: removed unused imports/vars `emit`, `path`, `fs`, `request`, `spawn`, `socketio`, `events`, `toggleValue`; tasmota_manager.js: removed unused `emit`; tasmota_rf_manager.js: removed unused `path`, `fs`; tasmota_shutter.js: removed unused `D_CMND_SHUTTER_UP/DOWN`, `ShutterPrefix`, `ShutterCommands`
 - [FIXED 2026-09-04] tasmota_config.js: unused `TasmotaBase` require removed
 - [FIXED 2026-09-04] httpCommand() now builds its URL via `encodeURIComponent()` instead of raw string concatenation
 - [FIXED 2026-09-04, then reverted 2026-09-04] first ran `standard --fix` (no-mixed-operators parens, camelCase locals for the snake_case `ip_address`/`mqtt_topic` fields read from decode-config.py's JSON output, a couple of dead no-op property statements, a rewrite of the comma-operator object-building idiom in tasmota_manager.js's list*() methods into plain object literals, and 1tbs brace style). The 1tbs part (`} else {` / `} catch {` on one line) turned out to violate the project's actual style - the user's `else`/`catch`/`finally` always start on a new line - so all 83 of those were reverted back via a scripted codemod. Everything else from that pass stayed. See feedback memory `brace-style-else-catch-finally-newline`.
 - [FIXED 2026-09-04] `standard` cannot be configured to accept else/catch/finally-on-new-line (it's zero-config by design), so it was replaced entirely: `standard` uninstalled, devDependencies now `eslint` + `neostandard` (the flat-config ESLint-9+ successor to `eslint-config-standard`), config in the new `eslint.config.js` with `'@stylistic/brace-style': ['error', 'stroustrup', { allowSingleLine: true }]` overriding neostandard's default 1tbs. `"lint"`/`"test"` scripts now call `eslint .`. Also fixed 2 leftover 1tbs spots in test/ (test/helpers/wait.js, test/nodes/tasmota_rf_device_spec.js) that predated this switch. `npx eslint .` now passes cleanly except for the two lines that are the still-open tasmota_light.js bugs below - expected, not a config problem.
 - still open: mix of callback-style done()/send() and async/await/Promises across nodes (tasmota_config.js, tasmota_manager.js) - inconsistent error propagation (some catch blocks swallow err instead of calling done(err)). Left for the behavioral-fix pass since resolving it means deciding a consistent error-handling pattern per call site, not a mechanical change.
-------------------
Test infrastructure + new bugs found while building it (2026-09-04)
-------------------
Added a regression test suite under test/ (mocha + node-red-node-test-helper
+ an embedded aedes MQTT broker, see test/helpers/) covering all 14 node
types, run via `npm run test:unit` (or `npm test`, which additionally gates
on `eslint` - see the eslint/neostandard switch above). `nodes/` and `test/`
are lint-clean except for exactly the two lines that *are* the known
tasmota_light.js `ct`/object-payload bugs - so `npm test` currently stops at
the `eslint` step (its `&&` never reaches mocha) precisely because those
two bugs are still open; `npm run test:unit` always runs the test suite
regardless. Once those two bugs are fixed for real, `npm test` will pass
lint and run the full suite in one go.
8 of the ~48 tests currently FAIL ON PURPOSE: they encode the known bugs
above plus the ones found below, so each bug fix can be verified by watching
its test turn green - do not "fix" a red test by changing the assertion,
fix the underlying node code and re-run.

New bugs found while writing the tests (not covered above):
 - tasmota_shutter.js: onSend() branches on `this.shutter.position` to show a
   green "Open"/"Closed" status at the 0%/100% end stops, but the Shutter
   class (tasmota_device.js) only ever sets `this.data.Position` - `.position`
   is always undefined, so the green status is never shown, only the grey
   "N%" fallback, even fully open/closed. Test: tasmota_shutter_spec.js.
 - tasmota_manager.js: getDbDevices() does `this.dbDevices['devices'].filter(...)`
   unconditionally, but DbBase#load() leaves `data = {}` (no `.devices` key)
   when the backing JSON file doesn't exist yet - throws a TypeError on a
   brand-new install before devices.json has ever been downloaded/created,
   instead of returning an empty list. Test: tasmota_manager_spec.js.
 - tasmota_manager.js: the constructor does `this.status = 'unconfigured'`,
   which shadows the inherited Node-RED `Node.prototype.status()` function
   with a plain string on the instance - any later `this.status({...})` call
   would throw "this.status is not a function". Test: tasmota_manager_spec.js.
 - mqtt_broker.js / tasmota_device.js: a device only ever receives
   onBrokerOnline() (and therefore only ever performs its actual MQTT
   subscribe) for users that were already registered in `this.users` at the
   moment the broker's underlying MQTT client 'connect' event fires - see
   mqtt_broker.js `client.on('connect', ...)` iterating `this.users`, and
   register() not proactively notifying a device that joins after the broker
   is already connected. In a normal full deploy this is masked because all
   node constructors run synchronously before the async MQTT handshake
   completes, but a device/leaf node added via a partial redeploy while the
   broker connection is already alive would never subscribe to anything and
   would appear permanently offline. Not yet covered by a red test (the full
   test suite always exercises the "normal full deploy" timing); worth a
   targeted fix + test together.
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
