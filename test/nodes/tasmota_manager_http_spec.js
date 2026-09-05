'use strict'

const assert = require('assert')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { helper } = require('../helpers/env')
const { managerConfig } = require('../helpers/flow')
const { waitUntil } = require('../helpers/wait')
const managerNodeModule = require('../../nodes/tasmota_manager.js')

// tasmota_manager.js used to talk HTTP via the `request` package; it was
// migrated to native fetch(). None of the other tasmota-manager tests touch
// the network (they leave dbUri unset on purpose), so this file specifically
// exercises download()/getRequest()/httpCommand() against a local HTTP
// server to verify that migration.

const resourcesRoot = path.resolve(path.join(__dirname, '../../resources'))

function startServer (handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function stopServer (server) {
  return new Promise((resolve) => server.close(resolve))
}

describe('tasmota-manager node (HTTP via fetch)', function () {
  let server
  const usedNames = []

  afterEach(async function () {
    await helper.unload()
    if (server) {
      await stopServer(server)
      server = undefined
    }
    for (const name of usedNames.splice(0)) {
      fs.rmSync(path.join(resourcesRoot, name), { recursive: true, force: true })
    }
  })

  function uniqueName (label) {
    const name = `__test_http_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    usedNames.push(name)
    return name
  }

  // Skips the real GitHub download _downloadDecodeConfig() fires (unawaited)
  // whenever dbUri is set, by pre-creating the file it checks for.
  function stubDecodeConfigFile (name) {
    const confdir = path.join(resourcesRoot, name, 'configs')
    fs.mkdirSync(confdir, { recursive: true })
    fs.writeFileSync(path.join(confdir, 'decode-config.py'), '# stub for tests\n')
  }

  it('downloads and stores devices.json via the configured dbUri', async function () {
    const devicesPayload = { devices: [{ fw: 1, ip: '10.0.0.9', host: 'plugX', name: 'Plug X' }], groups: [] }
    server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(req.url === '/devices.json' ? JSON.stringify(devicesPayload) : '{}')
    })
    const port = server.address().port
    const name = uniqueName('download')
    stubDecodeConfigFile(name)

    const flow = [managerConfig('n1', { name, dbUri: `http://127.0.0.1:${port}/` })]
    await helper.load(managerNodeModule, flow)
    const n1 = helper.getNode('n1')

    await waitUntil(() => n1.dbDevices.devices.length > 0)
    assert.strictEqual(n1.dbDevices.devices[0].host, 'plugX')
  })

  it('httpCommand() parses a JSON response from a device', async function () {
    server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ Topic: 'plugY' }))
    })
    const port = server.address().port
    const name = uniqueName('httpcmd')
    const flow = [managerConfig('n1', { name })]
    await helper.load(managerNodeModule, flow)
    const n1 = helper.getNode('n1')

    const result = await n1.httpCommand(`127.0.0.1:${port}`, 'Topic', '')
    assert.deepStrictEqual(result, { Topic: 'plugY' })
  })

  it('getRequest() rejects on a non-2xx response', async function () {
    server = await startServer((req, res) => {
      res.writeHead(500)
      res.end('boom')
    })
    const port = server.address().port
    const name = uniqueName('httperr')
    const flow = [managerConfig('n1', { name })]
    await helper.load(managerNodeModule, flow)
    const n1 = helper.getNode('n1')

    await assert.rejects(() => n1.getRequest(`http://127.0.0.1:${port}/`, true))
  })

  it('getRequest() aborts and rejects when the server exceeds the given timeout', async function () {
    server = await startServer(() => {
      // never respond
    })
    const port = server.address().port
    const name = uniqueName('httptimeout')
    const flow = [managerConfig('n1', { name })]
    await helper.load(managerNodeModule, flow)
    const n1 = helper.getNode('n1')

    await assert.rejects(() => n1.getRequest(`http://127.0.0.1:${port}/`, true, 200))
  })
})
