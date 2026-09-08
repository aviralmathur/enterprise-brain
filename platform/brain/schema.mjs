// The output object. Phase 0 contract; the whole brain hangs off this.
// Harness-agnostic by decision D12 — nothing Claude-specific appears here.

export const STATUS = ['verified', 'gated', 'unverified'];
export const STATE = ['live', 'stale', 'tombstoned', 'frozen'];

export function newOutput(fields) {
  return {
    id: fields.id,
    kind: fields.kind,
    producer: fields.producer,          // { fleet, agent, identity }
    body: fields.body ?? {},
    sources: fields.sources ?? [],      // [{ system, ref, harness: bool }]
    derived_from: fields.derived_from ?? [],
    supersedes: fields.supersedes ?? null,
    as_of: fields.as_of ?? new Date().toISOString(),
    ttl_seconds: fields.ttl_seconds ?? null,
    status: fields.status ?? 'unverified',
    scope: fields.scope ?? null,        // computed by the ledger, never trusted from here
    state: 'live',
    signer_state: 'active',             // 'active' | 'former' (D16)
    published_at: null,
  };
}

const isStr = (v) => typeof v === 'string' && v.length > 0;

export function validate(o) {
  const errs = [];
  if (!isStr(o.id)) errs.push('id must be a non-empty string');
  if (!isStr(o.kind)) errs.push('kind must be a non-empty string');
  if (!o.producer || !isStr(o.producer.agent)) errs.push('producer.agent is required');
  if (!o.producer || !isStr(o.producer.identity)) errs.push('producer.identity is required');
  if (!Array.isArray(o.sources)) errs.push('sources must be an array');
  for (const s of o.sources ?? []) {
    if (!isStr(s.system)) errs.push('every source needs a system');
  }
  if (!Array.isArray(o.derived_from)) errs.push('derived_from must be an array');
  if (!STATUS.includes(o.status)) errs.push(`status must be one of ${STATUS.join('|')}`);
  if (o.ttl_seconds !== null && !(Number.isInteger(o.ttl_seconds) && o.ttl_seconds > 0)) {
    errs.push('ttl_seconds must be a positive integer or null');
  }
  if (Number.isNaN(Date.parse(o.as_of))) errs.push('as_of must be an ISO timestamp');
  return errs;
}

export function isExpired(o, now = Date.now()) {
  if (!o.ttl_seconds) return false;
  return now > Date.parse(o.as_of) + o.ttl_seconds * 1000;
}

// Freshness a consumer can act on, without the consumer having to reason about it.
export function freshness(o, now = Date.now()) {
  if (o.state === 'tombstoned') return 'tombstoned';
  if (o.state === 'stale') return 'stale';
  if (isExpired(o, now)) return 'expired';
  if (o.signer_state === 'former') return 'frozen';
  return 'fresh';
}
