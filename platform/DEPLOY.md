# Hosting the two Mission Controls

Run it locally and nothing needs deploying: `node serve.mjs --seed` gives you
both boards in one command. Host it when other people need to open a board
without running a server, which is most of the reason a board exists.

**Vercel is the recommended host.** The whole brain is one pure request handler,
so it deploys as a single function with no rework, and Vercel Blob gives it the
durable storage a serverless filesystem cannot.

## Why storage is the only real decision

A function's disk is ephemeral. Anything the brain writes there is gone by the
next request: a published output, a verdict, an issued grant. So a deployment
swaps the storage backend, and nothing else changes.

| | Local | Hosted |
|---|---|---|
| Backend | one file per path | one document per workspace, on Blob |
| Lifecycle | the filesystem is the store | hydrated before a request, flushed after |
| Install | nothing | `npm install` for `@vercel/blob` |

The split by workspace is deliberate and it is the reason this is not one big
document: **two employees never share a document**, and a request only ever
hydrates the platform document and its own caller's workspace. A check proves
both, and proves that a read from a document nobody hydrated fails loudly rather
than looking like empty storage.

## The one step nobody can do for you

`vercel login` authenticates through your browser. Nobody should ever ask you
for a Vercel password or paste one on your behalf, including an agent working in
this repo. Run it yourself:

```bash
npm i -g vercel      # if you do not have it
vercel login         # your browser, your account
```

Pick the account deliberately. If you keep work and personal accounts, a public
demo of this belongs on the personal one.

## Standing it up

```bash
cd platform
npm install                      # @vercel/blob, needed only to deploy
vercel link                      # choose or create the project
```

Create a **Blob store** on that project in the Vercel dashboard, under Storage.
Connecting it sets `BLOB_READ_WRITE_TOKEN` on the deployment for you.

Then seed the world once, from your machine, over the same store the deployment
will read:

```bash
vercel env pull .env.local       # brings the token down
set -a && . ./.env.local && set +a
node seed-hosted.mjs --base https://<your-project>.vercel.app
```

That prints the tokens it minted. **They are the only way into a hosted board**,
because the local token list is off on a deployment. Hand each one to its own
person.

```bash
vercel deploy --prod             # or: npm run deploy
```

Open `/fleet` or `/platform` and paste a token, or use the pre-signed links the
seed printed.

## What a deployment does differently

- **The local token list is off.** `/api/dev/tokens` answers only on the
  loopback interface and only when the host was started with `--seed` or
  `--dev-tokens`. A deployment is neither, and the route stays a 404.
- **The pages are open, the data is not.** A page carries no token and shows
  nothing until one is supplied. The token arrives in the URL fragment, which
  never reaches the server.
- **A missing store is a 503, not a silent success.** Without
  `BLOB_READ_WRITE_TOKEN` the function refuses rather than writing to a disk
  that is about to disappear.

## Before you point anybody at it

- **This repo is public.** A hosted instance must carry only the fictional seed:
  Alice, Bob, Carol and Dave, and invented figures. Do not seed a hosted board
  with real people, real systems of record or real numbers.
- **Read the gaps.** The host has no TLS of its own (Vercel terminates it), the
  rate limit and the in-flight cap are per-instance and therefore weaker across
  many instances, and an append on Blob is a read-modify-write. That is demo
  scale. See "Known gaps" in the README.

## Somewhere other than Vercel

Nothing here is Vercel-specific except `brain/blob-store.mjs` and
`api/host.mjs`. The storage contract is two async functions:

```js
load(name) -> { files: { key: text } } | null
save(name, doc)
```

Implement those against Postgres, S3 or a KV store, pass them to
`createDocumentBackend`, and the rest of the brain does not move. That is the
honest path for a real deployment, where an append should be an append rather
than a rewrite.
