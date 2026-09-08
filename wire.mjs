// Assembly. The only file that knows about every part, kept deliberately small
// so the dependency direction is visible: employee fleet and platform fleet both
// depend on the brain; the brain depends on neither (D12).
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

import { Ledger } from './brain/ledger.mjs';
import { Audit } from './brain/audit.mjs';
import { Query } from './brain/query.mjs';
import { createLocalProvider } from './brain/identity.mjs';
import { Telemetry } from './brain/telemetry.mjs';
import { QualityGates } from './brain/gates.mjs';

import { Registry } from './platform-fleet/registry.mjs';
import { Grants } from './platform-fleet/grants.mjs';
import { Gateway } from './platform-fleet/gateway.mjs';
import { PlatformBoard } from './platform-fleet/board.mjs';
import { all as connectors } from './platform-fleet/connectors/index.mjs';

import { Fleets } from './employee-fleet/fleet.mjs';
import { LocalEnforcement } from './employee-fleet/enforce.mjs';
import { FleetBoard } from './employee-fleet/board.mjs';

import { writeDoc } from './brain/store.mjs';

export function build({ root = 'data', fresh = false, idp = null } = {}) {
  const p = (name) => join(root, name);

  if (fresh && existsSync(root)) rmSync(root, { recursive: true, force: true });

  // The IdP is conceptually OUTSIDE the brain. It lives in its own file and the
  // brain re-reads it on every resolve - it never copies entitlements in.
  const idpPath = p('idp/directory.json');
  if (idp) writeDoc(idpPath, idp);
  const identity = createLocalProvider(idpPath);

  const audit = new Audit(p('audit.jsonl'));
  const registry = new Registry(p('registry.json'));
  const fleets = new Fleets(p('fleets.json'), identity);

  const ledger = new Ledger(p('ledger.jsonl'), {
    declaredScopeOf: (agentId) => registry.declaredScopeOf(agentId),
    isEnterpriseAgent: (agentId) => registry.isEnterpriseAgent(agentId),
    fleetOwner: (fleetId) => fleets.owner(fleetId),
  });

  const grants = new Grants(p('grants.json'), audit);
  const platformBoard = new PlatformBoard(p('platform-board.json'), audit);

  const query = new Query(ledger, {
    identity,
    audit,
    resolvers: {
      accessList: (agentId) => registry.accessList(agentId),
      fleetOwner: (fleetId) => fleets.owner(fleetId),
      isEnterpriseAgent: (agentId) => registry.isEnterpriseAgent(agentId),
    },
  });

  const gateway = new Gateway({ registry, grants, ledger, identity, audit, connectors });
  const telemetry = new Telemetry(audit, registry, ledger);
  const gates = new QualityGates(ledger);

  // Each employee fleet gets its own board file. Two fleets never share one.
  const fleetBoard = (fleet, owner) =>
    new FleetBoard(p(`fleet-boards/${fleet}.json`), { fleet, owner, ledger, platformBoard });

  const enforcement = (opts = {}) => new LocalEnforcement({ registry, grants, fleets, ...opts });

  return {
    paths: { root, idpPath, ledger: p('ledger.jsonl'), audit: p('audit.jsonl') },
    identity, audit, ledger, query, registry, grants, gateway, platformBoard,
    fleets, telemetry, gates, fleetBoard, enforcement, connectors,
  };
}
