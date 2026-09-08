// How a fleet board reaches the platform team's Mission Control.
//
// Two implementations of one interface, because the platform board is either in
// the same process (single-machine dev, or a platform-side tool) or a URL away
// (every real deployment).
//
// The interface is narrow on purpose: submit a request, read the status of your
// own request. That is the ONLY coupling between the two boards (D18) — no shared
// data model, and neither side can enumerate the other's items.

export class DirectPlatformLink {
  constructor(platformBoard) { this.board = platformBoard; this.kind = 'direct'; }

  submit(request) { return this.board.submit(request); }

  status(requester, itemId) { return this.board.statusFor(requester, itemId); }
}

export class UrlPlatformLink {
  // `fetchImpl` is injectable so this is testable without a live platform.
  constructor(baseUrl, { fetchImpl = globalThis.fetch, token = null } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.token = token;
    this.kind = 'url';
  }

  headers() {
    return {
      'content-type': 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }

  async submit(request) {
    const res = await this.fetch(`${this.baseUrl}/items`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(request),
    });
    if (!res.ok) return { ok: false, errors: [`platform board returned ${res.status}`] };
    return res.json();
  }

  async status(requester, itemId) {
    const url = `${this.baseUrl}/items/${encodeURIComponent(itemId)}/status?requester=${encodeURIComponent(requester)}`;
    const res = await this.fetch(url, { headers: this.headers() });
    if (!res.ok) return { ok: false, reason: `platform board returned ${res.status}` };
    return res.json();
  }
}
