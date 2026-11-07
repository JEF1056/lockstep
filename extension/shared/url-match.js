/**
 * Lockstep URL Matching, Canonicalization, and Invite Link Handling
 */

export const INVITE_BASE_URL = 'https://jef1056.github.io/lockstep/';

const ALLOWED_QUERY_PARAMS = new Set(['v', 'id', 'ep', 'episode', 'clip']);

/**
 * Strips tracking parameters, timestamps, and hashes while preserving
 * video identity (origin, pathname, and essential query params like v, id, ep, episode, clip).
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
 * Compares canonical video URLs, falling back to origin + pathname match.
 */
export function findMatchingTab(tabs, url) {
  if (!Array.isArray(tabs) || !url) return null;
  const targetCanon = canonicalizeVideoUrl(url);
  if (!targetCanon) return null;

  // 1. Exact canonical URL match
  for (const tab of tabs) {
    if (!tab || !tab.url) continue;
    if (canonicalizeVideoUrl(tab.url) === targetCanon) {
      return tab;
    }
  }

  // 2. Fallback: origin + pathname match
  try {
    const targetObj = new URL(targetCanon);
    for (const tab of tabs) {
      if (!tab || !tab.url) continue;
      try {
        const tabObj = new URL(tab.url);
        if (tabObj.origin === targetObj.origin && tabObj.pathname === targetObj.pathname) {
          return tab;
        }
      } catch {}
    }
  } catch {}

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
