'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'estate', 'estate-v2.js'),
  'utf8'
);
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

assert.ok(source.includes('var GRID = [-18, -6, 6, 18];'), 'city must keep the 4 x 4 plot grid');
assert.ok(source.includes('function addDistrictTower'), 'city must include the surrounding skyline');
assert.ok(source.includes('function buildMarketBeacon'), 'city must retain a clickable black market entrance');
assert.ok(source.includes('function constructionSite'), 'plots must use the rebuild-site presentation');
assert.ok(!/stage-1-hut\.glb|stage-2-temple\.glb|stage-3-manor\.glb|stage-4-gatehouse\.glb|stage-5-citadel\.glb|black-market\.glb|district-(?:neo|tower)\.glb/.test(source), 'legacy estate GLB models must not be referenced');
for (const level of [1, 2, 3]) {
  const fileName = `stage-1-lv${level}.glb`;
  const filePath = path.join(__dirname, '..', 'assets', 'estate', 'models', fileName);
  assert.ok(source.includes(fileName), `${fileName} must be registered`);
  assert.ok(fs.existsSync(filePath), `${fileName} must exist`);
  assert.ok(fs.statSync(filePath).size > 500000, `${fileName} must contain a textured model`);
  const model = fs.readFileSync(filePath);
  assert.strictEqual(model.subarray(0, 4).toString('ascii'), 'glTF', `${fileName} must be a binary glTF`);
  assert.strictEqual(model.readUInt32LE(4), 2, `${fileName} must use glTF 2.0`);
  const jsonLength = model.readUInt32LE(12);
  const json = JSON.parse(model.subarray(20, 20 + jsonLength).toString('utf8').trim());
  assert.ok(Array.isArray(json.meshes) && json.meshes.length > 0, `${fileName} must contain meshes`);
  assert.ok(Array.isArray(json.materials) && json.materials.length > 0, `${fileName} must contain materials`);
}
assert.ok(source.includes("data-estate-model-level"), 'admin model level selector must exist');
assert.ok(source.includes('E.loader.load('), 'estate scene must load the approved stage-one models');
assert.ok(!source.includes('proxyBuilding'), 'legacy proxy houses must not return');
assert.ok(/loadEstateScript\(['"]assets\/vendor\/three-r147\/GLTFLoader\.js/.test(indexSource), 'estate entry must load GLTFLoader');
assert.ok(indexSource.includes('assets/estate/estate-v2.js?v=8'), 'estate cache version must be v8');

console.log('estate scene tests passed');
