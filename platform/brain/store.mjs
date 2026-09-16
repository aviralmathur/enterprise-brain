// Storage. Four primitives, and a backend behind them.
//
// Everything above this file calls these four functions synchronously, which is
// what keeps the ledger, the registry and both boards simple to read. That is
// worth preserving, so the seam is not "make it all async": it is a backend that
// holds the bytes and is filled and emptied around a request.
//
//   filesystem   the default. One file per path, exactly as before.
//   document     a map of path -> text held in memory, hydrated from and
//                flushed back to somewhere durable. This is what makes a
//                serverless deployment possible, where the filesystem is
//                ephemeral and anything written to it is gone by the next call.
//
// The document backend groups paths into DOCUMENTS, one per workspace, so the
// privacy boundary survives the move: two employees never share a document, and
// a process only holds the workspaces it was asked to hydrate.
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---- the filesystem backend, which is still the default ----
function ensure(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function createFilesystemBackend() {
  return {
    kind: 'filesystem',
    get(path) {
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    },
    set(path, text) {
      ensure(path);
      writeFileSync(path, text, 'utf8');
    },
    append(path, text) {
      ensure(path);
      appendFileSync(path, text, 'utf8');
    },
    // Nothing to fill or empty: the filesystem IS the durable store.
    async hydrate() {},
    async flush() {},
  };
}

// ---- which document a path belongs to ----
//
// `.../platform/ledger.jsonl`            -> platform            / ledger.jsonl
// `.../workspaces/alice/fleet-board.json`-> workspaces/alice    / fleet-board.json
//
// Anything unrecognised lands in the platform document rather than a document of
// its own, because a stray path is a bug and it should not quietly create
// storage nobody hydrates.
export function documentFor(path) {
  const p = String(path).replace(/\\/g, '/');
  const ws = p.match(/workspaces\/([^/]+)\/(.+)$/);
  if (ws) return { doc: `workspaces/${ws[1]}`, key: ws[2] };
  const pl = p.match(/platform\/(.+)$/);
  if (pl) return { doc: 'platform', key: pl[1] };
  return { doc: 'platform', key: p.split('/').pop() };
}

/**
 * A backend that holds documents in memory.
 *
 * `load(name)` returns `{ files: { key: text } }` or null, and `save(name, doc)`
 * persists it. Both are async and are only called by hydrate and flush, never
 * by a read or a write, which is what lets everything above stay synchronous.
 *
 * A read from a document that was never hydrated THROWS. Returning null there
 * would be indistinguishable from empty storage, and the caller would helpfully
 * write a fresh empty board over whatever is actually in the store.
 */
export function createDocumentBackend({ load, save }) {
  const docs = new Map(); // name -> { files: {}, _rev }
  const dirty = new Set();
  const baseRev = new Map(); // name -> the _rev seen at hydrate, for optimistic concurrency

  const need = (name) => {
    if (!docs.has(name)) {
      throw new Error(
        `storage document "${name}" was not hydrated before it was read. ` +
          'Hydrate the platform document and the caller\'s workspace before handling a request.',
      );
    }
    return docs.get(name);
  };

  return {
    kind: 'document',

    get(path) {
      const { doc, key } = documentFor(path);
      const files = need(doc).files;
      return Object.prototype.hasOwnProperty.call(files, key) ? files[key] : null;
    },

    set(path, text) {
      const { doc, key } = documentFor(path);
      need(doc).files[key] = text;
      dirty.add(doc);
    },

    append(path, text) {
      const { doc, key } = documentFor(path);
      const files = need(doc).files;
      files[key] = (files[key] ?? '') + text;
      dirty.add(doc);
    },

    // Fill the documents this request will touch. Already-hydrated documents are
    // left alone, so calling it twice in one request costs nothing.
    async hydrate(names) {
      for (const name of [].concat(names)) {
        if (docs.has(name)) continue;
        const loaded = (await load(name)) ?? { files: {} };
        docs.set(name, loaded);
        baseRev.set(name, loaded._rev ?? 0);
      }
      return [...docs.keys()];
    },

    // Write back only what changed. Nothing is written when nothing was.
    //
    // Optimistic concurrency (B4): before writing a document, re-read it and
    // confirm nobody has written it since this request hydrated. If the revision
    // moved, another writer got there first — throw rather than overwrite their
    // append, which on a shared store (Vercel Blob) is a lost ledger event.
    // This is read-check-write, not a store-level compare-and-set, so it narrows
    // the race rather than closing it; a backend with atomic CAS should use it.
    async flush() {
      const written = [];
      for (const name of dirty) {
        const current = (await load(name)) ?? { files: {} };
        const currentRev = current._rev ?? 0;
        if (currentRev !== baseRev.get(name)) {
          throw new Error(
            `concurrent write conflict on document "${name}" ` +
              `(store is at rev ${currentRev}, this request hydrated rev ${baseRev.get(name)}); ` +
              'reload and retry so the other writer\'s changes are not lost.',
          );
        }
        const doc = docs.get(name);
        doc._rev = currentRev + 1;
        await save(name, doc);
        baseRev.set(name, doc._rev);
        written.push(name);
      }
      dirty.clear();
      return written;
    },

    // Drop everything, so one process can serve a second request without
    // carrying the first caller's workspace.
    reset() {
      docs.clear();
      dirty.clear();
      baseRev.clear();
    },

    hydrated() {
      return [...docs.keys()];
    },

    pending() {
      return [...dirty];
    },
  };
}

// ---- the active backend ----
let backend = createFilesystemBackend();

export function setBackend(next) {
  backend = next;
  return backend;
}

export function currentBackend() {
  return backend;
}

// ---- the four primitives everything above this file uses ----
export function appendLine(path, record) {
  backend.append(path, JSON.stringify(record) + '\n');
}

export function readLines(path) {
  const text = backend.get(path);
  if (!text) return [];
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// The fallback is CLONED, never handed back by reference. A caller that hoists
// its default — `const EMPTY = { items: {}, seq: 0 }` — would otherwise have
// every reader in the process mutating the same object, and two employees would
// quietly share a board that never existed in storage.
export function readDoc(path, fallback) {
  const text = backend.get(path);
  if (text === null || text === undefined) return structuredClone(fallback);
  return JSON.parse(text);
}

export function writeDoc(path, value) {
  backend.set(path, JSON.stringify(value, null, 2) + '\n');
}
