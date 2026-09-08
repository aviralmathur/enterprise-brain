// The derived_from graph, and the cascade that makes this a brain rather than a wiki.

export function buildGraph(outputs) {
  const children = new Map(); // parent id -> [child ids]
  const byId = new Map();
  for (const o of outputs) {
    byId.set(o.id, o);
    for (const p of o.derived_from) {
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(o.id);
    }
  }
  return { children, byId };
}

// Everything transitively derived from `rootId`.
export function descendants(outputs, rootId) {
  const { children } = buildGraph(outputs);
  const seen = new Set();
  const queue = [...(children.get(rootId) ?? [])];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  return [...seen];
}

// The chain upward, for citing provenance in an answer.
export function ancestry(outputs, id, depth = Infinity) {
  const { byId } = buildGraph(outputs);
  const out = [];
  const walk = (curId, d) => {
    const node = byId.get(curId);
    if (!node || d > depth) return;
    for (const p of node.derived_from) {
      const parent = byId.get(p);
      if (parent) { out.push({ id: p, kind: parent.kind, producer: parent.producer, depth: d }); walk(p, d + 1); }
    }
  };
  walk(id, 1);
  return out;
}

// Two live outputs of the same kind that disagree. The brain surfaces these; it never picks.
export function conflicts(outputs) {
  const groups = new Map();
  for (const o of outputs) {
    if (o.state !== 'live') continue;
    const key = `${o.kind}::${o.body?.subject ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  const found = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const values = new Set(group.map((g) => JSON.stringify(g.body?.value ?? null)));
    if (values.size > 1) found.push({ key, outputs: group.map((g) => g.id) });
  }
  return found;
}
