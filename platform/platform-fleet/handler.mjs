// The platform side of UrlPlatformLink: a transport-agnostic request handler the
// platform team mounts on whatever server they already run.
//
// We deliberately do not start a server here. This is a pure function over
// { method, path, query, body } so it can sit behind Express, a Cloud Function,
// or a Lambda without this repo caring which.
//
// Only two routes exist, because only two things cross between the boards (D18):
//   POST /items                       raise a request
//   GET  /items/:id/status?requester= read the status of YOUR OWN request

export function createPlatformBoardHandler(platformBoard) {
  return function handle({ method, path, query = {}, body = null }) {
    const all = path.replace(/^\/+|\/+$/g, '').split('/');
    // The platform team mounts this wherever it suits them - /board, /api/brain,
    // anything. Route on the segments from "items" onward and ignore the prefix.
    const at = all.lastIndexOf('items');
    const parts = at === -1 ? all : all.slice(at);

    if (method === 'POST' && parts.length === 1 && parts[0] === 'items') {
      if (!body?.requester) return { status: 400, body: { ok: false, errors: ['requester is required'] } };
      const res = platformBoard.submit(body);
      return { status: res.ok ? 201 : 400, body: res };
    }

    if (method === 'GET' && parts.length === 3 && parts[0] === 'items' && parts[2] === 'status') {
      const requester = query.requester;
      if (!requester) return { status: 400, body: { ok: false, reason: 'requester is required' } };
      // statusFor refuses anyone who is not the requester, so this route cannot
      // be walked to enumerate the queue.
      const res = platformBoard.statusFor(requester, parts[1]);
      return { status: res.ok ? 200 : 404, body: res };
    }

    return { status: 404, body: { ok: false, reason: 'no such route' } };
  };
}

// Adapts the handler to a fetch-compatible function, so UrlPlatformLink can be
// wired straight to an in-process platform board in tests and single-machine runs.
export function fetchAgainst(handler) {
  return async function fetchImpl(url, init = {}) {
    const u = new URL(url, 'http://platform.local');
    const res = handler({
      method: (init.method ?? 'GET').toUpperCase(),
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      body: init.body ? JSON.parse(init.body) : null,
    });
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => res.body,
    };
  };
}
