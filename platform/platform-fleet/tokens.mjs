// The third seam: how a request over the wire becomes a principal.
//
// Two kinds of principal, and the difference is the whole authorization story:
//
//   fleet     -> { kind: 'fleet',    employee, fleet }   one employee, one fleet
//   platform  -> { kind: 'platform', employee }          a member of the platform team
//
// A fleet token is issued per FLEET, not per employee, and it carries both the
// employee and the fleet id. That is deliberate: a caller cannot name which fleet
// it is acting as, which removes a whole class of impersonation. Only the agent id
// comes from the request, and the host verifies that against the roster.
//
// Real deployments replace this with whatever mints their tokens (OIDC, an internal
// STS, mTLS identity). The contract is one method:
//
//   resolve(token) -> { kind, employee, fleet } | null
import { readDoc, writeDoc } from '../brain/store.mjs';
import { randomBytes } from 'node:crypto';

export function createLocalTokenResolver(path) {
  return {
    name: 'local-token-file',

    resolve(token) {
      if (!token) return null;
      // Read every time. A cached token map is a revocation bug.
      const db = readDoc(path, { tokens: {} });
      const rec = db.tokens[token];
      if (!rec) return null;
      if (rec.revoked) return null;
      if (rec.expires_at && Date.parse(rec.expires_at) <= Date.now()) return null;
      // `kind` defaults to fleet so a token minted before there were two kinds
      // still resolves to the principal it was issued as.
      return { kind: rec.kind ?? 'fleet', employee: rec.employee, fleet: rec.fleet ?? null, expires_at: rec.expires_at ?? null };
    },

    // Issued when a fleet is set up. The fleet builder puts this in their harness
    // config alongside the endpoints. A platform token names no fleet, because
    // the platform team does not act as one.
    issue({ kind = 'fleet', employee, fleet = null, expires_at = null, days = null, label = null }) {
      if (!['fleet', 'platform'].includes(kind)) return { ok: false, errors: ['kind must be fleet or platform'] };
      if (!employee) return { ok: false, errors: ['employee is required'] };
      if (kind === 'fleet' && !fleet) return { ok: false, errors: ['a fleet token must name a fleet'] };

      const db = readDoc(path, { tokens: {} });
      const token = `${kind === 'platform' ? 'ebp' : 'ebt'}_${randomBytes(18).toString('hex')}`;
      const expiry = expires_at ?? (days ? new Date(Date.now() + days * 86_400_000).toISOString() : null);
      db.tokens[token] = {
        kind, employee, fleet, label,
        expires_at: expiry, revoked: false, issued_at: new Date().toISOString(),
      };
      writeDoc(path, db);
      return { ok: true, token, kind, employee, fleet, expires_at: expiry };
    },

    // Every issued token, for the platform team's own view. The bearer value is
    // returned here because this is the store; the API route that exposes it
    // decides whether anybody may see it.
    list() {
      const db = readDoc(path, { tokens: {} });
      return Object.entries(db.tokens).map(([token, r]) => ({ token, ...r }));
    },

    revoke(token) {
      const db = readDoc(path, { tokens: {} });
      if (!db.tokens[token]) return { ok: false, errors: ['no such token'] };
      db.tokens[token].revoked = true;
      db.tokens[token].revoked_at = new Date().toISOString();
      writeDoc(path, db);
      return { ok: true };
    },
  };
}
