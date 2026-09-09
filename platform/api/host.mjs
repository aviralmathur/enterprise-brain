// The whole brain as one serverless function.
//
// This is the only file in `api/`, because Vercel turns every file in this
// directory into a function and there is exactly one here on purpose: the host
// is already a pure request handler, so a single entry point can serve the
// boards, the API and the endpoints a connection descriptor names.
//
// Three things differ from `serve.mjs`, and all three come from the same fact:
// a function has no durable filesystem and no memory between requests.
//
//   1. Storage is a document backend on Vercel Blob, not files on disk.
//   2. The documents this request needs are hydrated before it is handled and
//      flushed after, so a write survives the invocation.
//   3. Only the platform document and the CALLER'S OWN workspace are hydrated.
//      The privacy boundary is the reason the storage is split by workspace, so
//      a process must never hold a workspace it was not asked about.
import { buildPlatform } from '../wire.mjs';
import { platformWorkspace } from '../workspace.mjs';
import { setBackend } from '../brain/store.mjs';
import { createBlobBackend, blobConfigured, documentsFor } from '../brain/blob-store.mjs';

const ROOT = 'data/hosted';

// The backend and the wiring are built once per warm instance; the DOCUMENTS are
// not, because they belong to a request and not to the process.
const backend = setBackend(createBlobBackend({ logger: (e, d) => console.log('[blob]', e, JSON.stringify(d)) }));

const platform = buildPlatform({
  ws: platformWorkspace(`${ROOT}/platform`),
  workspaceRoot: `${ROOT}/workspaces`,
  // Never on a deployment: this hands out bearer values.
  devTokens: false,
});

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body, null, 2));
};

// Who is calling, read from the token alone, so we know which workspace to
// hydrate. This does not authorise anything: the host re-resolves the principal
// and makes every access decision itself.
function callerFrom(req) {
  const raw = req.headers.authorization ?? '';
  if (!raw.startsWith('Bearer ')) return null;
  const principal = platform.tokens.resolve(raw.slice(7).trim());
  return principal?.employee ?? null;
}

export default async function handler(req, res) {
  if (!blobConfigured()) {
    return json(res, 503, {
      ok: false,
      reason: 'no storage configured: set BLOB_READ_WRITE_TOKEN on this deployment',
    });
  }

  const url = new URL(req.url, `https://${req.headers.host ?? 'localhost'}`);

  try {
    // A warm instance must not serve the previous caller's workspace.
    backend.reset();

    // The platform document holds the tokens, so it has to land before the
    // caller can be identified at all. Then their own workspace, and nothing
    // else.
    await backend.hydrate(documentsFor(null));
    const employee = callerFrom(req);
    if (employee) await backend.hydrate(documentsFor(employee));

    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { ok: false, reason: 'body must be JSON' });
        }
      }
      body = body ?? {};
    }

    const out = await platform.host.handle({
      method: req.method,
      path: url.pathname,
      query: { ...Object.fromEntries(url.searchParams), __base: `https://${req.headers.host}` },
      headers: req.headers,
      body,
      // A hosted deployment is never the loopback interface, whatever the
      // socket says behind a proxy.
      loopback: false,
    });

    // Only what changed, and only after the handler returned. A request that
    // failed authorisation wrote nothing, so it flushes nothing.
    const written = await backend.flush();
    if (written.length) console.log('[blob] flushed', written.join(', '));

    if (out.contentType) {
      res.statusCode = out.status;
      res.setHeader('content-type', out.contentType);
      res.setHeader('cache-control', 'no-store');
      res.end(out.body);
      return;
    }
    return json(res, out.status, out.body);
  } catch (err) {
    // A thrown handler never leaks a stack trace to a caller.
    console.error('[error]', url.pathname, err?.message);
    return json(res, 500, { ok: false, reason: 'internal error' });
  }
}
