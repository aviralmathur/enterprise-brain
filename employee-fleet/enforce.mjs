// The local enforcement point. D13: ADVISORY ONLY.
//
// It mirrors the gateway's rule so an employee's agent fails fast and legibly on
// an honest mistake. It is worthless against intent, because the person it
// constrains can switch it off - which is exactly what `enabled: false` models
// here. Nothing downstream may rely on it having run.
export class LocalEnforcement {
  constructor({ registry, grants, fleets, enabled = true }) {
    this.registry = registry;
    this.grants = grants;
    this.fleets = fleets;
    this.enabled = enabled;
  }

  // Returns { allow, reason, advisory: true }. A false here should stop a
  // well-behaved agent early; a bypassed client just gets refused at the gateway.
  check({ employee, via, target }) {
    if (!this.enabled) {
      return { allow: true, advisory: true, reason: 'local enforcement disabled - the gateway is still authoritative' };
    }
    if (!this.fleets.hasAgent(via?.fleet, via?.agent)) {
      return { allow: false, advisory: true, reason: `agent ${via?.agent} is not registered in fleet ${via?.fleet}` };
    }
    if (!this.registry.isInvocable(target)) {
      return { allow: false, advisory: true, reason: `${target} is not invocable` };
    }
    const list = this.registry.accessList(target);
    const onList = list === 'org' || (Array.isArray(list) && list.includes(employee));
    if (!onList) {
      return { allow: false, advisory: true, reason: `${employee} is not on the access list for ${target}` };
    }
    if (!this.grants.find({ employee, via, agent: target })) {
      return { allow: false, advisory: true, reason: `no live grant for ${via.fleet}/${via.agent} on ${target} - request one` };
    }
    return { allow: true, advisory: true, reason: 'looks permitted; the gateway decides' };
  }
}
