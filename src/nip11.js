import fs from 'node:fs';
import { createHash } from 'node:crypto';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const VERSION = pkg.version;
const SOFTWARE_URL = 'https://github.com/xannythepleb/xannyblastr';

// Adjust this path if your index.html lives somewhere else.
const INDEX_HTML = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const INDEX_HTML_CSP = buildIndexHtmlCsp(INDEX_HTML);
const INDEX_HTML_ETAG = makeWeakEtag(INDEX_HTML);

/** Build the NIP-11 relay information document. */
export function buildNip11(cfg) {
  return {
    name: cfg.name,
    description: cfg.description,
    pubkey: cfg.adminHex, // admin contact key
    supported_nips: [1, 11, 17, 42, 59],
    software: SOFTWARE_URL,
    version: VERSION,
    limitation: {
      auth_required: true,     // NIP-42 required to write (and to read, if privateReads)
      restricted_writes: true, // only the admin's web of trust may publish
      payment_required: false,
    },
  };
}

/**
 * Attach HTTP handlers to an existing http.Server.
 *
 * WebSocket upgrades are handled separately by the ws server.
 *
 * Plain HTTP behaviour:
 * - NIP-11 clients requesting `Accept: application/nostr+json` get relay metadata.
 * - Normal browser visits get the static project page.
 */
export function attachNip11(httpServer, cfg) {
  const nip11Path = cfg.nip11Path ?? '/';

  httpServer.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    setBaseHeaders(res);

    if (isNip11Route(url.pathname, nip11Path)) {
      setCorsHeaders(res);

      if (req.method === 'OPTIONS') {
        res.setHeader('Content-Length', '0');
        res.writeHead(204);
        return res.end();
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD, OPTIONS');
        return sendEmpty(res, 405);
      }

      const contentLength = Number(req.headers['content-length'] ?? 0);
      if (contentLength > 0) {
        return sendEmpty(res, 413);
      }

      if (wantsNip11(req)) {
        return sendNip11(req, res, cfg);
      }

      // Same URL, but a normal browser-style request.
      return sendIndexHtml(req, res);
    }

    // Optional nice-to-have: allow direct browser navigation to /index.html.
    if (url.pathname === '/index.html') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return sendEmpty(res, 405);
      }

      return sendIndexHtml(req, res);
    }

    return sendEmpty(res, 404);
  });
}

function isNip11Route(pathname, nip11Path) {
  return pathname === nip11Path;
}

function wantsNip11(req) {
  const accept = req.headers.accept;

  if (!accept) {
    return false;
  }

  return accept
    .split(',')
    .map((part) => part.split(';')[0].trim().toLowerCase())
    .includes('application/nostr+json');
}

function sendNip11(req, res, cfg) {
  const body = JSON.stringify(buildNip11(cfg));
  const etag = makeWeakEtag(body);

  setJsonHeaders(res);
  res.setHeader('ETag', etag);

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    return res.end();
  }

  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.writeHead(200);

  if (req.method === 'HEAD') {
    return res.end();
  }

  res.end(body);
}

function sendIndexHtml(req, res) {
  setHtmlHeaders(res);
  res.setHeader('ETag', INDEX_HTML_ETAG);

  if (req.headers['if-none-match'] === INDEX_HTML_ETAG) {
    res.writeHead(304);
    return res.end();
  }

  res.setHeader('Content-Length', Buffer.byteLength(INDEX_HTML));
  res.writeHead(200);

  if (req.method === 'HEAD') {
    return res.end();
  }

  res.end(INDEX_HTML);
}

function setJsonHeaders(res) {
  res.setHeader('Content-Type', 'application/nostr+json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=300');
  res.setHeader('Vary', 'Accept');
}

function setHtmlHeaders(res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  // Static landing page. Short cache is fine.
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=300');

  res.setHeader('Content-Security-Policy', INDEX_HTML_CSP);

  // Allows the copy button to use navigator.clipboard.writeText() from this page,
  // while not granting broader clipboard access to framed/foreign contexts.
  res.setHeader('Permissions-Policy', 'clipboard-write=(self)');
}

function buildIndexHtmlCsp(html) {
  const scriptHashes = extractTagContents(html, 'script').map(makeCspHash);
  const styleHashes = extractTagContents(html, 'style').map(makeCspHash);

  return [
    "default-src 'none'",

    scriptHashes.length > 0
      ? `script-src ${scriptHashes.join(' ')}`
      : "script-src 'none'",

    styleHashes.length > 0
      ? `style-src ${styleHashes.join(' ')}`
      : "style-src 'none'",

    // Required by fetch(location.pathname).
    "connect-src 'self'",

    // Your current page does not load external images. The inline SVG does not
    // need img-src, but this keeps local/data images available if you add a logo.
    "img-src 'self' data:",

    // You only use system fonts, not web fonts.
    "font-src 'none'",

    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function extractTagContents(html, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  return [...html.matchAll(re)].map((match) => match[1]);
}

function makeCspHash(content) {
  const hash = createHash('sha256').update(content).digest('base64');
  return `'sha256-${hash}'`;
}

function setCorsHeaders(res) {
  // NIP-11 is public metadata. Wildcard origin is appropriate as long as this
  // endpoint never uses cookies, sessions, bearer tokens, or credentials.
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Explicit is better than "*". These are enough for normal NIP-11 fetches and
  // common browser/client behaviour.
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, X-Requested-With');

  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

  // Reduces repeated preflight traffic without locking you into anything risky.
  res.setHeader('Access-Control-Max-Age', '86400');
}

function setBaseHeaders(res) {
  // Prevent browsers from treating JSON/HTML as some other MIME type.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendEmpty(res, statusCode) {
  res.setHeader('Content-Length', '0');
  res.writeHead(statusCode);
  res.end();
}

function makeWeakEtag(body) {
  const hash = createHash('sha256').update(body).digest('base64url');
  return `W/"${hash}"`;
}