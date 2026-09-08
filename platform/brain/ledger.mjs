// The append-only output ledger. Owns the two rules that make the brain safe:
//   D7  — scope is COMPUTED from derived_from, never accepted from the producer
//   D11 — any harness-connector source makes the output fleet-private
//   D15 — deletion is a tombstone plus a cascade, never a hard delete
//   D16 — a departed signer's outputs survive frozen
import { appendLine, readLines } from './store.mjs';
import { validate, freshness } from './schema.mjs';
import { intersectAll, narrowest, fleetScope, describe, visibleTo, NOBODY } from './scope.mjs';
import { descendants, ancestry, conflicts } from './provenance.mjs';

export class Ledger {
  // resolvers: { declaredScopeOf(agentId), fleetOwner(fleetId), isEnterpriseAgent(agentId) }
  constructor(path, resolvers = {}) {
    this.path = path;
    this.resolvers = {
      declaredScopeOf: () => null,
      fleetOwner: () => null,
      isEnterpriseAgent: () => false,
      ...resolvers,
    };
    this.overlayPath = path.replace(/\.jsonl$/, '.state.jsonl');
  }

  // Events are appended; current state is a fold. Nothing is ever rewritten.
  events() { return readLines(this.path); }
  stateEvents() { return readLines(this.overlayPath); }

  all() {
    const byId = new Map();
    for (const o of this.events()) byId.set(o.id, { ...o });
    for (const ev of this.stateEvents()) {
      const o = byId.get(ev.id);
      if (!o) continue;
      if (ev.set) Object.assign(o, ev.set);
    }
    // signer freezes apply by identity, not by id
    for (const ev of this.stateEvents()) {
      if (ev.freeze_identity) {
        for (const o of byId.values()) {
          if (o.producer?.identity === ev.freeze_identity) {
            o.signer_state = 'former';
            if (o.state === 'live') o.state = 'frozen';
          }
        }
      }
    }
    return [...byId.values()];
  }

  get(id) { return this.all().find((o) => o.id === id) ?? null; }

  // ——— scope computation (D7 / D11) ———
  computeScope(output) {
    const usedHarness = (output.sources ?? []).some((s) => s.harness === true);
    if (usedHarness) {
      // No upstream ledger entry to intersect with, so an intersection would be
      // unbounded rather than narrow. Floor it at the producing fleet.
      return { scope: fleetScope(output.producer.fleet), basis: 'harness-source (D11)' };
    }

    if ((output.derived_from ?? []).length) {
      const parents = output.derived_from.map((id) => this.get(id));
      const missing = output.derived_from.filter((id, i) => !parents[i]);
      if (missing.length) return { scope: NOBODY, basis: `unknown input(s): ${missing.join(', ')}` };
      const scopes = parents.map((p) => p.scope);
      return {
        scope: intersectAll(scopes),
        basis: `intersection of ${scopes.length} input(s); narrowest was ${describe(narrowest(scopes))}`,
      };
    }

    // A root output. Only an onboarded enterprise agent may carry a reviewed scope (D5/D6).
    if (this.resolvers.isEnterpriseAgent(output.producer.agent)) {
      const declared = this.resolvers.declaredScopeOf(output.producer.agent);
      if (!declared) return { scope: NOBODY, basis: 'enterprise agent has no reviewed scope in the registry' };
      return { scope: declared, basis: 'reviewed scope from the agent manifest' };
    }

    return { scope: fleetScope(output.producer.fleet), basis: 'fleet agent root output defaults fleet-private' };
  }

  publish(candidate) {
    const errs = validate(candidate);
    if (errs.length) return { ok: false, errors: errs };
    if (this.get(candidate.id)) return { ok: false, errors: [`output ${candidate.id} already published`] };

    const declaredByProducer = candidate.scope ?? null;
    const { scope, basis } = this.computeScope(candidate);

    const record = {
      ...candidate,
      scope,
      scope_basis: basis,
      // Kept for audit: the producer asked for something and the ledger overruled it.
      scope_declared_by_producer: declaredByProducer,
      published_at: new Date().toISOString(),
      state: 'live',
    };
    appendLine(this.path, record);

    if (candidate.supersedes) this.#supersede(candidate.supersedes, candidate.id);
    return { ok: true, output: this.get(candidate.id), scope_basis: basis };
  }

  // A producer asking to widen its own output. Always refused (D7).
  attemptWiden(outputId, wider) {
    const o = this.get(outputId);
    if (!o) return { ok: false, reason: 'no such output' };
    return {
      ok: false,
      reason: 'scope is computed from inputs and cannot be widened by the producer (D7)',
      current: o.scope,
      requested: wider,
      route_to: narrowest(o.derived_from.map((id) => this.get(id)?.scope).filter(Boolean)) ?? o.scope,
    };
  }

  #markStale(ids, reason) {
    for (const id of ids) appendLine(this.overlayPath, { id, set: { state: 'stale', stale_reason: reason } });
  }

  #supersede(oldId, newId) {
    appendLine(this.overlayPath, { id: oldId, set: { state: 'stale', stale_reason: `superseded by ${newId}` } });
    const kids = descendants(this.all(), oldId).filter((id) => id !== newId);
    this.#markStale(kids, `upstream ${oldId} was superseded by ${newId}`);
    return kids;
  }

  // Correcting an output: publish the correction, invalidate everything downstream.
  correct(oldId, corrected) {
    const res = this.publish({ ...corrected, supersedes: oldId });
    if (!res.ok) return res;
    return { ...res, invalidated: descendants(this.all(), oldId).filter((id) => id !== corrected.id) };
  }

  // D15: honour a deletion request without breaking provenance.
  tombstone(id, reason) {
    const o = this.get(id);
    if (!o) return { ok: false, reason: 'no such output' };
    appendLine(this.overlayPath, {
      id,
      set: { state: 'tombstoned', body: {}, tombstone_reason: reason, tombstoned_at: new Date().toISOString() },
    });
    const kids = descendants(this.all(), id);
    this.#markStale(kids, `upstream ${id} was tombstoned`);
    return { ok: true, tombstoned: id, cascaded: kids };
  }

  // D16: employee leaves. Outputs survive, frozen, signer marked former.
  freezeSigner(identity, reason = 'signer is a former employee') {
    appendLine(this.overlayPath, { freeze_identity: identity, id: `__freeze__${identity}`, reason });
    return { ok: true, frozen: this.all().filter((o) => o.producer?.identity === identity).map((o) => o.id) };
  }

  setStatus(id, status, evidence) {
    appendLine(this.overlayPath, { id, set: { status, status_evidence: evidence ?? null } });
    return this.get(id);
  }

  freshnessOf(id) { const o = this.get(id); return o ? freshness(o) : null; }
  ancestryOf(id) { return ancestry(this.all(), id); }
  descendantsOf(id) { return descendants(this.all(), id); }
  conflicts() { return conflicts(this.all()); }

  visible(employeeId) {
    return this.all().filter((o) => visibleTo(o.scope, employeeId, this.resolvers.fleetOwner));
  }
}
