'use strict'

const { Aedes } = require('aedes')
const net = require('net')

// Starts an embedded, in-process MQTT broker (aedes) on a random free port.
// Used so node/integration tests exercise the real mqtt_broker.js + mqtt.js
// stack without needing an external broker.
async function startBroker () {
  const instance = await Aedes.createBroker()
  return new Promise((resolve, reject) => {
    const server = net.createServer(instance.handle)
    server.on('error', reject)

    // Track open sockets so close() can never hang: net.Server#close() only
    // stops accepting new connections, its callback waits for every existing
    // socket to end by itself - a client still mid-handshake when a test
    // finishes would otherwise block teardown indefinitely.
    const sockets = new Set()
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        instance,
        close () {
          return new Promise((resolve) => {
            server.close(() => instance.close(resolve))
            for (const socket of sockets) socket.destroy()
          })
        }
      })
    })
  })
}

module.exports = { startBroker }
