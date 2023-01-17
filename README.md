# node-red-contrib-tasmotas

Support for Tasmota devices in SmartHome projects using [Node-RED](https://nodered.org/).

The goal of the project is to allow using and configure devices flashed with Tasmota firmware in Node-Red

## Getting Started

Prerequisites: [Node-RED](https://nodered.org) installation. For details see [here](https://nodered.org/docs/getting-started/installation).

Install via npm

```shell
$ cd ~/.node-red
$ npm install node-red-contrib-tasmotas
```
then restart node-red

The Tasmota devices are represented by config Nodes (single Node per device). The flow Nodes references a device node and can exists multiple times in different flows. It can be defined a project object to group and control all Tasmota devices in the local network. The management functions can be accessed over an "Config" nodes. The devices can be accessed over MQTT or HTTP. The IP addresses of the devices will be detect automaticaly. The device configurations will be downloded and cached localy.

## Available Nodes
- [Switch](#tasmota_switch)
Represents a Tasmota Power channel
- [Shutter](#tasmota_shutter)
Represents a Tasmota Shutter device
- [Sensor](#tasmota_sensor)
Represents a Tasmota generic sensor access
- [Button](#tasmota_button)
Represents a Tasmota Button device
- [Light](#tasmota_light)
Represents a Tasmota Light device
- [Generic](#tasmota_generic)
Represents a generic Tasmota device
- [Config](#tasmota_config)
Can be used to access and control one or more devices

## TODO: 
- detailed nodes description
- provide usage examples

## Thanks
If you like our ideas and want to support further development, you can donate here:  
[![Donate](https://img.shields.io/badge/donate-PayPal-blue.svg)](https://paypal.me/tasmotas)
[![Donate](https://img.shields.io/badge/donate-buy%20me%20a%20coffee-yellow.svg)](https://www.buymeacoffee.com/smarthomenodes)
