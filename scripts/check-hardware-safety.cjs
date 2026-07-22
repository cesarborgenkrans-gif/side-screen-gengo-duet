const assert = require('assert/strict');
const { assessModelFit, GIB } = require('../hardware-safety');

const model = (sizeGiB, loaded = false) => ({
  key: 'test/model',
  size_bytes: sizeGiB * GIB,
  loaded_instances: loaded ? [{ id: 'test/model' }] : []
});
const hardware = (freeVramGiB, freeRamGiB) => ({
  ok: true,
  gpu: { freeGiB: freeVramGiB },
  ram: { freeGiB: freeRamGiB }
});

assert.equal(assessModelFit(model(3), hardware(12, 16)).code, 'safe');
assert.equal(assessModelFit(model(10), hardware(7.4, 10.2)).code, 'insufficient_memory');
assert.equal(assessModelFit(model(10), { ok: false, gpu: null, ram: { freeGiB: 20 } }).code, 'hardware_unknown');
assert.equal(assessModelFit(model(30), hardware(4, 4)).allowed, false);
assert.equal(assessModelFit(model(30, true), hardware(0, 0)).code, 'already_loaded');
assert.equal(assessModelFit(null, hardware(24, 32)).code, 'model_missing');

console.log('hardware safety OK - safe, blocked, unknown, and already-loaded paths verified.');
