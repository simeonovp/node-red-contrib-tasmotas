'use strict'

// Polls `predicate` until it returns truthy, or rejects after `timeout` ms.
// Used instead of hooking into internal events (mqtt.js connect, aedes
// suback, ...) that the nodes under test don't expose publicly.
function waitUntil (predicate, { timeout = 3000, interval = 20 } = {}) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    (function check () {
      let ok
      try {
        ok = predicate()
      }
      catch (err) {
        ok = false
      }
      if (ok) return resolve()
      if (Date.now() - start > timeout) {
        return reject(new Error('waitUntil: timed out waiting for condition'))
      }
      setTimeout(check, interval)
    })()
  })
}

module.exports = { waitUntil }
