// The third seam: how a request over the wire becomes a principal.
//
// A token is issued per FLEET, not per employee, and it carries both the employee
// and the fleet id. That is deliberate: it means a caller cannot name which fleet
// it is acting as, which removes a whole class of impersonation. Only the agent id
// comes from the request, and the host verifies that against the roster.
//
// Real deployments replace this with whatever mints their tokens (OIDC, an internal
// STS, mTLS identity). The contract is one method:
//
//   resolve(token) -> { employee, fleet } | null
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
      return { employee: rec.employee, fleet: rec.fleet };
    },

    // Issued when a fleet is set up. The fleet builder puts this in their harness
    // config alongside the endpoints.
    issue({ employee, fleet, expires_at = null }) {
      const db = readDoc(path, { tokens: {} });
      const token = `ebt_${randomBytes(18).toString('hex')}`;
      db.tokens[token] = { employee, fleet, expires_at, revoked: false, issued_at: new Date().toISOString() };
      writeDoc(path, db);
      return { ok: true, token, employee, fleet };
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
