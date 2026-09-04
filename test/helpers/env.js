'use strict'

const helper = require('node-red-node-test-helper')
const { startBroker } = require('./broker')

helper.init(require.resolve('node-red'))

// Starts a fresh embedded MQTT broker + Node-RED test runtime for one test.
async function setup () {
  const broker = await startBroker()
  await helper.startServer()
  return broker
}

async function teardown (broker) {
  await helper.unload()
  await helper.stopServer()
  if (broker) await broker.close()
}

module.exports = { helper, setup, teardown }
