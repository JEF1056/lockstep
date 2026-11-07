/**
 * Lockstep URL Matching, Canonicalization, and Invite Link Handling
 */

export const INVITE_BASE_URL = 'https://jef1056.github.io/lockstep/';

export const ALLOWED_QUERY_PARAMS = new Set([
  'v',
  'id',
  'video',
  'vid',
  'video_id',
  'ep',
  'episode',
  's',
  'season',
  'clip',
  'part',
  'p',
  'bvid',
  'aid',
  'cid',
  'mid',
  'stream',
  'room',
  'ch',
  'channel',
  'docid',
  'movie',
  'watch'
]);

/**
 * Strips tracking parameters, timestamps, and hashes while preserving
 * video identity (origin, pathname, and essential query params).
 */
export function canonicalizeVideoUrl(url) {
  if (!url) return '';
  let urlObj;
  try {
    urlObj = new URL(url);
  } catch {
    return '';
  }

  // Strip hash
  urlObj.hash = '';

  // Filter query parameters: keep only allowed video identifier keys
  const keptParams = [];
  for (const [key, value] of urlObj.searchParams.entries()) {
    const lowerKey = key.toLowerCase();
    if (ALLOWED_QUERY_PARAMS.has(lowerKey)) {
      keptParams.push([lowerKey, value]);
    }
  }

  // Sort parameters for deterministic canonical comparison
  keptParams.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  urlObj.search = '';
  for (const [key, val] of keptParams) {
    urlObj.searchParams.append(key, val);
  }

  // Normalize pathname: remove trailing slashes except for root
  if (urlObj.pathname.length > 1 && urlObj.pathname.endsWith('/')) {
    urlObj.pathname = urlObj.pathname.replace(/\/+$/, '');
  }

  return urlObj.toString();
}

/**
 * Evaluates whether a URL represents a shareable video/stream/reel page
 * using site-agnostic path and parameter heuristics (zero hardcoded domains).
 */
export function isShareableVideoPageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return false;
  }

  // Preserved video identifier query parameters
  for (const key of ALLOWED_QUERY_PARAMS) {
    const val = u.searchParams.get(key);
    if (val && val.trim().length > 0) {
      return true;
    }
  }

  // Search queries indicate search results pages, never individual video pages
  for (const key of ['q', 'search_query', 'query', 'keyword']) {
    if (u.searchParams.has(key)) {
      return false;
    }
  }

  const p = u.pathname.replace(/\/+$/, '');
  if (!p || p === '/') {
    return false;
  }

  const segs = p.split('/').filter(Boolean);
  if (segs.length === 0) {
    return false;
  }
  const s0 = segs[0].toLowerCase();

  if (['feed', 'directory', 'search', 'results'].includes(s0)) {
    return false;
  }

  if (segs.length === 1 && [
    'home', 'index', 'browse', 'discover', 'explore',
    'trending', 'popular', 'foryou', 'following', 'subscriptions',
    'categories', 'channels'
  ].includes(s0)) {
    return false;
  }

  if (s0.startsWith('@') && segs.length <= 2 && (!segs[1] || /^(featured|videos|shorts|streams|releases|playlists|community|about)$/i.test(segs[1]))) {
    return false;
  }

  if (/^(channel|c|user)$/i.test(s0) && segs.length <= 3 && (!segs[2] || /^(featured|videos|shorts|streams|playlists|community|about)$/i.test(segs[2]))) {
    return false;
  }

  return true;
}

/**
 * Generates an invite URL with embedded #pair, &url, and &src fragment parameters.
 */
export function buildInviteUrl({ pairKey, pageUrl, sourceHint } = {}) {
  const parts = [];
  if (pairKey) {
    parts.push(`pair=${encodeURIComponent(pairKey)}`);
  }
  if (pageUrl) {
    parts.push(`url=${encodeURIComponent(pageUrl)}`);
  }
  if (sourceHint) {
    parts.push(`src=${encodeURIComponent(sourceHint)}`);
  }
  return `${INVITE_BASE_URL}${parts.length ? '#' + parts.join('&') : ''}`;
}

/**
 * Parses invite URL or hash string, returning { pairKey, pageUrl, sourceHint } or null.
 */
export function parseInviteUrl(url) {
  if (!url) return null;
  let hashStr = '';

  if (typeof url === 'string') {
    const hashIndex = url.indexOf('#');
    if (hashIndex !== -1) {
      hashStr = url.slice(hashIndex + 1);
    } else if (url.startsWith('pair=') || url.includes('&url=') || url.includes('&src=')) {
      hashStr = url;
    }
  } else if (url instanceof URL) {
    hashStr = url.hash.replace(/^#/, '');
  }

  if (!hashStr) return null;

  try {
    const sp = new URLSearchParams(hashStr);
    const pairKey = sp.get('pair') || null;
    const pageUrl = sp.get('url') || null;
    const sourceHint = sp.get('src') || null;

    if (!pairKey && !pageUrl && !sourceHint) {
      return null;
    }

    return { pairKey, pageUrl, sourceHint };
  } catch {
    return null;
  }
}

/**
 * Finds an open browser tab matching the target video URL.
 * Compares canonical video URLs strictly.
 */
export function findMatchingTab(tabs, url) {
  if (!Array.isArray(tabs) || !url) return null;
  const targetCanon = canonicalizeVideoUrl(url);
  if (!targetCanon) return null;

  for (const tab of tabs) {
    if (!tab || !tab.url) continue;
    if (canonicalizeVideoUrl(tab.url) === targetCanon) {
      return tab;
    }
  }

  return null;
}

/**
 * Generates a random cryptographic pair key.
 */
export function generatePairKey() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(36).slice(2, 14);
}
