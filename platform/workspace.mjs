// Storage ownership. Two kinds of workspace, and the split is a privacy boundary,
// not a convenience:
//
//   PLATFORM workspace  — owned by the platform team. Holds the shared ledger, the
//                         agent registry, grants, the platform board and the audit
//                         trail. Employees never write here except through a gate.
//
//   EMPLOYEE workspace  — owned by one employee, inside their own workspace. Holds
//                         their fleet board, their tool declarations and their harness
//                         connection descriptor. D10: the platform team cannot read it.
//
// One thing deliberately lives on the PLATFORM side even though it describes a
// fleet: the fleet roster (ids, owner, agent ids). Granting invoke to "a named
// agent inside a named fleet" (D4) requires the platform to be able to address
// that agent, so the roster is shared while everything else about the fleet is not.
import { join } from 'node:path';
import { homedir } from 'node:os';

export function platformWorkspace(root = join(homedir(), '.enterprise-brain', 'platform')) {
  return {
    kind: 'platform',
    root,
    ledger: join(root, 'ledger.jsonl'),
    audit: join(root, 'audit.jsonl'),
    registry: join(root, 'registry.json'),
    grants: join(root, 'grants.json'),
    board: join(root, 'platform-board.json'),
    fleetRoster: join(root, 'fleet-roster.json'),
    idp: join(root, 'idp', 'directory.json'),
    tokens: join(root, 'tokens.json'),
  };
}

// One employee, one workspace. Two employees never share a file.
export function employeeWorkspace(employee, root = join(homedir(), '.enterprise-brain', 'workspaces')) {
  const mine = join(root, employee);
  return {
    kind: 'employee',
    employee,
    root: mine,
    board: join(mine, 'fleet-board.json'),
    tools: join(mine, 'tools.json'),
    connection: join(mine, 'connection.json'),
  };
}

// What each side is allowed to touch. Used by the acceptance suite to prove the
// boundary rather than assert it.
export const OWNERSHIP = {
  platform: ['ledger', 'audit', 'registry', 'grants', 'board', 'fleetRoster', 'idp', 'tokens'],
  employee: ['board', 'tools', 'connection'],
};
