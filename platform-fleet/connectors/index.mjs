// Vendor adapters. These are the seam: no ServiceNow / Salesforce / Graph tenancy
// exists here, so each adapter answers from a fixture. What is real and load-bearing
// is the CONTRACT - the shape a vendor result must be normalised into before the
// ledger will accept it (D12: the output schema is a vendor adapter target).
//
// Replacing a stub with the real client means implementing call() against the vendor
// API and keeping normalise() unchanged. Nothing above this file changes.

let seq = 0;
const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}_${(seq += 1)}`;

function adapter({ system, auth_mode, reads, writes, fixtures }) {
  return {
    system,
    auth_mode,
    reads,
    writes,

    // Normalising is the adapter's real job: vendor payload -> our output shape.
    normalise(op, payload, ctx) {
      return {
        id: nextId(`${system}`),
        kind: payload.kind,
        body: payload.body,
        sources: [{ system, ref: payload.ref, harness: false }],
        derived_from: [],
        ttl_seconds: payload.ttl_seconds ?? 3600,
        // A vendor claim is unverified until a quality gate runs against it.
        status: 'unverified',
        as_of: new Date().toISOString(),
        note: `via ${system}.${op} on behalf of ${ctx.employee}`,
      };
    },

    call(op, args, ctx) {
      if (![...reads, ...writes].includes(op)) {
        return { ok: false, reason: `${system} adapter has no op "${op}"` };
      }
      const fixture = fixtures[op];
      if (!fixture) return { ok: false, reason: `${system}.${op} returned nothing` };
      const payload = typeof fixture === 'function' ? fixture(args, ctx) : fixture;
      if (writes.includes(op)) {
        // A write returns a receipt, and the receipt is itself an output.
        return { ok: true, receipt: payload, output: this.normalise(op, payload, ctx) };
      }
      return { ok: true, output: this.normalise(op, payload, ctx) };
    },
  };
}

export const servicenow = adapter({
  system: 'servicenow',
  // The honest default for most ServiceNow integrations, and the reason the agent
  // in front of it must be narrowly scoped (see registry.scopeReview).
  auth_mode: 'service_account',
  reads: ['incident.summary'],
  writes: ['incident.create'],
  fixtures: {
    'incident.summary': {
      kind: 'incident_summary',
      ref: 'INC-QUERY',
      body: { subject: 'payments-api', value: { open: 7, p1: 1, trend: 'up' } },
    },
    'incident.create': (args) => ({
      kind: 'incident_receipt',
      ref: 'INC0042199',
      body: { subject: args.short_description ?? 'unspecified', value: { number: 'INC0042199', state: 'new' } },
    }),
  },
});

export const agentforce = adapter({
  system: 'agentforce',
  auth_mode: 'delegated',
  reads: ['account.health'],
  writes: ['case.create'],
  fixtures: {
    'account.health': (args, ctx) => ({
      kind: 'account_health',
      ref: `ACC-${args.account ?? 'unknown'}`,
      // A delegated connector can legitimately vary by caller.
      body: { subject: args.account ?? 'unknown', value: { score: ctx.employee === 'raj' ? 71 : 68, renewal_risk: 'medium' } },
    }),
    'case.create': (args) => ({
      kind: 'case_receipt',
      ref: 'CASE-88120',
      body: { subject: args.subject ?? 'unspecified', value: { id: 'CASE-88120', status: 'open' } },
    }),
  },
});

export const copilot = adapter({
  system: 'copilot',
  // Graph does per-user on-behalf-of natively, which is why this is the easy first connector.
  auth_mode: 'delegated',
  reads: ['tenant.usage'],
  writes: [],
  fixtures: {
    'tenant.usage': {
      kind: 'tenant_usage',
      ref: 'GRAPH-REPORTS',
      body: { subject: 'copilot', value: { weekly_active: 4120, seats: 5000 } },
    },
  },
});

export const all = { servicenow, agentforce, copilot };
