# `@claws/compute` (claws-compute)

Library for **Akash**-oriented compute: SDL generation for Claws **cells** and **Postgres** workloads, placement helpers, readiness checks, and synchronous CLI orchestration (`akash` + `provider-services`) used by **claws-conductor** and **claws-postgres** flows.

This package is a **nested git repository** inside the monorepo workspace. It ships its own `LICENSE` (MIT).

---

## What this library does

- **Cell SDL** (`src/sdl.ts`) — Builds Akash manifest YAML (version 2.0) for the cell image, ports, env (`CLAWS_API_URL`, `CELL_AGENT_SECRET`), resource tiers, pricing caps, and auditor placement constraints.
- **Postgres SDL** (`src/pgsdl.ts`) — Builds Akash manifests for standalone Postgres deployments (sizes `xsmall`–`large`, persistent storage profile).
- **Deploy orchestration** (`src/deploy.ts`) — Wraps `akash` and `provider-services` via `child_process` with DNS priming for flaky resolvers, lease polling, and helpers such as `deployCell`, `deployTestCell`, `deployDatabase`, `closeDeployment`, `leaseEndpoints`, `akashLeaseState`.
- **Scheduler primitives** (`src/index.ts` exports) — `Cell` / `CellTenant` model, instance size catalogue, `place()` for bin-packing style placement, `cellUtilization()`, and `computeAdapter()` readiness mirroring Akash env requirements.

There is **no long-running server** in this package; consumers import functions and run them in Node.

---

## Architecture (modules)

| File | Responsibility |
|------|------------------|
| `src/index.ts` | Public exports: sizes, placement, `readiness()`, `computeAdapter()`, re-exports from `deploy.js` / `sdl.js`. |
| `src/sdl.ts` | `generateCellSDL`, `generateTestCellSDL`, `CELL_IMAGE_DEFAULT`, YAML quoting helper. |
| `src/pgsdl.ts` | `generatePostgresSDL`, `DB_RESOURCES`, `DbSize` type. |
| `src/deploy.ts` | Akash mainnet-oriented deploy commands, timeouts, lease discovery, database deploy result shaping. |
| `src/deploy-cli.ts` | Optional CLI harness (`pnpm deploy:test`) to deploy a test cell from the shell. |

---

## Entrypoints

- **Library:** `package.json` → `"main": "dist/index.js"`, `"types": "dist/index.d.ts"`.
- **CLI example:** `src/deploy-cli.ts` (run via `tsx` or the `deploy:test` script).

---

## Environment variables (names only)

**Akash execution**

- `AKASH_ENABLED` — must be `true` for “live” readiness path (with CLI + network + identity + execution mode).
- `AKASH_KEY_NAME` or `AKASH_FROM` — signing identity for CLI.
- `AKASH_CHAIN_ID` — e.g. mainnet chain id used with the CLI.
- `AKASH_NODE` — Tendermint RPC URL (code defaults to a public RPC host if unset; override for your network).
- `AKASH_EXECUTION_MODE` — must be `provider-services-cli` for readiness to report full live path.

**Orchestration (deploy.ts)**

- `AKASH_PROVIDER_BLOCKLIST` — comma- or whitespace-separated provider `akash1…` addresses to skip when choosing the lowest-price bid (avoids incapable “ghost lease” hosts without manual UI filtering).
- `AKASH_PROVIDER_READY_TIMEOUT_MS` — after `send-manifest`, how long to poll `provider-services lease-status` for forwarded ports before closing deployment (floor 60 000; default ~14 min).
- `AKASH_PROVIDER_READY_POLL_MS` — poll interval during that wait (floor 2000 ms).
- `AKASH_PROVIDER_GHOST_LEASE_THRESHOLD` — consecutive `lease not found` / HTTP 404 responses before closing as a ghost workload (minimum 3, default 8).

**Images**

- `CELL_IMAGE` — overrides default cell container image (`ghcr.io/clawssoftware/claws-cell:latest` when unset; must match the public `clawssoftware/claws-cell` GHCR push).

**Process**

- `HOME` — passed through to CLI child environments (Dockerfile/entry flows often set this).

> **Security note:** `deploy.ts` contains example constants (owner address, key names) suitable for the project’s operational docs—treat any key material in **your** deployment as secrets supplied via env or mounted config, not committed files.

---

## Local development

From the **workspace root**:

```bash
pnpm install
pnpm --filter @claws/compute build
```

To typecheck only:

```bash
pnpm --filter @claws/compute typecheck
```

### Try the deploy CLI (costs / real chain)

The `deploy:test` script runs `tsx src/deploy-cli.ts` and targets **Akash mainnet** when configured. Only run with funded keys and clear understanding of spend.

```bash
pnpm --filter @claws/compute run deploy:test -- cell-0001
```

You must have `akash` and `provider-services` binaries on `PATH` and valid Akash wallet configuration for this to succeed.

---

## Testing

Tests are Node’s built-in test runner over **compiled** output:

```bash
pnpm --filter @claws/compute build
pnpm --filter @claws/compute test
```

Test files:

- `src/sdl.test.ts` — SDL structure / quoting invariants.
- `src/pgsdl.test.ts` — Postgres SDL generation.

---

## How other packages use this

- **claws-conductor** imports `deployCell`, `deployDatabase`, `closeDeployment`, `leaseEndpoints`, `akashLeaseState` to register cells and manage database leases/backups.
- **claws-api** / product docs reference Akash manifests and adapter contracts that align with these SDL shapes.

---

## Deployment notes (high level)

- This package is typically consumed as a **dependency**, not deployed alone.
- Railway / Docker images that need live Akash should install `akash` and `provider-services` (see **claws-conductor** `Dockerfile` for a reference layout) and inject wallet/mnemonic handling **outside** source control.

---

## Troubleshooting

| Issue | Suggestions |
|-------|-------------|
| `command not found: akash` / `provider-services` | Install CLIs and ensure `PATH` in the same environment as Node. |
| DNS / `ENOTFOUND` to RPC | `deploy.ts` sets public DNS servers and primes lookups; corporate VPNs may still block—try another network or set `AKASH_NODE` to a reachable RPC. |
| `No bids appeared` | Provider capacity / price caps / auditor constraints—conductor may retry tiers; adjust SDL pricing or tier in code paths that call `deployCell`. |
| Tests fail after edit | Re-run `build` so `dist/**/*.test.js` is up to date. |

---

## Related packages

- **[@claws/conductor](../claws-conductor)** — Uses deploy + lease polling in production loops.
- **[@claws/api](../claws-api)** — Control plane HTTP surface that stores cell and database metadata conductor writes back to.
- **[@claws/shared](../claws-sdk/packages/shared)** — `ProviderRef` types and shared API constants.

---

## License

MIT — see `LICENSE` in this directory (Copyright © 2026 Claws Contributors).
