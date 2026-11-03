const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync('youtube/receiver-name.js', 'utf8');

const page = { location: { hostname: 'www.youtube.com', pathname: '/tv' } };
page.window = page;
vm.createContext(page);
vm.runInContext(source, page);
vm.runInContext(`
  // YouTube may populate feature_switches AFTER assigning environment.
  window.environment = { other: 42 };
  window.environment.feature_switches = { mdx_device_label: 'YouTube on TV', keep: true };
`, page);
assert.equal(page.environment.feature_switches.mdx_device_label, 'RaspPi');
assert.equal(page.environment.feature_switches.keep, true);
assert.equal(page.environment.other, 42);
vm.runInContext('window.environment = { feature_switches: {} }', page);
assert.equal(page.environment.feature_switches.mdx_device_label, 'RaspPi');

const unrelated = { location: { hostname: 'www.youtube.com', pathname: '/watch' } };
unrelated.window = unrelated;
vm.runInNewContext(source, unrelated);
assert.equal(Object.hasOwn(unrelated, 'environment'), false);
console.log('Receiver-name startup and page-scope checks passed');
