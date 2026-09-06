# TODOs:

# v2.2.1
 - Added: new "Devices" tab in the tasmota-manager editor, listing every currently registered device with its name, online/offline status, WiFi access point and IP address

# v2.2.0
 - Fixed: tasmota-device and tasmota-manager nodes failed to load entirely (missing dependency)
 - Fixed: tasmota-light rejected color temperature (CT) values in the 153-500 range instead of sending them
 - Fixed: tasmota-light ignored individual values when given as an object payload (e.g. {bright: 50})
 - Fixed: tasmota-light no longer silently accepts invalid/malformed input without a warning
 - Fixed: a device could throw and stop processing incoming messages when telemetry arrived before any node had subscribed to it (e.g. an RF-only setup with no sensor node)
 - Fixed: a tasmota-device node added to an already-running flow (partial redeploy) could stay stuck showing offline and never receive any MQTT data
 - Fixed: repeated redeploys of a flow with tasmota-rf-manager/tasmota-rf-device could leak listeners, eventually causing received RF codes to be processed multiple times
 - Fixed: tasmota-rf-manager could crash when looking up timing data for a bridge/device combination it hadn't seen yet
 - Fixed: tasmota-rf-device could crash on startup if its configured RF manager reference was stale or missing
 - Fixed: tasmota-manager could crash listing devices before the device database had been downloaded for the first time
 - Fixed: tasmota-manager could crash the whole runtime if python was not installed/on PATH when downloading a device config
 - Fixed: tasmota-shutter never showed the green Open/Closed status at the fully open/closed positions, always showing the grey percentage instead
 - Removed the deprecated `request` HTTP library (unmaintained since 2020, known vulnerable transitive dependencies) in favor of Node's built-in fetch
 - Updated the MQTT client library (mqtt) to the current major version (v5)

# v1.0.4
 - Fixed bug RF bridge node on try sending raw codes
 - tasmota_manager: Avoid load error in case of corrupt JSON 

# v1.0.3
 - Fixed bug in sensor subscription 

# v1.0.2
 - Fixed critical error on using tasmota-manager (Project)

# v1.0.1
 - Added soppurt for RF devices

# v1.0.0
 - First public release
