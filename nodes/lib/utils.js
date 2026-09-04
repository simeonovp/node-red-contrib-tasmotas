'use strict'

function extractChannelNum (str) {
  const numberRegexp = /\d+$/
  return Number(str.match(numberRegexp) || 1)
}

module.exports = { extractChannelNum }
