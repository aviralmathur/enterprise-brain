// The scope lattice, from most restrictive to least:
//   { type: 'fleet', fleet }        one employee's private fleet
//   { type: 'list',  members: [] }  a named set of employees
//   { type: 'org' }                 everyone
//
// D7: a derived output's scope is the INTERSECTION of its inputs' scopes,
// computed here and never declared by the producer.

export const ORG = { type: 'org' };
export const NOBODY = { type: 'list', members: [] };

export const fleetScope = (fleet) => ({ type: 'fleet', fleet });
export const listScope = (members) => ({ type: 'list', members: [...new Set(members)].sort() });

export function intersect(a, b) {
  if (!a) return b;
  if (!b) return a;

  // fleet is the floor of the lattice
  if (a.type === 'fleet' && b.type === 'fleet') {
    return a.fleet === b.fleet ? fleetScope(a.fleet) : NOBODY;
  }
  if (a.type === 'fleet') return a;
  if (b.type === 'fleet') return b;

  if (a.type === 'org' && b.type === 'org') return ORG;
  if (a.type === 'org') return listScope(b.members);
  if (b.type === 'org') return listScope(a.members);

  const bm = new Set(b.members);
  return listScope(a.members.filter((m) => bm.has(m)));
}

export function intersectAll(scopes) {
  if (!scopes.length) return null;
  return scopes.reduce((acc, s) => intersect(acc, s), null);
}

// Ordering used only for reporting which input was the narrowest.
export function restrictiveness(s) {
  if (s.type === 'fleet') return 0;
  if (s.type === 'list') return 1 + s.members.length / 1e6;
  return 2;
}

export function narrowest(scopes) {
  return [...scopes].sort((x, y) => restrictiveness(x) - restrictiveness(y))[0] ?? null;
}

export function describe(s) {
  if (!s) return 'unset';
  if (s.type === 'org') return 'org-wide';
  if (s.type === 'fleet') return `fleet-private (${s.fleet})`;
  return s.members.length ? `${s.members.length} named: ${s.members.join(', ')}` : 'nobody';
}

// Is this scope visible to an employee? `fleetOwner` resolves a fleet id to its owner.
export function visibleTo(scope, employeeId, fleetOwner = () => null) {
  if (!scope) return false;
  if (scope.type === 'org') return true;
  if (scope.type === 'list') return scope.members.includes(employeeId);
  if (scope.type === 'fleet') return fleetOwner(scope.fleet) === employeeId;
  return false;
}
