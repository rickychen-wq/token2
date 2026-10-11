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
assert.ok(!/stage-[1-5]-|black-market\.glb|district-(?:neo|tower)\.glb/.test(source), 'legacy estate GLB models must not be referenced');
assert.ok(!source.includes('E.loader.load('), 'estate scene must not load legacy house models');
assert.ok(!source.includes('proxyBuilding'), 'legacy proxy houses must not return');
assert.ok(!/loadEstateScript\(['"]assets\/vendor\/three-r147\/GLTFLoader\.js/.test(indexSource), 'estate entry must not download the unused GLB loader');

console.log('estate scene tests passed');
