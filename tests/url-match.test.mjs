import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  INVITE_BASE_URL,
  canonicalizeVideoUrl,
  findMatchingTab,
  buildInviteUrl,
  parseInviteUrl,
  generatePairKey
} from '../extension/shared/url-match.js';

describe('URL Match - Constants & Pair Key Generation', () => {
  test('INVITE_BASE_URL matches specification', () => {
    assert.equal(INVITE_BASE_URL, 'https://jef1056.github.io/lockstep/');
  });

  test('generatePairKey generates non-empty unique strings', () => {
    const key1 = generatePairKey();
    const key2 = generatePairKey();
    assert.equal(typeof key1, 'string');
    assert.ok(key1.length >= 8);
    assert.notEqual(key1, key2);
  });
});

describe('URL Match - canonicalizeVideoUrl', () => {
  test('preserves origin and pathname', () => {
    const raw = 'https://example.com/watch/video-123';
    assert.equal(canonicalizeVideoUrl(raw), 'https://example.com/watch/video-123');
  });

  test('preserves allowed video parameters: v, id, ep, episode, clip', () => {
    const youtube = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&utm_source=twitter#chapter1';
    assert.equal(canonicalizeVideoUrl(youtube), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    const streaming = 'https://stream.example/watch?id=abc12&ep=5&start=120&token=xyz';
    assert.equal(canonicalizeVideoUrl(streaming), 'https://stream.example/watch?ep=5&id=abc12');

    const clip = 'https://twitch.tv/clip?clip=FamousMoment&utm_medium=social';
    assert.equal(canonicalizeVideoUrl(clip), 'https://twitch.tv/clip?clip=FamousMoment');
  });

  test('strips timestamps (t, start) and tracking (utm_*)', () => {
    const url = 'https://example.com/video?t=120&start=50&utm_source=fb&utm_campaign=promo';
    assert.equal(canonicalizeVideoUrl(url), 'https://example.com/video');
  });

  test('strips hash fragments', () => {
    const url = 'https://aniwaves.to/watch/one-piece.ov8/ep-1#t=300';
    assert.equal(canonicalizeVideoUrl(url), 'https://aniwaves.to/watch/one-piece.ov8/ep-1');
  });

  test('handles invalid URLs gracefully', () => {
    assert.equal(canonicalizeVideoUrl(''), '');
    assert.equal(canonicalizeVideoUrl(null), '');
    assert.equal(canonicalizeVideoUrl('not-a-url'), '');
  });
});

describe('URL Match - buildInviteUrl & parseInviteUrl', () => {
  test('builds and parses full invite URL roundtrip', () => {
    const pairKey = 'testkey123';
    const pageUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const sourceHint = 'vidstream-server-2';

    const invite = buildInviteUrl({ pairKey, pageUrl, sourceHint });
    assert.ok(invite.startsWith(INVITE_BASE_URL));
    assert.ok(invite.includes('#pair=testkey123'));
    assert.ok(invite.includes('url='));
    assert.ok(invite.includes('src=vidstream-server-2'));

    const parsed = parseInviteUrl(invite);
    assert.ok(parsed);
    assert.equal(parsed.pairKey, pairKey);
    assert.equal(parsed.pageUrl, pageUrl);
    assert.equal(parsed.sourceHint, sourceHint);
  });

  test('builds and parses invite URL with pairKey only', () => {
    const invite = buildInviteUrl({ pairKey: 'simpleKey' });
    assert.equal(invite, 'https://jef1056.github.io/lockstep/#pair=simpleKey');

    const parsed = parseInviteUrl(invite);
    assert.ok(parsed);
    assert.equal(parsed.pairKey, 'simpleKey');
    assert.equal(parsed.pageUrl, null);
    assert.equal(parsed.sourceHint, null);
  });

  test('parseInviteUrl handles raw hash strings and URL objects', () => {
    const fromHash = parseInviteUrl('#pair=abc&url=https%3A%2F%2Fsite.com%2Fv%2F1');
    assert.equal(fromHash?.pairKey, 'abc');
    assert.equal(fromHash?.pageUrl, 'https://site.com/v/1');

    const urlObj = new URL('https://jef1056.github.io/lockstep/#pair=xyz');
    const fromObj = parseInviteUrl(urlObj);
    assert.equal(fromObj?.pairKey, 'xyz');
  });

  test('parseInviteUrl returns null for invalid input', () => {
    assert.equal(parseInviteUrl(''), null);
    assert.equal(parseInviteUrl(null), null);
    assert.equal(parseInviteUrl('https://example.com/no-hash'), null);
  });
});

describe('URL Match - findMatchingTab', () => {
  test('finds matching tab by canonical URL', () => {
    const tabs = [
      { id: 1, url: 'https://google.com' },
      { id: 2, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=500s&utm_source=twitter' },
      { id: 3, url: 'https://github.com' }
    ];

    const match = findMatchingTab(tabs, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.ok(match);
    assert.equal(match.id, 2);
  });

  test('finds matching tab via fallback origin + path', () => {
    const tabs = [
      { id: 10, url: 'https://aniwaves.to/watch/one-piece.ov8/ep-1?server=streamtape' },
    ];

    const match = findMatchingTab(tabs, 'https://aniwaves.to/watch/one-piece.ov8/ep-1?server=vidstream');
    assert.ok(match);
    assert.equal(match.id, 10);
  });

  test('returns null when no matching tab is found', () => {
    const tabs = [
      { id: 1, url: 'https://example.com/other-video' }
    ];

    const match = findMatchingTab(tabs, 'https://example.com/target-video');
    assert.equal(match, null);
  });
});
