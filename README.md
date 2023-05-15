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
![shutter flow](./img/shutter_flow.jpg) 
  <details>
    <summary>
    Shutter node example flow
    </summary>
  [
      {
          "id": "6a5b4f7667dd5e93",
          "type": "tab",
          "label": "Shutter",
          "disabled": false,
          "info": "",
          "env": []
      },
      {
          "id": "4a234e775ccbd052",
          "type": "tasmota-shutter",
          "z": "6a5b4f7667dd5e93",
          "device": "1a88b745512d3c2f",
          "name": "relais_01_2",
          "outputs": 1,
          "sendDevice": true,
          "uidisabler": false,
          "idx": "1",
          "swapSwitches": false,
          "x": 530,
          "y": 120,
          "wires": [
              [
                  "173b7fc0310f7798"
              ]
          ]
      },
      {
          "id": "54ad039d5c179adb",
          "type": "ui_button",
          "z": "6a5b4f7667dd5e93",
          "name": "btnOpen",
          "group": "371d8c5139241499",
          "order": 4,
          "width": "2",
          "height": "1",
          "passthru": true,
          "label": "Open",
          "tooltip": "",
          "color": "",
          "bgcolor": "",
          "className": "",
          "icon": "",
          "payload": "Open",
          "payloadType": "str",
          "topic": "topic",
          "topicType": "msg",
          "x": 300,
          "y": 80,
          "wires": [
              [
                  "4a234e775ccbd052"
              ]
          ]
      },
      {
          "id": "fe89380a84ee2180",
          "type": "ui_button",
          "z": "6a5b4f7667dd5e93",
          "name": "btnStop",
          "group": "371d8c5139241499",
          "order": 5,
          "width": "2",
          "height": "1",
          "passthru": true,
          "label": "Stop",
          "tooltip": "",
          "color": "",
          "bgcolor": "",
          "className": "",
          "icon": "",
          "payload": "Stop",
          "payloadType": "str",
          "topic": "topic",
          "topicType": "msg",
          "x": 300,
          "y": 120,
          "wires": [
              [
                  "4a234e775ccbd052"
              ]
          ]
      },
      {
          "id": "bf703ba05b46bd54",
          "type": "ui_button",
          "z": "6a5b4f7667dd5e93",
          "name": "btnClose",
          "group": "371d8c5139241499",
          "order": 6,
          "width": "2",
          "height": "1",
          "passthru": true,
          "label": "Close",
          "tooltip": "",
          "color": "",
          "bgcolor": "",
          "className": "",
          "icon": "",
          "payload": "Close",
          "payloadType": "str",
          "topic": "topic",
          "topicType": "msg",
          "x": 300,
          "y": 160,
          "wires": [
              [
                  "4a234e775ccbd052"
              ]
          ]
      },
      {
          "id": "28bd8cdef12145c0",
          "type": "inject",
          "z": "6a5b4f7667dd5e93",
          "name": "Open",
          "props": [
              {
                  "p": "payload"
              },
              {
                  "p": "topic",
                  "vt": "str"
              }
          ],
          "repeat": "",
          "crontab": "",
          "once": false,
          "onceDelay": 0.1,
          "topic": "",
          "payload": "true",
          "payloadType": "bool",
          "x": 110,
          "y": 80,
          "wires": [
              [
                  "54ad039d5c179adb"
              ]
          ]
      },
      {
          "id": "4e6548fa30e15d75",
          "type": "inject",
          "z": "6a5b4f7667dd5e93",
          "name": "Stop",
          "props": [
              {
                  "p": "payload"
              },
              {
                  "p": "topic",
                  "vt": "str"
              }
          ],
          "repeat": "",
          "crontab": "",
          "once": false,
          "onceDelay": 0.1,
          "topic": "",
          "payload": "true",
          "payloadType": "bool",
          "x": 110,
          "y": 120,
          "wires": [
              [
                  "fe89380a84ee2180"
              ]
          ]
      },
      {
          "id": "2a84975211385b32",
          "type": "inject",
          "z": "6a5b4f7667dd5e93",
          "name": "Close",
          "props": [
              {
                  "p": "payload"
              },
              {
                  "p": "topic",
                  "vt": "str"
              }
          ],
          "repeat": "",
          "crontab": "",
          "once": false,
          "onceDelay": 0.1,
          "topic": "",
          "payload": "true",
          "payloadType": "bool",
          "x": 110,
          "y": 160,
          "wires": [
              [
                  "bf703ba05b46bd54"
              ]
          ]
      },
      {
          "id": "173b7fc0310f7798",
          "type": "ui_slider",
          "z": "6a5b4f7667dd5e93",
          "name": "sldPosition",
          "label": "Position (%)",
          "tooltip": "",
          "group": "371d8c5139241499",
          "order": 3,
          "width": 0,
          "height": 0,
          "passthru": false,
          "outs": "end",
          "topic": "position",
          "topicType": "str",
          "min": 0,
          "max": "100",
          "step": 1,
          "className": "",
          "x": 510,
          "y": 40,
          "wires": [
              [
                  "4a234e775ccbd052"
              ]
          ]
      },
      {
          "id": "1a88b745512d3c2f",
          "type": "tasmota-device",
          "manager": "f940f2077062977f",
          "broker": "5aa6ea16b4019c7c",
          "device": "relais_01",
          "name": "",
          "ip": "",
          "host": "ch4-01",
          "mac": "",
          "version": "0x8020003",
          "module": "6",
          "relais": "0",
          "friendlynames": "Office Fenster/Tuer,Tasmota2,Tasmota3,Tasmota4,Tasmota5,Tasmota6,Tasmota7,Tasmota8",
          "fullTopic": "tasmota/%topic%/%prefix%",
          "cmndPrefix": "cmnd",
          "statPrefix": "stat",
          "telePrefix": "tele",
          "qos": "1"
      },
      {
          "id": "371d8c5139241499",
          "type": "ui_group",
          "name": "Shutter",
          "tab": "192fba4f7dfe1303",
          "order": 3,
          "disp": true,
          "width": "6",
          "collapse": false,
          "className": ""
      },
      {
          "id": "f940f2077062977f",
          "type": "tasmota-manager",
          "dbUri": "http://192.168.192.200/SmartHome/data/",
          "name": "hausen",
          "network": "192.168.13.0/24"
      },
      {
          "id": "5aa6ea16b4019c7c",
          "type": "tasmota-mqtt-broker",
          "name": "sihabro5",
          "broker": "192.168.192.225",
          "port": "1883",
          "clientid": "nodered-pc",
          "usetls": false,
          "keepalive": "60",
          "cleansession": true
      },
      {
          "id": "192fba4f7dfe1303",
          "type": "ui_tab",
          "name": "Home",
          "icon": "dashboard",
          "disabled": false,
          "hidden": false
      }
  ]
  </details>
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
![control flow](./img/control_flow.jpg) 
  <details>
    <summary>
    Config node example flow
    </summary>
  [
      {
          "id": "77d5c6af1fe840b4",
          "type": "tab",
          "label": "Demos",
          "disabled": false,
          "info": "",
          "env": []
      },
      {
          "id": "174c17b3de7ab86d",
          "type": "tasmota-config",
          "z": "77d5c6af1fe840b4",
          "manager": "f940f2077062977f",
          "name": "",
          "x": 480,
          "y": 40,
          "wires": [
              [
                  "e2d9f1385c172bb7"
              ]
          ]
      },
      {
          "id": "e2d9f1385c172bb7",
          "type": "ui_button",
          "z": "77d5c6af1fe840b4",
          "name": "btnListDevices",
          "group": "2f46a384e76104ab",
          "order": 2,
          "width": "3",
          "height": "1",
          "passthru": true,
          "label": "List Devices",
          "tooltip": "",
          "color": "",
          "bgcolor": "",
          "className": "",
          "icon": "",
          "payload": "",
          "payloadType": "str",
          "topic": "listDevices",
          "topicType": "str",
          "x": 280,
          "y": 120,
          "wires": [
              [
                  "6cce4cdb225f4a84"
              ]
          ]
      },
      {
          "id": "dc56ad3bc5b7d983",
          "type": "inject",
          "z": "77d5c6af1fe840b4",
          "name": "",
          "props": [
              {
                  "p": "payload"
              },
              {
                  "p": "topic",
                  "vt": "str"
              }
          ],
          "repeat": "",
          "crontab": "",
          "once": false,
          "onceDelay": 0.1,
          "topic": "",
          "payload": "",
          "payloadType": "date",
          "x": 100,
          "y": 120,
          "wires": [
              [
                  "e2d9f1385c172bb7"
              ]
          ]
      },
      {
          "id": "316a1f7181cb2b78",
          "type": "ui_button",
          "z": "77d5c6af1fe840b4",
          "name": "btnScanNetwork",
          "group": "2f46a384e76104ab",
          "order": 1,
          "width": "3",
          "height": "1",
          "passthru": true,
          "label": "Scan Network",
          "tooltip": "",
          "color": "",
          "bgcolor": "",
          "className": "",
          "icon": "",
          "payload": "",
          "payloadType": "str",
          "topic": "scanNetwork",
          "topicType": "str",
          "x": 280,
          "y": 40,
          "wires": [
              [
                  "174c17b3de7ab86d"
              ]
          ]
      },
      {
          "id": "c7f3b9d36c15552c",
          "type": "inject",
          "z": "77d5c6af1fe840b4",
          "name": "",
          "props": [
              {
                  "p": "payload"
              },
              {
                  "p": "topic",
                  "vt": "str"
              }
          ],
          "repeat": "",
          "crontab": "",
          "once": false,
          "onceDelay": 0.1,
          "topic": "",
          "payload": "",
          "payloadType": "date",
          "x": 100,
          "y": 40,
          "wires": [
              [
                  "316a1f7181cb2b78"
              ]
          ]
      },
      {
          "id": "6cce4cdb225f4a84",
          "type": "tasmota-config",
          "z": "77d5c6af1fe840b4",
          "manager": "f940f2077062977f",
          "name": "",
          "x": 480,
          "y": 120,
          "wires": [
              [
                  "8f0f28a299bc0c1a"
              ]
          ]
      },
      {
          "id": "9c86b2f7206d318c",
          "type": "ui_dropdown",
          "z": "77d5c6af1fe840b4",
          "name": "listDevices",
          "label": "Devices",
          "tooltip": "",
          "place": "Select option",
          "group": "2f46a384e76104ab",
          "order": 3,
          "width": 0,
          "height": 0,
          "passthru": true,
          "multiple": false,
          "options": [
              {
                  "label": "",
                  "value": "",
                  "type": "str"
              }
          ],
          "payload": "",
          "topic": "topic",
          "topicType": "msg",
          "className": "",
          "x": 270,
          "y": 180,
          "wires": [
              [
                  "1a648cda449ab9e2"
              ]
          ]
      },
      {
          "id": "8f0f28a299bc0c1a",
          "type": "change",
          "z": "77d5c6af1fe840b4",
          "name": "selectDevice",
          "rules": [
              {
                  "t": "set",
                  "p": "options",
                  "pt": "msg",
                  "to": "payload",
                  "tot": "msg"
              },
              {
                  "t": "set",
                  "p": "payload",
                  "pt": "msg",
                  "to": "selectedDevice",
                  "tot": "flow"
              }
          ],
          "action": "",
          "property": "",
          "from": "",
          "to": "",
          "reg": false,
          "x": 650,
          "y": 120,
          "wires": [
              [
                  "9c86b2f7206d318c"
              ]
          ]
      },
      {
          "id": "1a648cda449ab9e2",
          "type": "change",
          "z": "77d5c6af1fe840b4",
          "name": "saveSelectedDevice",
          "rules": [
              {
                  "t": "set",
                  "p": "selectedDevice",
                  "pt": "flow",
                  "to": "payload",
                  "tot": "msg"
              }
          ],
          "action": "",
          "property": "",
          "from": "",
          "to": "",
          "reg": false,
          "x": 520,
          "y": 180,
          "wires": [
              []
          ]
      },
      {
          "id": "72723dcceee41964",
          "type": "ui_button",
          "z": "77d5c6af1fe840b4",
          "name": "btnHttpStatus",
          "group": "2f46a384e76104ab",
          "order": 4,
          "width": "3",
          "height": "1",
          "passthru": true,
          "label": "GetStatus",
          "tooltip": "",
          "color": "",
          "bgcolor": "",
          "className": "",
          "icon": "",
          "payload": "",
          "payloadType": "str",
          "topic": "Status",
          "topicType": "str",
          "x": 280,
          "y": 260,
          "wires": [
              [
                  "f2ae1cfd81260ed5"
              ]
          ]
      },
      {
          "id": "36673f844c6a0dde",
          "type": "inject",
          "z": "77d5c6af1fe840b4",
          "name": "",
          "props": [
              {
                  "p": "payload"
              },
              {
                  "p": "topic",
                  "vt": "str"
              }
          ],
          "repeat": "",
          "crontab": "",
          "once": false,
          "onceDelay": 0.1,
          "topic": "",
          "payload": "",
          "payloadType": "date",
          "x": 100,
          "y": 260,
          "wires": [
              [
                  "72723dcceee41964"
              ]
          ]
      },
      {
          "id": "f2ae1cfd81260ed5",
          "type": "change",
          "z": "77d5c6af1fe840b4",
          "name": "selectDevice",
          "rules": [
              {
                  "t": "set",
                  "p": "action",
                  "pt": "msg",
                  "to": "httpCommand",
                  "tot": "str"
              },
              {
                  "t": "set",
                  "p": "ip",
                  "pt": "msg",
                  "to": "selectedDevice",
                  "tot": "flow"
              }
          ],
          "action": "",
          "property": "",
          "from": "",
          "to": "",
          "reg": false,
          "x": 490,
          "y": 260,
          "wires": [
              [
                  "30cb09640e5e9604"
              ]
          ]
      },
      {
          "id": "30cb09640e5e9604",
          "type": "tasmota-config",
          "z": "77d5c6af1fe840b4",
          "manager": "f940f2077062977f",
          "name": "",
          "x": 680,
          "y": 260,
          "wires": [
              [
                  "9233e13b42e92bdb"
              ]
          ]
      },
      {
          "id": "9233e13b42e92bdb",
          "type": "ui_text",
          "z": "77d5c6af1fe840b4",
          "group": "2f46a384e76104ab",
          "order": 5,
          "width": 0,
          "height": 0,
          "name": "txtFriendlyName",
          "label": "FriendlyName",
          "format": "{{msg.payload.Status.FriendlyName[0]}}",
          "layout": "row-spread",
          "className": "",
          "x": 280,
          "y": 320,
          "wires": []
      },
      {
          "id": "f940f2077062977f",
          "type": "tasmota-manager",
          "dbUri": "",
          "name": "house",
          "network": "192.168.13.0/24"
      },
      {
          "id": "2f46a384e76104ab",
          "type": "ui_group",
          "name": "Control",
          "tab": "192fba4f7dfe1303",
          "order": 1,
          "disp": true,
          "width": "6",
          "collapse": false,
          "className": ""
      },
      {
          "id": "192fba4f7dfe1303",
          "type": "ui_tab",
          "name": "Home",
          "icon": "dashboard",
          "disabled": false,
          "hidden": false
      }
  ]
  </details>

## TODO: 
- detailed nodes description
- provide usage examples

## Disclaimer
The software is provided as-is under the MIT license. The author cannot be held responsible for any unintended behaviours.

## Thanks
If you like our ideas and want to support further development, you can donate here:  
[![Donate](https://img.shields.io/badge/donate-PayPal-blue.svg)](https://paypal.me/tasmotas)
[![Donate](https://img.shields.io/badge/donate-buy%20me%20a%20coffee-yellow.svg)](https://www.buymeacoffee.com/smarthomenodes)
