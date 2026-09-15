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

// A fleet scope is the SINGLETON audience { ownerOf(fleet) }. So intersecting it
// with any other scope is just: does that scope contain the fleet owner? If it
// does, the fleet scope survives; if it does not, the audience is empty. The old
// code returned the fleet scope unconditionally, which *added* a viewer whenever a
// fleet met a list that did not contain its owner (B3).
//
// `ownerOf` resolves a fleet id to its owning employee. Without it, a fleet meeting
// a named list cannot be checked, so we fail CLOSED (NOBODY) rather than widen.
export function intersect(a, b, { ownerOf } = {}) {
  if (!a) return b;
  if (!b) return a;

  // fleet is the floor of the lattice
  if (a.type === 'fleet' && b.type === 'fleet') {
    return a.fleet === b.fleet ? fleetScope(a.fleet) : NOBODY;
  }
  // A fleet against org: the owner is in org, so the fleet (the narrower) survives.
  // A fleet against a list: the fleet survives only if its owner is on the list.
  if (a.type === 'fleet') return fleetMeets(a, b, ownerOf);
  if (b.type === 'fleet') return fleetMeets(b, a, ownerOf);

  if (a.type === 'org' && b.type === 'org') return ORG;
  if (a.type === 'org') return listScope(b.members);
  if (b.type === 'org') return listScope(a.members);

  const bm = new Set(b.members);
  return listScope(a.members.filter((m) => bm.has(m)));
}

// A fleet scope met with `other`. `other` is never a fleet here (that case is
// handled above). org → the fleet survives; list → the fleet survives iff the
// owner is a member; unknown owner → fail closed.
function fleetMeets(fleet, other, ownerOf) {
  if (other.type === 'org') return fleetScope(fleet.fleet);
  // other.type === 'list'
  const owner = ownerOf ? ownerOf(fleet.fleet) : null;
  if (owner && other.members.includes(owner)) return fleetScope(fleet.fleet);
  return NOBODY;
}

export function intersectAll(scopes, opts = {}) {
  if (!scopes.length) return null;
  return scopes.reduce((acc, s) => intersect(acc, s, opts), null);
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
