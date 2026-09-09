// Seam 4: durable storage for a deployment with no filesystem.
//
// A serverless function's disk is ephemeral, so anything the brain writes there
// is gone by the next request: a published output, a verdict, an issued grant.
// This backs the document store with Vercel Blob instead, which is the same
// choice the Mission Control this is modelled on already made.
//
// One document per workspace, never one document for everything. The privacy
// boundary is the point of the split, and it has to survive the move to a
// hosted store: two employees never share a document, and a request only ever
// hydrates the platform document and its own caller's workspace.
//
// `@vercel/blob` is imported dynamically, so a clone that never deploys needs no
// install and the local path stays dependency-free.
import { createDocumentBackend } from './store.mjs';

const PREFIX = 'enterprise-brain';

export const blobConfigured = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

const keyFor = (name) => `${PREFIX}/${name}.json`;

async function sdk() {
  try {
    return await import('@vercel/blob');
  } catch {
    throw new Error(
      'the blob backend needs @vercel/blob. Run `npm install` in platform/, or ' +
        'leave BLOB_READ_WRITE_TOKEN unset to use the filesystem.',
    );
  }
}

/**
 * A document backend on Vercel Blob.
 *
 * Reads pass `useCache: false` deliberately. A read straight after a write must
 * not be served the CDN's previous copy, or an approval appears to undo itself
 * a moment after it was made.
 *
 * A read failure degrades to an empty document rather than throwing, so a store
 * hiccup shows an empty board instead of a 500. A WRITE failure is never
 * swallowed: silently losing a published output is worse than an error.
 */
export function createBlobBackend({ logger = () => {} } = {}) {
  return createDocumentBackend({
    async load(name) {
      const { get } = await sdk();
      try {
        const found = await get(keyFor(name), { access: 'private', useCache: false });
        if (!found) return { files: {} };
        const text = await new Response(found.stream).text();
        return JSON.parse(text);
      } catch (err) {
        logger('blob-read-failed', { document: name, error: err?.message });
        return { files: {} };
      }
    },

    async save(name, doc) {
      const { put } = await sdk();
      await put(keyFor(name), JSON.stringify(doc, null, 2), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      logger('blob-write', { document: name, files: Object.keys(doc.files).length });
    },
  });
}

/**
 * The same document backend over a plain Map, for a test or a local run of the
 * hosted code path. Identical semantics, nothing durable, and no token.
 */
export function createFakeRemoteBackend(store = new Map()) {
  const backend = createDocumentBackend({
    async load(name) {
      const text = store.get(name);
      return text ? JSON.parse(text) : { files: {} };
    },
    async save(name, doc) {
      store.set(name, JSON.stringify(doc));
    },
  });
  backend.remote = store;
  return backend;
}

// Which documents a request needs before it can be served: the platform's own,
// and the caller's workspace. Nothing else, so a process never holds a
// workspace it was not asked about.
export const documentsFor = (employee) =>
  employee ? ['platform', `workspaces/${employee}`] : ['platform'];
