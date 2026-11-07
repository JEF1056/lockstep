import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from '../extension/shared/version.js';

describe('Version - compareVersions', () => {
  test('correctly compares 1-4 integer Chrome version tuples', () => {
    // 1.0.42 > 1.0.9 requirement
    assert.equal(compareVersions('1.0.42', '1.0.9'), 1);
    assert.equal(compareVersions('1.0.9', '1.0.42'), -1);

    // Major version comparison
    assert.equal(compareVersions('2.0.0.0', '1.99.99.99'), 1);
    assert.equal(compareVersions('1.99.99.99', '2.0.0.0'), -1);

    // Minor / patch comparison
    assert.equal(compareVersions('1.1.0', '1.0.9'), 1);
    assert.equal(compareVersions('1.0.0.5', '1.0.0.4'), 1);
    assert.equal(compareVersions('1.0.0.4', '1.0.0.5'), -1);

    // Equal versions with different component lengths
    assert.equal(compareVersions('1.0.0.0', '1.0.0.0'), 0);
    assert.equal(compareVersions('1.0', '1.0.0.0'), 0);
    assert.equal(compareVersions('1', '1.0.0'), 0);
    assert.equal(compareVersions('1.0.0.0', '1.0'), 0);

    // Unequal component lengths
    assert.equal(compareVersions('1.0.0.1', '1.0'), 1);
    assert.equal(compareVersions('1.0', '1.0.0.1'), -1);
    assert.equal(compareVersions('1.1', '1.0.9'), 1);
  });

  test('returns safe 0 on missing or empty input', () => {
    assert.equal(compareVersions('', '1.0.0'), 0);
    assert.equal(compareVersions('1.0.0', ''), 0);
    assert.equal(compareVersions(null, '1.0.0'), 0);
    assert.equal(compareVersions('1.0.0', null), 0);
    assert.equal(compareVersions(undefined, '1.0.0'), 0);
    assert.equal(compareVersions('1.0.0', undefined), 0);
    assert.equal(compareVersions('', ''), 0);
    assert.equal(compareVersions('   ', '1.0.0'), 0);
  });

  test('returns safe 0 on invalid non-integer format', () => {
    assert.equal(compareVersions('abc', '1.0.0'), 0);
    assert.equal(compareVersions('1.0.0', 'xyz'), 0);
    assert.equal(compareVersions('1.0.0-beta', '1.0.0'), 0);
    assert.equal(compareVersions('1.0.0.0.1', '1.0.0'), 0); // > 4 components
    assert.equal(compareVersions('-1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions('1..0', '1.0.0'), 0);
    assert.equal(compareVersions(123, '1.0.0'), 0);
    assert.equal(compareVersions('1.0.0', {}), 0);
  });
});
