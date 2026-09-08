---
name: fleet-setup
description: >
  Stand up an employee agent fleet against the Enterprise Brain. Use when the user
  wants to create a fleet, register agents, choose which tools the fleet should
  have, or wire their harness to the brain. Trigger on "create my fleet", "set up
  a fleet", "register my agents", "which tools can my fleet use", "connect to the
  enterprise brain", "fleet setup". This skill only registers and configures — it
  does not read, publish or invoke; those are fleet-consume, fleet-publish and
  fleet-invoke.
---

# fleet-setup — stand up a fleet

You need nobody's permission to create a fleet. Permission applies only to what
the fleet may reach.

## 1 · Register

A fleet needs a stable id, an owner, and a stable id per agent. The agent ids
matter: the platform can only grant invoke to *a named agent inside a named
fleet*, so an unregistered agent can never be granted anything.

```js
platform.fleetRoster.register({
  fleet: 'f_<employee>',
  owner: '<employee>',
  agents: [{ id: 'analyst', purpose: 'weekly ops read' }],
});
```

The roster is stored on the **platform** side — it is the one shared fact about a
fleet. Everything else lives in the employee's own workspace.

## 2 · Ask which tools they want

Always ask. Do not assume a fleet wants everything available to it. Sort the
answers into two classes, because the governance differs completely:

| Class | What it is | What it needs |
|---|---|---|
| `harness` | A tool the employee's harness already gives them — mail, files, tickets | **Nothing.** It authenticates as them, so it grants no new privilege |
| `enterprise` | A registered enterprise agent | Consume needs the access list; invoke needs a grant |

```js
fleet.tools.choose('f_<employee>', [
  { name: 'gmail', class: 'harness' },
  { name: 'incident-desk', class: 'enterprise' },
  { name: 'incident-desk', class: 'enterprise', invoke: true },
]);
```

Report back in two lists: **ready now** and **pending**, with what each pending
item needs. Never imply an invoke is available before a grant exists.

## 3 · Emit the connection descriptor

```js
fleet.tools.connectionDescriptor({
  fleet: 'f_<employee>',
  ledger_url: '<ledger>',
  gateway_url: '<gateway>',
  platform_board_url: '<platform board>',
});
```

This writes `connection.json` into the employee's workspace. **The fleet builder
installs their own transport** — whatever MCP components their harness provides —
and points it at these endpoints. This skill does not implement a transport and
should not offer to.

## 4 · The token

The platform team issues one bearer token per fleet. It carries **both** the
employee and the fleet id, which is why a request never names either — the host
reads identity from the token and ignores anything the body claims.

It goes in an environment variable, never in a file:

```bash
export ENTERPRISE_BRAIN_TOKEN=ebt_...
```

`connection.json` names the variable and does not contain the value. Never write a
token into the descriptor, a skill file, a commit, or a log line. If a token needs
replacing, the platform team revokes and reissues — revocation is immediate.

## 5 · Then hand off

- anything pending a grant → `fleet-access`
- reading → `fleet-consume`
- publishing → `fleet-publish`

## Rules

- Never write a credential into the fleet workspace. A fleet may hold the
  employee's own credentials only, never one whose reach exceeds theirs.
- Two employees never share a workspace file. If a path does not contain the
  employee's own id, stop.
- Registering more agents than the fleet actually needs widens nothing today but
  creates grant surface later. Register what is in use.
