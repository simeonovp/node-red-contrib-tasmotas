
### Code style
This project uses ESLint with the `neostandard` ruleset (see `eslint.config.js`), with one override: `else`/`catch`/`finally` always start on a new line (Stroustrup brace style) instead of the neostandard default. Run `npm run lint` (or `npx eslint . --fix` for the auto-fixable parts).

### Tests
Regression tests live under `test/` (mocha + node-red-node-test-helper + an embedded aedes MQTT broker). Run `npm run test:unit`.


### Release procedure
 * run "npm test" and fix all the issues
 * Update the version in package.json
 * Add a new entry in CHANGELOG.md
 * git-commit -m 'Prepare release X.X.X'
 * git tag -a vX.X.X
 * git-push --follow-tags
 * npm publish
 * request a refresh on flows.nodered.org


###  NPM CheatSheet
 * npm test      to run all the tests
 * npm pack      to crete the package locally (use file list in package.json)
 * npm publish   to publish on npm (use .npmignore file)

