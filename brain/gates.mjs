// Component 19. An output's status is set by a check that can FAIL, never by a claim.
// This generalises the pattern that already works in production elsewhere: a runnable
// ledger that exits non-zero, so a figure cannot be published while the check is red.
export class QualityGates {
  constructor(ledger) { this.ledger = ledger; this.checks = new Map(); }

  // A check is (output) -> { pass, evidence }. Registered per output kind.
  register(kind, check) { this.checks.set(kind, check); }

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
