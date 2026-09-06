/**
 * Dogfood HTTP sandbox server (scenarios 7, 8, 14, and concurrency tests).
 *
 * A controlled node:http server exposing the SAME resource under several
 * behaviors so the firewall meets real HTTP semantics end to end:
 *
 *   /correct/<id>   proper RFC 9110 preconditions: GET issues a strong ETag,
 *                   PUT honors If-Match (412 on mismatch, apply + new ETag
 *                   on match). Missing If-Match applies unconditionally
 *                   (standard HTTP).
 *   /redirect/<id>  307-redirects every request (GET and PUT) to
 *                   /correct/<id>. Used to verify checklist item 5: the
 *                   redirected request must still carry If-Match and the
 *                   target must still enforce it (continuous-dogfood §8).
 *   /broken/<id>    BROKEN server: ignores If-Match entirely. Mutations
 *                   always apply. (The documented operator-verification
 *                   boundary: the firewall cannot detect this.)
 *   /lossy/<id>     PUT applies the mutation, then destroys the socket
 *                   without responding — the executor sees a lost response
 *                   while the external world DID change (unknown outcome).
 *   /outage/<id>    behavior selected by the `x-outage` request header:
 *                   hang | 500 | 429 | reset | garbage (server-side faults).
 *   /500after/<id>  applies the mutation, then responds 500 — the effect
 *                   happened but was reported as an error.
 *
 * State inspection / reset:
 *   GET  /__state/<ns>/<id>   server-side truth (for verifying side effects)
 *   POST /__reset             wipe all namespaces
 *
 * Usage: node sandbox-http-server.mjs <port>; prints "sandbox-ready <port>".
 */

import http from 'node:http';

const port = Number(process.argv[2] ?? 0);

/** stores[ns][id] = { content: string, etag: '"vN"', revision: N } */
const stores = new Map();

function store(ns) {
  if (!stores.has(ns)) stores.set(ns, new Map());
  return stores.get(ns);
}

function getOrCreate(ns, id) {
  const s = store(ns);
  if (!s.has(id)) {
    s.set(id, { content: `resource ${ns}/${id} initial content`, etag: '"v1"', revision: 1, mutations: [] });
  }
  return s.get(id);
}

