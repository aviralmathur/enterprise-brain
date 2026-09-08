// Component 18. Telemetry drives deprecation on evidence rather than opinion.
// Stripe's lesson: with a large library and no signal, quality decay is invisible.
export class Telemetry {
  constructor(audit, registry, ledger = null) {
    this.audit = audit;
    this.registry = registry;
    this.ledger = ledger;
  }

  // An audit row names its target, which is an AGENT for an invoke but an OUTPUT
  // for a consume. Attributing usage to an agent means resolving the output back
  // to its producer — without this, every agent looks unused and the deprecation
  // sweep would retire the whole registry.
  agentFor(event) {
    if (event.action === 'invoke') return event.target;
    if (event.action !== 'consume') return null;
    if (typeof event.target !== 'string' || event.target.startsWith('query:')) return null;
    return this.ledger?.get(event.target)?.producer?.agent ?? null;
  }

  // How often each enterprise agent was actually consumed or invoked.
  agentUsage({ sinceMs = 30 * 24 * 3600 * 1000 } = {}) {
    const cutoff = Date.now() - sinceMs;
    const counts = new Map();
    for (const e of this.audit.all()) {
      if (Date.parse(e.at) < cutoff) continue;
      if (e.outcome !== 'allowed') continue;
      const agent = this.agentFor(e);
      if (!agent) continue;
      counts.set(agent, (counts.get(agent) ?? 0) + 1);
    }
    return counts;
  }

  // An agent nobody has used is a maintenance liability and a standing access list.
  deprecationCandidates(opts) {
    const usage = this.agentUsage(opts);
    return this.registry
      .all()
      .filter((a) => a.lifecycle === 'published')
      .map((a) => ({ agent: a.id, dri: a.dri, uses: usage.get(a.id) ?? 0 }))
      .filter((row) => row.uses === 0);
  }

  refusalHotspots() {
    const counts = new Map();
    for (const e of this.audit.refusals()) {
      counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }
}
