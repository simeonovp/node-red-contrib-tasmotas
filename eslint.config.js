'use strict'

const neostandard = require('neostandard')

module.exports = [
  ...neostandard({
    env: ['mocha'],
    ignores: ['resources/**']
  }),
  {
    rules: {
      // project style: else/catch/finally always start on a new line
      // (Stroustrup), not on the same line as the preceding closing brace
      '@stylistic/brace-style': ['error', 'stroustrup', { allowSingleLine: true }]
    }
  }
]
