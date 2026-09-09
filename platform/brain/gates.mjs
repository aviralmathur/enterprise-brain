// Component 19. An output's status is set by a check that can FAIL, never by a claim.
// This generalises the pattern that already works in production elsewhere: a runnable
// ledger that exits non-zero, so a figure cannot be published while the check is red.
export class QualityGates {
  constructor(ledger) { this.ledger = ledger; this.checks = new Map(); }

  // A check is (output) -> { pass, evidence }. Registered per output kind.
  register(kind, check) { this.checks.set(kind, check); }

  // Which kinds have a gate at all. A kind that is absent here can only ever be
  // `unverified`, and a board should say so rather than implying nobody looked.
  registered() { return [...this.checks.keys()]; }

  run(outputId) {
    const o = this.ledger.get(outputId);
    if (!o) return { ok: false, reason: 'no such output' };

    const check = this.checks.get(o.kind);
    if (!check) {
      // No gate means no claim of verification. It does not mean "fine".
      this.ledger.setStatus(o.id, 'unverified', { gate: 'none registered for this kind' });
      return { ok: true, status: 'unverified', reason: `no gate registered for kind "${o.kind}"` };
    }

    let result;
    try {
      result = check(o);
    } catch (err) {
      this.ledger.setStatus(o.id, 'gated', { gate: o.kind, error: err.message });
      return { ok: true, status: 'gated', reason: `gate threw: ${err.message}` };
    }

    const status = result.pass ? 'verified' : 'gated';
    this.ledger.setStatus(o.id, status, { gate: o.kind, ...result });
    return { ok: true, status, evidence: result.evidence ?? null };
  }

  runAll() {
    return this.ledger
      .all()
      .filter((o) => o.state === 'live')
      .map((o) => ({ id: o.id, ...this.run(o.id) }));
  }
}

// The gates a deployment starts with. Each one can FAIL, which is the whole
// point: a status nobody could have withheld is not evidence of anything.
//
// A kind that is absent here can only ever be `unverified`, and that is the
// honest label rather than a silent pass. Register your own per kind; these are
// the shape, not the standard.
export function registerDefaultGates(gates) {
  gates.register('metric', (o) => {
    const v = o.body?.value;
    if (typeof v !== 'number') return { pass: false, evidence: 'value is not a number' };
    if (v < 0) return { pass: false, evidence: 'a negative total is a broken query, not a figure' };
    const ageDays = (Date.now() - Date.parse(o.as_of)) / 86_400_000;
    if (ageDays > 7) return { pass: false, evidence: `as_of is ${Math.round(ageDays)} days old` };
    return { pass: true, evidence: 'numeric, non-negative, as_of within 7 days' };
  });

  gates.register('incident_summary', (o) => {
    const v = o.body?.value ?? {};
    if (typeof v.open !== 'number') return { pass: false, evidence: 'open count missing' };
    return { pass: true, evidence: 'open count present' };
  });

  gates.register('headcount', (o) => {
    const v = o.body?.value ?? {};
    const ok = typeof v.billable === 'number' && typeof v.bench === 'number';
    return { pass: ok, evidence: ok ? 'billable and bench present' : 'billable/bench missing' };
  });
}
