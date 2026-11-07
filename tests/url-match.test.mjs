import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  INVITE_BASE_URL,
  canonicalizeVideoUrl,
  findMatchingTab,
  buildInviteUrl,
  parseInviteUrl,
  generatePairKey,
  isShareableVideoPageUrl
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

  test('does NOT match different videos on same origin and pathname (watch?v=A vs watch?v=B)', () => {
    const tabs = [
      { id: 10, url: 'https://www.youtube.com/watch?v=OLD_VIDEO' }
    ];

    const match = findMatchingTab(tabs, 'https://www.youtube.com/watch?v=NEW_VIDEO');
    assert.equal(match, null);
  });

  test('matches tabs when only ignored query params differ (?server=a vs ?server=b)', () => {
    const tabs = [
      { id: 10, url: 'https://aniwaves.to/watch/one-piece.ov8/ep-1?server=streamtape' }
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

describe('URL Match - isShareableVideoPageUrl', () => {
  test('rejects invalid or non-http(s) URLs and bare site homepages', () => {
    assert.equal(isShareableVideoPageUrl(''), false);
    assert.equal(isShareableVideoPageUrl(null), false);
    assert.equal(isShareableVideoPageUrl('chrome://extensions/'), false);
    assert.equal(isShareableVideoPageUrl('file:///Users/test/video.mp4'), false);
    assert.equal(isShareableVideoPageUrl('https://www.youtube.com/'), false);
    assert.equal(isShareableVideoPageUrl('https://www.youtube.com'), false);
    assert.equal(isShareableVideoPageUrl('https://twitch.tv/'), false);
  });

  test('allows pages with explicit video/episode query params even on root or feed paths', () => {
    assert.equal(isShareableVideoPageUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
    assert.equal(isShareableVideoPageUrl('https://site.example/?video_id=123'), true);
    assert.equal(isShareableVideoPageUrl('https://site.example/feed?bvid=BV1xx411c7mD'), true);
    assert.equal(isShareableVideoPageUrl('https://site.example/watch?ep=4&season=2'), true);
  });

  test('rejects search result pages and directory/feed/browse pages', () => {
    assert.equal(isShareableVideoPageUrl('https://www.youtube.com/results?search_query=cats'), false);
    assert.equal(isShareableVideoPageUrl('https://site.example/search?q=anime'), false);
    assert.equal(isShareableVideoPageUrl('https://site.example/videos?query=music'), false);
    assert.equal(isShareableVideoPageUrl('https://site.example/browse?keyword=live'), false);
    assert.equal(isShareableVideoPageUrl('https://www.youtube.com/feed/subscriptions'), false);
    assert.equal(isShareableVideoPageUrl('https://twitch.tv/directory/following'), false);
    assert.equal(isShareableVideoPageUrl('https://site.example/explore'), false);
    assert.equal(isShareableVideoPageUrl('https://site.example/trending/'), false);
    assert.equal(isShareableVideoPageUrl('https://site.example/foryou'), false);
    assert.equal(isShareableVideoPageUrl('https://site.example/home'), false);
  });

  test('rejects @handle and channel/user profile index pages without video IDs', () => {
    assert.equal(isShareableVideoPageUrl('https://www.youtube.com/@creator'), false);
    assert.equal(isShareableVideoPageUrl('https://www.youtube.com/@creator/videos'), false);
    assert.equal(isShareableVideoPageUrl('https://www.youtube.com/@creator/shorts'), false);
    assert.equal(isShareableVideoPageUrl('https://www.youtube.com/channel/UC12345'), false);
    assert.equal(isShareableVideoPageUrl('https://www.youtube.com/channel/UC12345/streams'), false);
    assert.equal(isShareableVideoPageUrl('https://www.youtube.com/c/SomeChannel/playlists'), false);
    assert.equal(isShareableVideoPageUrl('https://www.youtube.com/user/SomeUser/about'), false);
  });

  test('allows actual video, shorts, stream, and episode paths', () => {
    assert.equal(isShareableVideoPageUrl('https://www.youtube.com/shorts/abc123XYZ'), true);
    assert.equal(isShareableVideoPageUrl('https://aniwaves.to/watch/one-piece.ov8/ep-1'), true);
    assert.equal(isShareableVideoPageUrl('https://www.tiktok.com/@user123/video/71234567890'), true);
    assert.equal(isShareableVideoPageUrl('https://site.example/video'), true);
    assert.equal(isShareableVideoPageUrl('https://site.example/watch'), true);
    assert.equal(isShareableVideoPageUrl('https://twitch.tv/shroud'), true);
  });
});
