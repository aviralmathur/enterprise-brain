// Tool selection at fleet-creation time, and the descriptor the fleet builder
// installs so their harness can connect.
//
// We do NOT implement MCP. The person building the fleet installs whatever their
// harness provides. Our job is two things:
//   1. ask which tools they want, and sort them into what they already have
//      versus what needs the platform team's say-so
//   2. emit a descriptor their harness can be pointed at
import { readDoc, writeDoc } from '../brain/store.mjs';

// Two classes of tool, and the difference is the whole governance model.
export const TOOL_CLASS = {
  // Provisioned to the employee's own harness by IT. Authenticates AS the employee,
  // so it grants no new privilege and needs no permission from us (D3).
  harness: 'harness',
  // An enterprise agent. Consume needs an access list; invoke needs a grant (D4).
  enterprise: 'enterprise',
};

export class FleetTools {
  constructor(ws, { registry, grants, fleetRoster }) {
    this.ws = ws;
    this.registry = registry;
    this.grants = grants;
    this.fleetRoster = fleetRoster;
  }

  load() { return readDoc(this.ws.tools, { fleet: null, requested: [], decided_at: null }); }

  // The question asked when a fleet is created: which tools do you want?
  // `requested` is a list of { name, class } — harness tools are named freely,
  // enterprise tools must name a registered agent.
  choose(fleet, requested) {
    const resolved = requested.map((t) => {
      if (t.class === TOOL_CLASS.harness) {
        return {
          ...t,
          available: true,
          why: 'a tool your harness already gives you; it authenticates as you, so it needs no grant',
          needs: null,
        };
      }
      const agent = this.registry.get(t.name);
      if (!agent) {
        return { ...t, available: false, why: `no enterprise agent named "${t.name}" is registered`, needs: null };
      }
      const list = this.registry.accessList(t.name);
      const owner = this.fleetRoster.owner(fleet);
      const onList = list === 'org' || (Array.isArray(list) && list.includes(owner));

      if (!onList) {
        return {
          ...t, available: false,
          why: `${owner} is not on the access list for ${t.name}`,
          needs: 'access — ask the platform team to add you to this agent',
        };
      }
      if (!t.invoke) {
        return { ...t, available: true, why: 'consume is open to everyone on the access list', needs: null };
      }
      if (!this.registry.isInvocable(t.name)) {
        return { ...t, available: false, why: `${t.name} is not invocable`, needs: null };
      }
      return {
        ...t, available: false,
        why: 'invoke is never default (D4)',
        needs: 'grant — raise a grant request from your Mission Control board',
      };
    });

    const doc = { fleet, requested: resolved, decided_at: new Date().toISOString() };
    writeDoc(this.ws.tools, doc);
    return doc;
  }

  // Everything the fleet can use right now, with nothing pending.
  availableNow() { return this.load().requested.filter((t) => t.available); }

  // Everything that needs the platform team. This is the list the fleet builder
  // turns into grant requests.
  pending() { return this.load().requested.filter((t) => !t.available && t.needs); }

  // The descriptor the fleet builder points their harness at. Deliberately not an
  // MCP server config: it names the endpoints and identifiers, and the harness
  // owner installs whatever transport their harness provides.
  connectionDescriptor({ fleet, ledger_url, gateway_url, platform_board_url }) {
    const roster = this.fleetRoster.get(fleet);
    if (!roster) return { ok: false, errors: ['fleet is not registered'] };

    const doc = {
      fleet,
      owner: roster.owner,
      harness: roster.harness,
      agents: roster.agents.map((a) => a.id),
      endpoints: {
        // Read path. Cheap, direct, no gateway.
        ledger: ledger_url ?? null,
        // The only write path up, and the only authoritative check (D13).
        gateway: gateway_url ?? null,
        // Mission Control for the platform team — a URL away (or linked directly).
        platform_board: platform_board_url ?? null,
      },
      // The fleet token is NOT written here. It is a bearer credential: it goes in
      // an environment variable, so this file stays safe to read, copy and inspect.
      auth: {
        scheme: 'bearer',
        token_env: 'ENTERPRISE_BRAIN_TOKEN',
        note: 'the token carries the employee AND the fleet — the host reads identity from it, never from a request',
      },
      tools: {
        available: this.availableNow().map((t) => ({ name: t.name, class: t.class, invoke: Boolean(t.invoke) })),
        pending: this.pending().map((t) => ({ name: t.name, needs: t.needs })),
      },
      notes: [
        'Install the transport your harness provides and point it at these endpoints.',
        'Consume is filtered by your own entitlements — two people running the same fleet see different answers.',
        'The gateway re-checks every call. A local check being disabled changes nothing.',
      ],
      issued_at: new Date().toISOString(),
    };
    writeDoc(this.ws.connection, doc);
    return { ok: true, descriptor: doc, path: this.ws.connection };
  }
}
