// Assembly. Two builders, because there are two workspaces with two owners.
//
//   buildPlatform() — everything the platform team owns and stores
//   buildFleet()    — one employee's fleet, stored in that employee's own workspace
//
// A fleet is handed the platform's *interfaces*, never its storage paths. The only
// things it can write on the platform side are an output through the approve gate
// and a grant request through the link.
import { rmSync, existsSync } from 'node:fs';

import { Ledger } from './brain/ledger.mjs';
import { Audit } from './brain/audit.mjs';
import { Query } from './brain/query.mjs';
import { createLocalProvider } from './brain/identity.mjs';
import { Telemetry } from './brain/telemetry.mjs';
import { QualityGates } from './brain/gates.mjs';
import { writeDoc } from './brain/store.mjs';

import { Registry } from './platform-fleet/registry.mjs';
import { FleetRoster } from './platform-fleet/fleet-roster.mjs';
import { Grants } from './platform-fleet/grants.mjs';
import { Gateway } from './platform-fleet/gateway.mjs';
import { PlatformBoard } from './platform-fleet/board.mjs';
import { createPlatformBoardHandler, fetchAgainst } from './platform-fleet/handler.mjs';
import { createLocalTokenResolver } from './platform-fleet/tokens.mjs';
import { createHost } from './platform-fleet/host.mjs';
import { all as connectors } from './platform-fleet/connectors/index.mjs';

import { LocalEnforcement } from './employee-fleet/enforce.mjs';
import { FleetBoard } from './employee-fleet/board.mjs';
import { FleetTools } from './employee-fleet/tools.mjs';
import { DirectPlatformLink, UrlPlatformLink } from './employee-fleet/platform-link.mjs';

import { platformWorkspace, employeeWorkspace } from './workspace.mjs';

export function buildPlatform({ ws, fresh = false, idp = null, workspaceRoot = null, devTokens = false } = {}) {
  const paths = ws ?? platformWorkspace();
  if (fresh && existsSync(paths.root)) rmSync(paths.root, { recursive: true, force: true });

  // The IdP sits outside the brain. It is re-read on every resolve; nothing is copied in.
  if (idp) writeDoc(paths.idp, idp);
  const identity = createLocalProvider(paths.idp);

  const audit = new Audit(paths.audit);
  const registry = new Registry(paths.registry);
  const fleetRoster = new FleetRoster(paths.fleetRoster, identity);

  const ledger = new Ledger(paths.ledger, {
    declaredScopeOf: (agentId) => registry.declaredScopeOf(agentId),
    isEnterpriseAgent: (agentId) => registry.isEnterpriseAgent(agentId),
    fleetOwner: (fleetId) => fleetRoster.owner(fleetId),
  });

  const grants = new Grants(paths.grants, audit);
  const board = new PlatformBoard(paths.board, audit);

  const query = new Query(ledger, {
    identity,
    audit,
    resolvers: {
      accessList: (agentId) => registry.accessList(agentId),
      fleetOwner: (fleetId) => fleetRoster.owner(fleetId),
      isEnterpriseAgent: (agentId) => registry.isEnterpriseAgent(agentId),
    },
  });

  const gateway = new Gateway({ registry, grants, ledger, identity, audit, connectors });
  const telemetry = new Telemetry(audit, registry, ledger);
  const gates = new QualityGates(ledger);

  // What a platform team mounts on the server they already run, so fleets can
  // reach the board over a URL.
  const boardHandler = createPlatformBoardHandler(board);

  // How a request over the wire becomes a principal. Third seam.
  const tokens = createLocalTokenResolver(paths.tokens);

  const platform = {
    kind: 'platform',
    paths, identity, audit, ledger, query, registry, fleetRoster,
    grants, gateway, board, telemetry, gates, connectors, boardHandler, tokens,
  };

  // One employee's own side of the world, on demand and cached. The host needs
  // this to answer a fleet's own routes, and it is the only reason the platform
  // side knows an employee workspace root at all: it hands out a fleet's
  // interfaces, never its storage.
  const fleetCache = new Map();
  platform.workspaceRoot = workspaceRoot;
  platform.fleetFor = (employee, fleetId) => {
    const key = employee + '|' + fleetId;
    if (!fleetCache.has(key)) {
      fleetCache.set(key, buildFleet({ platform, employee, fleet: fleetId, workspaceRoot }));
    }
    return fleetCache.get(key);
  };

  // The host serves the three endpoints a connection descriptor names, plus the
  // two boards and the API behind them. Built here but not listening - call
  // host.listen(port) to serve, or host.handle(req) to exercise every route
  // without a socket.
  platform.host = createHost({ platform, tokens, devTokens });
  return platform;
}

// One employee's fleet, in that employee's own workspace.
// `link` is 'direct' (same process) or the platform board's URL.
export function buildFleet({ platform, employee, fleet, ws, workspaceRoot, link = 'direct', fresh = false } = {}) {
  const paths = ws ?? employeeWorkspace(employee, workspaceRoot);
  if (fresh && existsSync(paths.root)) rmSync(paths.root, { recursive: true, force: true });

  const platformLink = link === 'direct'
    ? new DirectPlatformLink(platform.board)
    // A real deployment passes a URL. fetchAgainst() lets a single-machine run
    // exercise the same code path without standing up a server.
    : new UrlPlatformLink(link, {
      fetchImpl: platform.boardHandler ? fetchAgainst(platform.boardHandler) : undefined,
    });

  const board = new FleetBoard(paths.board, {
    fleet, owner: employee, ledger: platform.ledger, platformLink,
    // The board's lanes are the fleet's registered agents, so a lane and an
    // addressable agent cannot drift apart.
    roster: platform.fleetRoster,
  });

  const tools = new FleetTools(paths, {
    registry: platform.registry,
    grants: platform.grants,
    fleetRoster: platform.fleetRoster,
  });

  const enforcement = (opts = {}) => new LocalEnforcement({
    registry: platform.registry,
    grants: platform.grants,
    fleets: platform.fleetRoster,
    ...opts,
  });

  return { kind: 'fleet', employee, fleet, paths, board, tools, platformLink, enforcement };
}

// Single-machine composition used by the demo and the acceptance suite.
export function build({ root = 'data', fresh = false, idp = null, devTokens = false } = {}) {
  // `fresh` has to clear the WHOLE root, not just the platform side. Clearing
  // only the platform workspace leaves every employee's board behind, and the
  // next run reads work that a previous one wrote: a check that passes on a
  // clean machine and drifts on a used one.
  if (fresh && existsSync(root)) rmSync(root, { recursive: true, force: true });

  const platform = buildPlatform({
    ws: platformWorkspace(`${root}/platform`),
    idp,
    workspaceRoot: `${root}/workspaces`,
    devTokens,
  });
  return {
    ...platform,
    // Readability at call sites; the roster lives on the platform side.
    fleets: platform.fleetRoster,
    workspaceRoot: `${root}/workspaces`,
    // Deliberately NOT passing `fresh` down: the root was already cleared
    // above, and a factory that wipes on every call would destroy an
    // employee's board the second time anybody asked for their fleet.
    fleet: (employee, fleetId, opts = {}) => buildFleet({
      platform, employee, fleet: fleetId,
      workspaceRoot: `${root}/workspaces`, ...opts,
    }),
  };
}