function applyMutation(ns, id, body) {
  const rec = getOrCreate(ns, id);
  rec.revision += 1;
  rec.etag = `"v${rec.revision}"`;
  rec.content = typeof body?.content === 'string' ? body.content : rec.content;
  rec.mutations.push({ at: new Date().toISOString(), revision: rec.revision });
  return rec;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['correct', 'r1']
  const outage = req.headers['x-outage'];

  if (url.pathname === '/__reset' && req.method === 'POST') {
    stores.clear();
    return send(res, 200, { 'content-type': 'application/json' }, '{"reset":true}');
  }

  if (parts[0] === '__state' && parts.length === 3) {
    const rec = stores.get(parts[1])?.get(parts[2]);
    if (!rec) return send(res, 404, { 'content-type': 'application/json' }, '{"error":"not found"}');
    return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify(rec));
  }

  if (parts.length !== 2) {
    return send(res, 404, { 'content-type': 'application/json' }, '{"error":"unknown path"}');
  }

  const [ns, id] = parts;

  // ---- 307 redirect route (checklist item 5: redirect behavior) -----------
  // Preserves method + body + headers per RFC 9110; undici (the provider's
  // fetch) re-sends the precondition to the target, which enforces it.
  if (ns === 'redirect') {
    return send(res, 307, { location: `/correct/${id}` }, '');
  }

  // ---- mutation-only fault injection (GET is healthy) ----------------------
  if (ns === 'putfail' && req.method !== 'GET') {
    // Consumed on 'end' below; the fault fires once the body is fully read.
  }

  // ---- outage injection ----------------------------------------------------
  if (ns === 'outage') {
    switch (outage) {
      case 'hang':
        return; // never respond; client timeout handles it
      case '500':
        return send(res, 500, { 'content-type': 'application/json' }, '{"error":"internal server error"}');
      case '429':
        return send(res, 429, {
          'content-type': 'application/json',
          'retry-after': '1',
          'x-ratelimit-remaining': '0',
        }, '{"error":"rate limit exceeded"}');
      case 'reset':
        req.destroy();
        return;
      case 'garbage':
        res.socket.write('NOT-HTTP/1.1 nonsense\r\n\r\n');
        res.socket.end();
        return;
      default:
        break; // behave normally below
    }
  }

  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const rec = getOrCreate(ns, id);

    if (req.method === 'GET') {
      return send(res, 200, {
        'content-type': 'application/json',
        etag: rec.etag,
        'last-modified': new Date().toUTCString(),
      }, JSON.stringify({ id, ns, content: rec.content, revision: rec.revision, updated_at: new Date().toISOString() }));
    }

    if (req.method === 'PUT' || req.method === 'PATCH' || req.method === 'POST' || req.method === 'DELETE') {
      if (ns === 'crash' && req.headers['x-crash-delay']) {
        // Applies the mutation after a long delay: the parent can kill the
        // client BEFORE apply (nothing happened) or AFTER apply (side effect
        // done, response never processed).
        const delayMs = Number(req.headers['x-crash-delay'] ?? 8000);
        const apply = () => {
          const rec2 = getOrCreate(ns, id);
          rec2.revision += 1;
          rec2.etag = `"v${rec2.revision}"`;
          rec2.content = typeof body?.content === 'string' ? body.content : rec2.content;
          rec2.mutations.push({ at: new Date().toISOString(), revision: rec2.revision });
          if (req.headers['x-crash-hold'] === '1') return; // apply, then hold the response forever
          send(res, 200, { 'content-type': 'application/json', etag: rec2.etag }, JSON.stringify({ applied: true, revision: rec2.revision }));
        };
        setTimeout(apply, delayMs);
        return;
      }
      if (ns === 'putfail') {
        switch (req.headers['x-putfail']) {
          case 'hang': return; // never respond
          case '500': return send(res, 500, { 'content-type': 'application/json' }, '{"error":"internal server error on mutation"}');
          case '503': return send(res, 503, { 'content-type': 'application/json' }, '{"error":"temporarily unavailable"}');
          case '429': return send(res, 429, { 'content-type': 'application/json', 'retry-after': '1' }, '{"error":"rate limit"}');
          case 'reset': req.destroy(); return;
          case 'garbage':
            res.socket.write('NOT-HTTP/1.1 nonsense\r\n\r\n');
            res.socket.end();
            return;
          default: break;
        }
      }
      const ifMatch = req.headers['if-match'];

      if (ns === 'broken') {
        // BROKEN: ignores If-Match; always applies.
        applyMutation(ns, id, body);
        return send(res, 200, { 'content-type': 'application/json', etag: rec.etag }, JSON.stringify({ applied: true, revision: rec.revision }));
      }

      if (ns === 'lossy') {
        applyMutation(ns, id, body);
        req.destroy(); // side effect happened; response never arrives
        return;
      }

      if (ns === '500after') {
        applyMutation(ns, id, body);
        return send(res, 500, { 'content-type': 'application/json' }, '{"error":"failed after apply"}');
      }

      if (ifMatch === undefined) {
        // No precondition: standard HTTP applies unconditionally.
        applyMutation(ns, id, body);
        return send(res, 200, { 'content-type': 'application/json', etag: rec.etag }, JSON.stringify({ applied: true, revision: rec.revision }));
      }

      // RFC 9110: If-Match uses STRONG comparison. A weak tag W/"x" never matches.
      if (ifMatch !== rec.etag) {
        return send(res, 412, { 'content-type': 'application/json', etag: rec.etag }, JSON.stringify({
          error: 'precondition failed',
          message: `If-Match ${ifMatch} does not match current ETag ${rec.etag}`,
        }));
      }

      applyMutation(ns, id, body);
      return send(res, 200, { 'content-type': 'application/json', etag: rec.etag }, JSON.stringify({ applied: true, revision: rec.revision }));
    }

    return send(res, 405, { 'content-type': 'application/json' }, '{"error":"method not allowed"}');
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`sandbox-ready ${server.address().port}\n`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
