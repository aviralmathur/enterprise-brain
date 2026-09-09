// Append-only file store. Deliberately dependency-free and inspectable:
// this is a reference implementation, so `cat data/ledger.jsonl` is a feature.
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function ensure(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function appendLine(path, record) {
  ensure(path);
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
}

export function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// The fallback is CLONED, never handed back by reference. A caller that hoists
// its default — `const EMPTY = { items: {}, seq: 0 }` — would otherwise have
// every reader in the process mutating the same object, and two employees would
// quietly share a board that never existed on disk.
export function readDoc(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeDoc(path, value) {
  ensure(path);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
