// The fleet roster. An employee initiates registration and needs nobody's
// permission to do it (D2) — but the roster itself is stored on the PLATFORM
// side, because granting invoke to "a named agent inside a named fleet" (D4)
// requires the platform to be able to address that agent.
//
// This is the single exception to the workspace split: the roster is shared,
// everything else about a fleet stays in the employee's own workspace.
import { readDoc, writeDoc } from '../brain/store.mjs';

export class FleetRoster {
  constructor(path, identity) { this.path = path; this.identity = identity; }

  load() { return readDoc(this.path, { fleets: {} }); }
  save(db) { writeDoc(this.path, db); }

  // No approval gate: creating a fleet needs nobody's permission (D2).
  register({ fleet, owner, agents = [] }) {
    if (!fleet || !owner) return { ok: false, errors: ['fleet and owner are required'] };
    const who = this.identity.resolve(owner);
    if (who.status !== 'active') return { ok: false, errors: [`owner ${owner} is not an active employee`] };

    const db = this.load();
    if (db.fleets[fleet] && db.fleets[fleet].owner !== owner) {
      return { ok: false, errors: [`fleet id ${fleet} already belongs to someone else`] };
    }
    db.fleets[fleet] = {
      fleet,
      owner,
      harness: 'claude',            // D12 - the sanctioned harness, for now
      state: db.fleets[fleet]?.state ?? 'active',
      agents: agents.map((a) => ({ id: a.id, purpose: a.purpose ?? null })),
      registered_at: db.fleets[fleet]?.registered_at ?? new Date().toISOString(),
    };
    this.save(db);
    return { ok: true, fleet: db.fleets[fleet] };
  }

  addAgent(fleet, agent) {
    const db = this.load();
    const f = db.fleets[fleet];
    if (!f) return { ok: false, errors: ['no such fleet'] };
    if (f.agents.some((a) => a.id === agent.id)) return { ok: false, errors: [`agent ${agent.id} already registered`] };
    f.agents.push({ id: agent.id, purpose: agent.purpose ?? null });
    this.save(db);
    return { ok: true, fleet: f };
  }

  get(fleet) { return this.load().fleets[fleet] ?? null; }
  all() { return Object.values(this.load().fleets); }

  owner(fleet) { return this.get(fleet)?.owner ?? null; }

  hasAgent(fleet, agent) {
    return Boolean(this.get(fleet)?.agents.some((a) => a.id === agent));
  }

  // D16: the employee leaves. The fleet is archived; their outputs are frozen
  // separately by the ledger, and their access simply stops resolving.
  archive(fleet, reason) {
    const db = this.load();
    const f = db.fleets[fleet];
    if (!f) return { ok: false, errors: ['no such fleet'] };
    f.state = 'archived';
    f.archived_at = new Date().toISOString();
    f.archive_reason = reason ?? null;
    this.save(db);
    return { ok: true, fleet: f };
  }
}
