// The host. Serves the three endpoints a connection descriptor names, so a fleet's
// harness has something to actually connect to.
//
// The rule this file exists to enforce (D13): the host is the authoritative check,
// and it trusts NOTHING from the request about who is calling.
//
//   - the employee comes from the token, never from the body
//   - the fleet comes from the token, never from the body
//   - only the agent id comes from the request, and it is verified against the roster
//
// A client that sends { employee: 'someone-else' } is simply acting as itself. That
// is not an error to report back helpfully; it is a field we do not read.
import { createServer } from 'node:http';
import { createPlatformBoardHandler } from './handler.mjs';
import { newOutput } from '../brain/schema.mjs';
import { describe } from '../brain/scope.mjs';
import { freshness } from '../brain/schema.mjs';

const json = (status, body) => ({ status, body });

export function createHost({ platform, tokens, logger = () => {} }) {
  const boardHandler = createPlatformBoardHandler(platform.board);

  // ——— who is calling ———
  function authenticate(headers = {}) {
    const raw = headers.authorization ?? headers.Authorization ?? '';
    const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : null;
    if (!token) return { ok: false, status: 401, reason: 'missing bearer token' };

    const principal = tokens.resolve(token);
    if (!principal) return { ok: false, status: 401, reason: 'unknown or expired token' };

    // A token is only as live as the employee behind it. Offboarding takes effect
    // here with no cleanup job, because entitlements resolve against the IdP.
    const who = platform.identity.resolve(principal.employee);
    if (who.status !== 'active') {
      return { ok: false, status: 403, reason: `employee ${principal.employee} is not active` };
    }
    return { ok: true, principal };
  }

  // The agent is the one thing the caller names. Verify it, or a fleet could
  // borrow another agent's grant by claiming its id.
  function resolveVia(principal, body = {}) {
    const agent = body?.via?.agent ?? body?.agent ?? null;
    if (!agent) return { ok: false, status: 400, reason: 'via.agent is required' };

    const roster = platform.fleetRoster.get(principal.fleet);
    if (!roster) return { ok: false, status: 403, reason: `fleet ${principal.fleet} is not registered` };
    if (roster.state !== 'active') return { ok: false, status: 403, reason: `fleet ${principal.fleet} is ${roster.state}` };
    if (roster.owner !== principal.employee) {
      // Should be impossible via a minted token, but the host does not assume that.
      return { ok: false, status: 403, reason: 'token fleet does not belong to token employee' };
    }
    if (!platform.fleetRoster.hasAgent(principal.fleet, agent)) {
      return { ok: false, status: 403, reason: `agent ${agent} is not registered in ${principal.fleet}` };
    }
    return { ok: true, via: { fleet: principal.fleet, agent } };
  }

  async function route({ method, path, query = {}, headers = {}, body = null }) {
    const parts = path.replace(/^\/+|\/+$/g, '').split('/');

    if (method === 'GET' && parts[0] === 'health') {
      return json(200, { ok: true, service: 'enterprise-brain', endpoints: ['/ledger', '/gateway', '/board'] });
    }

    const auth = authenticate(headers);
    if (!auth.ok) {
      platform.audit.record({ action: 'auth', employee: null, target: path, outcome: 'refused', reason: auth.reason });
      return json(auth.status, { ok: false, reason: auth.reason });
    }
    const { principal } = auth;

    // ——— /ledger : the read path. Cheap, direct, no gateway. ———
    if (parts[0] === 'ledger') {
      if (method === 'GET' && parts[1] === 'ask') {
        const via = resolveVia(principal, { agent: query.agent });
        if (!via.ok) return json(via.status, { ok: false, reason: via.reason });
        const res = platform.query.ask(
          principal.employee,
          { kind: query.kind, subject: query.subject },
          via.via,
        );
        return json(200, res);
      }

      if (method === 'GET' && parts[1] === 'outputs' && parts[2]) {
        const via = resolveVia(principal, { agent: query.agent });
        if (!via.ok) return json(via.status, { ok: false, reason: via.reason });
        const res = platform.query.read(principal.employee, parts[2], via.via);
        // A refusal is a 403 with the reason, not a 404 — the reader is told why,
        // because "ask the platform team for access" is the actionable next step.
        return json(res.ok ? 200 : 403, res);
      }

      // The publish path. The gate is that the signer IS the caller: an employee's
      // approve on their own board is what produces this request, and the token
      // proves who signed it. The ledger still computes the scope (D7).
      if (method === 'POST' && parts[1] === 'outputs') {
        const via = resolveVia(principal, body);
        if (!via.ok) return json(via.status, { ok: false, reason: via.reason });
        if (!body?.candidate) return json(400, { ok: false, reason: 'candidate is required' });

        const res = platform.ledger.publish(newOutput({
          ...body.candidate,
          // Forced, not accepted. A caller cannot sign as anyone else.
          producer: { fleet: via.via.fleet, agent: via.via.agent, identity: principal.employee },
        }));
        if (!res.ok) return json(400, res);

        platform.audit.record({
          action: 'publish', employee: principal.employee, via: via.via,
          target: res.output.id, outcome: 'allowed',
          detail: { scope: describe(res.output.scope), basis: res.scope_basis },
        });
        return json(201, {
          ok: true, id: res.output.id,
          scope: describe(res.output.scope), scope_basis: res.scope_basis,
          freshness: freshness(res.output),
        });
      }
    }

    // ——— /gateway : the only write path up, and the only authoritative check ———
    if (method === 'POST' && parts[0] === 'gateway' && parts[1] === 'invoke') {
      const via = resolveVia(principal, body);
      if (!via.ok) return json(via.status, { ok: false, reason: via.reason });
      if (!body?.target || !body?.op) return json(400, { ok: false, reason: 'target and op are required' });

      const res = platform.gateway.invoke({
        employee: principal.employee,
        via: via.via,
        target: body.target,
        op: body.op,
        args: body.args ?? {},
        // An approval is only ever the caller approving their own agent's write.
        // We do not let a request name a different approver.
        approval: body.approval ? { approved_by: principal.employee } : null,
      });
      return json(res.ok ? 200 : 403, res);
    }

    // ——— /board : the platform team's Mission Control, a URL away ———
    if (parts[0] === 'board') {
      // The requester is the token's employee, whatever the body says.
      const scoped = {
        method,
        path: '/' + parts.slice(1).join('/'),
        query: { ...query, requester: principal.employee },
        body: body ? { ...body, requester: principal.employee } : null,
      };
      const res = boardHandler(scoped);
      return json(res.status, res.body);
    }

    return json(404, { ok: false, reason: 'no such route' });
  }

  // Wrapped so a thrown handler never leaks a stack trace to a caller.
  async function handle(req) {
    try {
      return await route(req);
    } catch (err) {
      logger('error', { path: req.path, error: err.message });
      return json(500, { ok: false, reason: 'internal error' });
    }
  }

  function listen(port = 8080, host = '127.0.0.1') {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      let raw = '';
      for await (const chunk of req) raw += chunk;

      let body = null;
      if (raw) {
        try { body = JSON.parse(raw); } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reason: 'body must be JSON' }));
          return;
        }
      }

      const out = await handle({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body,
      });

      logger('request', { method: req.method, path: url.pathname, status: out.status });
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body, null, 2));
    });

    return new Promise((resolve) => {
      server.listen(port, host, () => resolve({ server, port, host, url: `http://${host}:${port}` }));
    });
  }

  return { handle, listen, authenticate, resolveVia };
}
