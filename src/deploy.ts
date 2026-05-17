// Akash mainnet deployment orchestrator for cells.
// Wraps akash CLI + provider-services CLI via child_process.
// All CLI calls are synchronous with generous timeouts; this is not a hot path.

import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { setServers } from 'node:dns';
import { randomBytes } from 'node:crypto';

// Home-router DNS (192.168.x.1) intermittently NXDOMAINs Akash RPC hosts; prefer public resolvers.
setServers(['8.8.8.8', '1.1.1.1', '192.168.0.1']);

const RPC_HOST = new URL(process.env.AKASH_NODE?.trim() || 'https://akash.rpc.arcturian.tech:443').hostname;

async function primeRpcDns(): Promise<void> {
  // macOS Go resolver uses the system cache; ping primes it when router DNS NXDOMAINs.
  spawnSync('ping', ['-c', '1', '-W', '2000', RPC_HOST], { stdio: 'ignore' });
  for (let i = 0; i < 5; i++) {
    try {
      await lookup(RPC_HOST);
      return;
    } catch {
      await sleep(500 * (i + 1));
    }
  }
}

function isDnsError(msg: string): boolean {
  return /no such host|lookup .* on .* failed|ENOTFOUND/i.test(msg);
}
import { writeFileSync, unlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCellSDL, generateTestCellSDL, type CellSDLParams } from './sdl.js';
import { generatePostgresSDL, type DbSize } from './pgsdl.js';

const OWNER = 'akash1knvf2fcd0alx4tyt2gcxt7yua646m32r53484h';
const KEY_NAME = 'claws-deployer';
const KEYRING = 'test';
const CHAIN_ID = 'akashnet-2';
// arcturian has no AAAA record — Go always dials IPv4, avoiding "no route to host" on IPv6-capable but IPv6-offline hosts
const NODE_RPC = process.env.AKASH_NODE?.trim() || 'https://akash.rpc.arcturian.tech:443';
const DEPOSIT = '500000uact';  // minimum deposit in ACT (Akash Credits); Akash v2 bills in uact

const BASE_TX_FLAGS = [
  '--from', KEY_NAME,
  '--keyring-backend', KEYRING,
  '--node', NODE_RPC,
  '--chain-id', CHAIN_ID,
  '--gas', 'auto',
  '--gas-adjustment', '1.5',
  '--gas-prices', '0.025uakt',
  '--yes',
  '--output', 'json',
];

/** Comma- or whitespace-separated `akash1…` provider addresses to exclude from bid selection. */
function envBlockedProviderAddresses(): Set<string> {
  const raw = process.env.AKASH_PROVIDER_BLOCKLIST?.trim() ?? '';
  if (!raw) return new Set();
  return new Set(raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean));
}

/**
 * Session-scoped blocklist: providers we tried this process and that ghosted us
 * (closed deployment after manifest accepted but workload never came up). Cleared on restart.
 * Cap size with `AKASH_PROVIDER_SESSION_BLOCKLIST_MAX` so memory cannot grow unbounded.
 */
const SESSION_BLOCKED_PROVIDERS = new Set<string>();

function sessionBlocklistMax(): number {
  const n = Number(process.env.AKASH_PROVIDER_SESSION_BLOCKLIST_MAX?.trim());
  if (Number.isFinite(n) && n >= 1 && n <= 500) return Math.floor(n);
  return 50;
}

function rememberBadProvider(provider: string, reason: string = 'ghost lease'): void {
  if (!provider) return;
  if (SESSION_BLOCKED_PROVIDERS.size >= sessionBlocklistMax()) {
    // drop oldest by re-creating from tail (Set preserves insertion order)
    const keep = Array.from(SESSION_BLOCKED_PROVIDERS).slice(-Math.floor(sessionBlocklistMax() / 2));
    SESSION_BLOCKED_PROVIDERS.clear();
    keep.forEach((p) => SESSION_BLOCKED_PROVIDERS.add(p));
  }
  const wasNew = !SESSION_BLOCKED_PROVIDERS.has(provider);
  SESSION_BLOCKED_PROVIDERS.add(provider);
  console.warn(`[deploy] Added ${provider} to in-process session blocklist (${SESSION_BLOCKED_PROVIDERS.size} entries; reason: ${reason})`);
  if (wasNew && onProviderBlockedHook) {
    // Fire-and-forget — don't block deploy flow on persistence; conductor will retry.
    Promise.resolve(onProviderBlockedHook(provider, reason)).catch((err: any) => {
      console.warn(`[deploy] onProviderBlocked hook failed for ${provider}: ${err?.message ?? err}`);
    });
  }
}

/** Union of env blocklist + ghosts we’ve seen this process. Used by both bid wait and bid selection. */
function blockedProviderAddresses(): Set<string> {
  const out = envBlockedProviderAddresses();
  for (const p of SESSION_BLOCKED_PROVIDERS) out.add(p);
  return out;
}

/** After `send-manifest`, wait for forwarded ports via `provider-services lease-status`. Default 14m. */
function providerReadyDeadlineMs(): number {
  const n = Number(process.env.AKASH_PROVIDER_READY_TIMEOUT_MS?.trim());
  return Number.isFinite(n) && n >= 60_000 ? n : 14 * 60_000;
}

function providerReadyPollMs(): number {
  const n = Number(process.env.AKASH_PROVIDER_READY_POLL_MS?.trim());
  return Number.isFinite(n) && n >= 2_000 ? n : 5_000;
}

/** Consecutive "lease not found" / HTTP 404 from provider lease-status ⇒ abort early. Default 8. */
function ghostLeaseAbortAfter(): number {
  const n = Number(process.env.AKASH_PROVIDER_GHOST_LEASE_THRESHOLD?.trim());
  return Number.isFinite(n) && n >= 3 ? n : 8;
}

function bidEntryProvider(entry: any): string {
  const id = entry?.bid?.id ?? entry?.bid ?? entry;
  return String(id?.provider ?? '').trim();
}

const MEMO_MAX = 256;

/**
 * Cosmos tx `--note` (memo) is what most Akash explorers use as the human-readable deployment label.
 * - Default: `claws.software:{cellName}`
 * - `AKASH_DEPLOY_MEMO_SHORT=true` → memo is exactly `{cellName}` (often clearer in lease lists).
 * - `AKASH_DEPLOYMENT_MEMO` template may include `{name}` / `${name}` placeholders.
 */
function deploymentMemo(cellName: string): string {
  const short = process.env.AKASH_DEPLOY_MEMO_SHORT?.trim();
  if (short === '1' || short === 'true') {
    return cellName.length <= MEMO_MAX ? cellName : cellName.slice(0, MEMO_MAX);
  }
  const tmpl = process.env.AKASH_DEPLOYMENT_MEMO?.trim();
  if (tmpl) {
    const m = tmpl.replace(/\{name\}/g, cellName).replace(/\$\{name\}/g, cellName);
    return m.length <= MEMO_MAX ? m : m.slice(0, MEMO_MAX);
  }
  const base = `claws.software:${cellName}`;
  return base.length <= MEMO_MAX ? base : base.slice(0, MEMO_MAX);
}

/** Cosmos SDK 0.50+ codespace `sdk` code 32 = incorrect account sequence (not insufficient balance). */
function isWrongSequenceTx(parsed: unknown, rawFallback: string): boolean {
  const p = parsed as { code?: number; raw_log?: string } | null;
  if (p?.code === 32) return true;
  const s = `${p?.raw_log ?? ''}${rawFallback}`;
  return /incorrect account sequence|account sequence mismatch|invalid sequence/i.test(s);
}

function akashTxSequenceRetryCount(): number {
  const n = Number(process.env.AKASH_TX_SEQUENCE_RETRIES?.trim());
  if (Number.isFinite(n) && n >= 1 && n <= 15) return Math.floor(n);
  return 8;
}

/**
 * Broadcast an `akash tx … --output json` command; on **code 32** (wrong sequence) wait and retry.
 * Helps Railway when multiple txs compete for the same signing key (Akash + Cosmos sequence lock).
 */
async function akashTxJsonExpectOk(
  label: string,
  argv: string[],
  timeoutMs: number,
): Promise<{ raw: string; parsed: Record<string, unknown> }> {
  const max = akashTxSequenceRetryCount();
  let lastRaw = '';
  for (let attempt = 0; attempt < max; attempt++) {
    lastRaw = await akash(argv, timeoutMs);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lastRaw) as Record<string, unknown>;
    } catch {
      throw new Error(`${label}: non-JSON akash output: ${lastRaw.slice(0, 400)}`);
    }
    const code = parsed.code;
    if (code === 0 || code === undefined) {
      return { raw: lastRaw, parsed };
    }
    if (isWrongSequenceTx(parsed, lastRaw) && attempt < max - 1) {
      const waitMs = 1500 * (attempt + 1);
      console.warn(
        `[deploy] ${label}: tx code=${String(code)} — retry ${attempt + 1}/${max} in ${waitMs}ms (likely sequence mismatch)`,
      );
      await sleep(waitMs);
      continue;
    }
    return { raw: lastRaw, parsed };
  }
  throw new Error(`${label}: failed after ${max} attempts — last: ${lastRaw.slice(0, 800)}`);
}

export interface DeployResult {
  cell_name: string;
  dseq: number;
  gseq: number;
  oseq: number;
  provider: string;
  tx_hash: string;
  lease_tx_hash: string;
  manifest_sent: boolean;
}

function akashOnce(args: string[], timeoutMs = 30_000): string {
  const r = spawnSync('akash', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, HOME: process.env.HOME ?? '/root' },
  });
  if (r.error) throw new Error(`akash spawn error: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`akash ${args[0]} failed (exit ${r.status}): ${r.stderr?.trim() || r.stdout?.trim()}`);
  }
  return r.stdout;
}

async function akash(args: string[], timeoutMs = 30_000): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await primeRpcDns();
    try {
      return akashOnce(args, timeoutMs);
    } catch (err: any) {
      lastErr = err;
      if (!isDnsError(String(err.message)) || attempt === 4) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error('akash failed');
}

function providerServicesOnce(args: string[], timeoutMs = 60_000): string {
  const r = spawnSync('provider-services', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, HOME: process.env.HOME ?? '/root' },
  });
  if (r.error) throw new Error(`provider-services spawn error: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`provider-services ${args[0]} failed (exit ${r.status}): ${r.stderr?.trim() || r.stdout?.trim()}`);
  }
  return r.stdout;
}

async function providerServices(args: string[], timeoutMs = 60_000): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await primeRpcDns();
    try {
      return providerServicesOnce(args, timeoutMs);
    } catch (err: any) {
      lastErr = err;
      if (!isDnsError(String(err.message)) || attempt === 4) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error('provider-services failed');
}

/** Port → external mapping from `provider-services lease-status` (Akash v2). Shape varies by provider-services version. */
export interface LeaseEndpoint {
  port: number;
  externalPort: number;
  proto: string;
  uris: string[];
}

export async function leaseEndpoints(dseq: number, provider: string): Promise<Record<number, LeaseEndpoint>> {
  const stdout = await providerServices(
    [
      'lease-status',
      '--dseq',
      String(dseq),
      '--gseq',
      '1',
      '--oseq',
      '1',
      '--provider',
      provider,
      '--from',
      KEY_NAME,
      '--keyring-backend',
      KEYRING,
      '--node',
      NODE_RPC,
    ],
    30_000,
  );
  const data = JSON.parse(stdout) as Record<string, unknown>;
  const result: Record<number, LeaseEndpoint> = {};

  const services = (data.services ?? {}) as Record<string, { uris?: string[] }>;
  const forwarded = (data.forwarded_ports ?? data.forwardedPorts ?? {}) as Record<string, unknown>;

  const collectForwarded = (fpList: unknown, uris: string[]) => {
    if (!Array.isArray(fpList)) return;
    for (const fp of fpList as Record<string, unknown>[]) {
      const port = Number(fp?.port ?? fp?.Port);
      if (!Number.isFinite(port)) continue;
      const externalPort = Number(fp?.externalPort ?? fp?.hostPort ?? fp?.external_port ?? port);
      result[port] = {
        port,
        externalPort: Number.isFinite(externalPort) ? externalPort : port,
        proto: String(fp?.proto ?? fp?.protocol ?? 'tcp'),
        uris: Array.isArray(uris) ? uris : [],
      };
    }
  };

  for (const svcName of Object.keys(services)) {
    const uris = services[svcName]?.uris ?? [];
    const fpEntry = forwarded[svcName];
    if (Array.isArray(fpEntry)) {
      collectForwarded(fpEntry, uris);
    } else if (fpEntry && typeof fpEntry === 'object' && Array.isArray((fpEntry as { ports?: unknown }).ports)) {
      collectForwarded((fpEntry as { ports: unknown }).ports, uris);
    }
  }

  if (Object.keys(result).length === 0 && Array.isArray(data.forwarded_ports)) {
    collectForwarded(data.forwarded_ports, []);
  }

  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function closeDeployment(dseq: number): Promise<void> {
  try {
    const { parsed } = await akashTxJsonExpectOk(
      'deployment close',
      ['tx', 'deployment', 'close', '--dseq', String(dseq), '--note', `claws.software:close dseq=${dseq}`, ...BASE_TX_FLAGS],
      30_000,
    );
    const code = parsed.code;
    if (code !== 0 && code !== undefined) {
      console.warn(`[deploy] close dseq=${dseq} returned code=${String(code)}`);
      return;
    }
    console.log(`[deploy] Closed orphaned deployment dseq=${dseq}`);
  } catch (err: any) {
    console.warn(`[deploy] Failed to close orphaned deployment dseq=${dseq}: ${err.message}`);
  }
}

// ── Wallet + BME (Burn-Mint-Escrow) ──────────────────────────────────────────
// AKT funds gas and feeds the BME vault that mints ACT (the billing denom).
// Conversion command on akashnet-2: `akash tx bme mint-act <amount>uakt`.
// `min_mint` chain param is 10,000,000 uact (10 ACT); 25 bps spread.

export interface WalletBalances {
  uakt: number;
  uact: number;
}

export async function walletBalances(): Promise<WalletBalances> {
  const raw = await akash([
    'query', 'bank', 'balances', OWNER,
    '--node', NODE_RPC, '--output', 'json',
  ], 30_000);
  const data = JSON.parse(raw) as { balances?: Array<{ denom: string; amount: string }> };
  let uakt = 0;
  let uact = 0;
  for (const b of data.balances ?? []) {
    if (b.denom === 'uakt') uakt = Number(b.amount || 0);
    else if (b.denom === 'uact') uact = Number(b.amount || 0);
  }
  return { uakt, uact };
}

export interface BmeVaultState {
  vault_uact: number;
  vault_uakt: number;
  /** ACT minted per AKT burned, derived from vault balances. */
  spot_rate: number;
}

export async function bmeVaultState(): Promise<BmeVaultState> {
  const raw = await akash([
    'query', 'bme', 'vault-state',
    '--node', NODE_RPC, '--output', 'json',
  ], 30_000);
  const data = JSON.parse(raw) as { vault_state?: { balances?: Array<{ denom: string; amount: string }> } };
  let vault_uact = 0;
  let vault_uakt = 0;
  for (const b of data.vault_state?.balances ?? []) {
    if (b.denom === 'uact') vault_uact = Number(b.amount || 0);
    else if (b.denom === 'uakt') vault_uakt = Number(b.amount || 0);
  }
  const spot_rate = vault_uakt > 0 ? vault_uact / vault_uakt : 0;
  return { vault_uact, vault_uakt, spot_rate };
}

/** Chain min_mint floor (uact). Conservatively defaults to 10 ACT. */
function minMintUact(): number {
  const n = Number(process.env.AKASH_MIN_MINT_UACT?.trim());
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10_000_000;
}

function bmeRateHint(): number {
  const n = Number(process.env.AKASH_BME_RATE_HINT?.trim());
  return Number.isFinite(n) && n > 0 ? n : 0.284;
}

function minAktReserveUakt(): number {
  const n = Number(process.env.AKASH_MIN_AKT_RESERVE_UAKT?.trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 50_000_000;
}

function txGasBudgetUakt(): number {
  const n = Number(process.env.AKASH_TX_GAS_BUDGET_UAKT?.trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 20_000;
}

export interface MintResult {
  tx_hash: string;
  uakt_burned: number;
  uact_minted: number;
  realized_rate: number;
}

/**
 * Burn AKT to mint ACT via the bme module. Returns the realized rate.
 *
 * Caller must compute the AKT amount; this function does NOT enforce reserve
 * or vault circuit-breaker policy — that's the conductor's job. We only do the tx.
 */
export async function mintActFromAkt(uaktToBurn: number, options?: { note?: string }): Promise<MintResult> {
  if (!Number.isFinite(uaktToBurn) || uaktToBurn <= 0) {
    throw new Error(`mintActFromAkt: invalid uaktToBurn=${uaktToBurn}`);
  }
  const before = await walletBalances();
  const note = options?.note ?? `claws.software:mint-act ${uaktToBurn}uakt`;
  const { parsed } = await akashTxJsonExpectOk(
    'bme mint-act',
    ['tx', 'bme', 'mint-act', `${Math.floor(uaktToBurn)}uakt`, '--note', note, ...BASE_TX_FLAGS],
    60_000,
  );
  const code = parsed.code;
  if (code !== 0 && code !== undefined) {
    throw new Error(`bme mint-act tx failed code=${String(code)}: ${String((parsed as any).raw_log ?? '').slice(0, 400)}`);
  }
  const tx_hash = String((parsed as any).txhash ?? '');

  // Allow the chain a moment to settle, then re-query bank balance to learn realized output.
  await sleep(6_000);
  const after = await walletBalances();
  const burned = Math.max(0, before.uakt - after.uakt);
  // ACT minted = post - pre; gas is paid in uakt so this is clean.
  const minted = Math.max(0, after.uact - before.uact);
  const realized_rate = burned > 0 ? minted / burned : 0;

  console.log(`[deploy] bme mint-act tx=${tx_hash}: burned ${burned}uakt → minted ${minted}uact (rate ${realized_rate.toFixed(6)} ACT/AKT)`);
  return { tx_hash, uakt_burned: burned, uact_minted: minted, realized_rate };
}

/**
 * Ensure wallet ACT balance ≥ `targetUact`. If not, burn AKT (subject to reserve)
 * and mint via bme.mint-act. Returns the post-mint balances. Caller decides what
 * to do if still under-funded after the mint.
 *
 * Sizing: we mint at least max(deficit, min_mint). Uses vault spot_rate when
 * available, falls back to AKASH_BME_RATE_HINT. Adds 5% safety margin to cover
 * the 25 bps spread + rate drift.
 */
export async function ensureActBalance(targetUact: number, opts?: { safetyMargin?: number }): Promise<WalletBalances & { minted?: MintResult }> {
  const balances = await walletBalances();
  if (balances.uact >= targetUact) return balances;

  let deficit = targetUact - balances.uact;
  const floor = minMintUact();
  if (deficit < floor) deficit = floor;

  let rate = bmeRateHint();
  try {
    const vault = await bmeVaultState();
    if (vault.spot_rate > 0) rate = vault.spot_rate;
  } catch (err: any) {
    console.warn(`[deploy] ensureActBalance: bme vault-state failed, using hint rate ${rate}: ${err.message}`);
  }

  const safety = 1 + (opts?.safetyMargin ?? 0.05);
  const uaktForFullTarget = Math.ceil((deficit / Math.max(rate, 1e-9)) * safety);

  const reserve = minAktReserveUakt();
  const gas = txGasBudgetUakt();
  const aktAvailable = Math.max(0, balances.uakt - reserve - gas);

  // Mint as much as we can afford up to the full target. If even the chain
  // min_mint floor can't be funded, refuse — but never fail-closed when a
  // partial mint would still help.
  const uaktToBurn = Math.min(uaktForFullTarget, aktAvailable);
  const minProjectedAct = uaktToBurn * rate;
  if (uaktToBurn <= 0 || minProjectedAct < floor) {
    console.error(
      `[deploy] ensureActBalance: insufficient AKT to cover even the min_mint floor — need ≥ ${Math.ceil(floor / rate)}uakt to mint ${floor}uact, only ${aktAvailable}uakt available after reserve+gas (uakt=${balances.uakt}, reserve=${reserve}, gas=${gas})`,
    );
    return balances;
  }
  if (uaktToBurn < uaktForFullTarget) {
    console.warn(
      `[deploy] ensureActBalance: partial mint — ${uaktToBurn}uakt available (would need ${uaktForFullTarget}uakt for full target ${targetUact}uact). Will reach ~${Math.floor(balances.uact + minProjectedAct)}uact.`,
    );
  }

  console.log(`[deploy] ensureActBalance: ACT ${balances.uact} < target ${targetUact} — burning ${uaktToBurn}uakt for ~${Math.floor(uaktToBurn * rate)}uact at rate ${rate.toFixed(6)}`);
  const minted = await mintActFromAkt(uaktToBurn, { note: `claws.software:ensure-act target=${targetUact}` });
  const after = await walletBalances();
  return { ...after, minted };
}

export async function topUpDeployment(dseq: number, amountUact: number, note?: string): Promise<string> {
  if (!Number.isFinite(amountUact) || amountUact <= 0) {
    throw new Error(`topUpDeployment: invalid amount=${amountUact}`);
  }
  // Correct Akash v2 syntax: `akash tx escrow deposit deployment <amount> --dseq N`
  // (NOT `tx deployment deposit` — that subcommand doesn't exist.)
  const { parsed } = await akashTxJsonExpectOk(
    'escrow deposit deployment',
    [
      'tx', 'escrow', 'deposit',
      'deployment',
      `${Math.floor(amountUact)}uact`,
      '--dseq', String(dseq),
      '--owner', OWNER,
      '--note', note ?? `claws.software:topup dseq=${dseq}`,
      ...BASE_TX_FLAGS,
    ],
    60_000,
  );
  const code = parsed.code;
  if (code !== 0 && code !== undefined) {
    throw new Error(`escrow deposit tx failed code=${String(code)}: ${String((parsed as any).raw_log ?? '').slice(0, 400)}`);
  }
  return String((parsed as any).txhash ?? '');
}

// ── Escrow + lease accounting ─────────────────────────────────────────────────

export interface DeploymentEscrow {
  dseq: number;
  balance_uact: number;
  state: 'open' | 'closed' | 'overdrawn' | 'unknown';
}

/** Query the deployment's escrow account; balance is what funds the lease per-block charge. */
export async function deploymentEscrow(dseq: number): Promise<DeploymentEscrow> {
  const raw = await akash([
    'query', 'deployment', 'get',
    '--owner', OWNER, '--dseq', String(dseq),
    '--node', NODE_RPC, '--output', 'json',
  ], 30_000);
  const data = JSON.parse(raw) as Record<string, any>;
  const acct = data.escrow_account ?? data.escrowAccount ?? data.deployment?.escrow_account;
  const bal = acct?.balance;
  // Balance shape varies: sometimes { amount, denom }, sometimes string "123uact"
  let balance_uact = 0;
  if (bal && typeof bal === 'object') {
    if (Array.isArray(bal)) {
      const entry = bal.find((b: any) => b?.denom === 'uact');
      balance_uact = Number(entry?.amount ?? 0);
    } else if (bal.denom === 'uact') {
      balance_uact = Number(bal.amount ?? 0);
    } else if (bal.amount && bal.denom === undefined) {
      balance_uact = Number(bal.amount);
    }
  } else if (typeof bal === 'string') {
    const m = bal.match(/^(\d+)uact$/);
    if (m) balance_uact = Number(m[1]);
  }
  const stateRaw = String(acct?.state ?? data.deployment?.state ?? 'unknown').toLowerCase();
  const state: DeploymentEscrow['state'] =
    stateRaw.includes('overdrawn') ? 'overdrawn' :
    stateRaw.includes('closed') ? 'closed' :
    stateRaw.includes('open') || stateRaw.includes('active') ? 'open' :
    'unknown';
  return { dseq, balance_uact, state };
}

/** Query the current lease price in uact/block for a given (dseq, provider). */
export async function leasePrice(dseq: number, provider: string): Promise<number> {
  const raw = await akash([
    'query', 'market', 'lease', 'get',
    '--owner', OWNER, '--dseq', String(dseq),
    '--gseq', '1', '--oseq', '1', '--provider', provider,
    '--node', NODE_RPC, '--output', 'json',
  ], 30_000);
  const data = JSON.parse(raw) as Record<string, any>;
  const price = data?.lease?.price;
  if (!price) return 0;
  if (price.denom === 'uact') return Number(price.amount ?? 0);
  // Some shapes have just { amount: "12.345" } — assume uact in absence of denom mismatch.
  return Number(price.amount ?? 0);
}

// ── Persisted blocklist hook ──────────────────────────────────────────────────
// Conductor injects a callback here so newly-blocked providers persist to the API.

type BlocklistPersistFn = (provider: string, reason: string) => void | Promise<void>;
let onProviderBlockedHook: BlocklistPersistFn | null = null;

export function setOnProviderBlocked(fn: BlocklistPersistFn | null): void {
  onProviderBlockedHook = fn;
}

export function loadPersistedBlocklist(providers: Array<{ address: string }>): void {
  for (const p of providers) {
    if (p?.address) SESSION_BLOCKED_PROVIDERS.add(p.address);
  }
}

// ── Deposit sizing constants ──────────────────────────────────────────────────

const BLOCKS_PER_HOUR = 600; // 6s blocks

function initialDepositHours(): number {
  const n = Number(process.env.AKASH_INITIAL_DEPOSIT_HOURS?.trim());
  return Number.isFinite(n) && n >= 1 ? n : 48;
}

function minWalletBalanceUact(): number {
  const n = Number(process.env.AKASH_MIN_WALLET_BALANCE_UACT?.trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 50_000_000;
}

function targetWalletBalanceUact(): number {
  const n = Number(process.env.AKASH_TARGET_WALLET_BALANCE_UACT?.trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 200_000_000;
}

/**
 * Wallet sanity check before any deploy tx. Refuses to proceed if neither ACT nor
 * mintable AKT can cover the bootstrap deposit. Auto-mints ACT when below the floor.
 *
 * Throws a structured `InsufficientFundsError` so the conductor can flip into the
 * `low_balance` state instead of looping on the same failure.
 */
export class InsufficientFundsError extends Error {
  constructor(message: string, public details: Record<string, unknown>) {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

async function preflightWallet(cellName: string): Promise<void> {
  const balances = await walletBalances();
  const floor = minWalletBalanceUact();
  const target = targetWalletBalanceUact();

  // Bootstrap requires at least 500k uact + room for one topup tx fee.
  const bootstrapRequirement = 500_000 + 1_000_000; // 1.5 ACT cushion

  if (balances.uact < floor) {
    console.log(
      `[deploy] preflight ${cellName}: ACT balance ${balances.uact}uact < floor ${floor}uact — attempting mint to ${target}uact`,
    );
    try {
      const after = await ensureActBalance(target);
      if (after.uact < bootstrapRequirement) {
        throw new InsufficientFundsError(
          `Wallet ACT below bootstrap requirement even after mint`,
          {
            cell: cellName,
            uact_after_mint: after.uact,
            uakt_after_mint: after.uakt,
            bootstrap_requirement_uact: bootstrapRequirement,
            floor_uact: floor,
            minted: after.minted ?? null,
          },
        );
      }
      return;
    } catch (err: any) {
      if (err instanceof InsufficientFundsError) throw err;
      // Mint tx failed; check if we still have enough for at least the bootstrap.
      const recheck = await walletBalances();
      if (recheck.uact < bootstrapRequirement) {
        throw new InsufficientFundsError(`mint failed and ACT below bootstrap requirement: ${err.message}`, {
          cell: cellName,
          uact: recheck.uact,
          uakt: recheck.uakt,
          mint_error: err.message,
        });
      }
      console.warn(`[deploy] preflight ${cellName}: mint failed but bootstrap covered (${recheck.uact}uact); proceeding: ${err.message}`);
    }
    return;
  }

  if (balances.uact < bootstrapRequirement) {
    throw new InsufficientFundsError(`Wallet ACT below bootstrap requirement`, {
      cell: cellName,
      uact: balances.uact,
      uakt: balances.uakt,
      bootstrap_requirement_uact: bootstrapRequirement,
    });
  }
}

async function waitForBids(dseq: number, maxWaitMs = 120_000): Promise<any[]> {
  const blocked = blockedProviderAddresses();
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const raw = await akash([
        'query', 'market', 'bid', 'list',
        '--owner', OWNER,
        '--dseq', String(dseq),
        '--state', 'open',
        '--node', NODE_RPC,
        '--output', 'json',
      ]);
      const data = JSON.parse(raw);
      const bids: any[] = data.bids ?? [];
      if (bids.length > 0) {
        const eligible = bids.filter((b) => !blocked.has(bidEntryProvider(b)));
        if (blocked.size === 0 || eligible.length > 0) return bids;
        /* bids exist but all are blocklisted — keep polling until new providers bid */
      }
    } catch {
      // no bids yet or query error — keep polling
    }
    await sleep(6_000); // 1 block ≈ 6s
  }

  try {
    const tailRaw = await akash([
      'query', 'market', 'bid', 'list',
      '--owner', OWNER,
      '--dseq', String(dseq),
      '--state', 'open',
      '--node', NODE_RPC,
      '--output', 'json',
    ]);
    const tailData = JSON.parse(tailRaw);
    const tailBids: any[] = tailData.bids ?? [];
    if (
      tailBids.length > 0 &&
      blocked.size > 0 &&
      tailBids.every((b) => blocked.has(bidEntryProvider(b)))
    ) {
      throw new Error(
        `${tailBids.length} bid(s) on dseq ${dseq} are AKASH_PROVIDER_BLOCKLIST-only`,
      );
    }
  } catch (e: unknown) {
    if (
      e instanceof Error &&
      e.message.includes('AKASH_PROVIDER_BLOCKLIST-only')
    ) {
      throw e;
    }
  }
  throw new Error(`No bids appeared within ${maxWaitMs / 1000}s for dseq ${dseq}`);
}

function pickBid(bids: any[]): { provider: string; gseq: number; oseq: number } {
  const blocked = blockedProviderAddresses();
  const eligible = bids.filter((b) => !blocked.has(bidEntryProvider(b)));
  const sorted = eligible.sort((a, b) => {
    const pa = Number(a.bid?.price?.amount ?? 99999999);
    const pb = Number(b.bid?.price?.amount ?? 99999999);
    return pa - pb;
  });
  if (sorted.length === 0) {
    const preview = bids
      .slice(0, 5)
      .map((x) => bidEntryProvider(x))
      .join(', ');
    throw new Error(
      `All ${bids.length} Akash bid(s) are in AKASH_PROVIDER_BLOCKLIST (sample: ${preview})`,
    );
  }
  const best = sorted[0];
  const id = best.bid?.id ?? best.bid ?? best;
  return {
    provider: id.provider,
    gseq: Number(id.gseq ?? 1),
    oseq: Number(id.oseq ?? 1),
  };
}

/**
 * After manifest is accepted, poll `lease-status` until forwarded ports appear, or bail out when
 * the provider keeps returning ghost "lease not found" / 404 responses.
 */
async function waitForForwardedPortsAfterManifest(
  cellName: string,
  dseq: number,
  provider: string,
): Promise<void> {
  const deadlineAt = Date.now() + providerReadyDeadlineMs();
  const pollMs = providerReadyPollMs();
  const ghostAbort = ghostLeaseAbortAfter();
  let consecutiveGhost = 0;

  console.log(
    `[deploy] Waiting for provider workload (${provider}) dseq=${dseq} cell=${cellName} (${providerReadyDeadlineMs()}ms deadline)`,
  );

  while (Date.now() < deadlineAt) {
    try {
      const eps = await leaseEndpoints(dseq, provider);
      if (Object.keys(eps).length > 0) {
        console.log(`[deploy] Forwarded ports ready: ${Object.keys(eps).join(',')}`);
        return;
      }
      consecutiveGhost = 0;
    } catch (err: any) {
      const msg = String(err.message);
      const ghost = /lease not found|404|remote server returned 404/i.test(msg);
      if (ghost) {
        consecutiveGhost += 1;
        console.warn(`[deploy] Ghost lease-status (${consecutiveGhost}/${ghostAbort}) ${msg.slice(0, 260)}`);
        if (consecutiveGhost >= ghostAbort) {
          rememberBadProvider(provider, `ghost lease ${consecutiveGhost}× on ${cellName} dseq=${dseq}`);
          await closeDeployment(dseq);
          throw new Error(
            `Provider ${provider} never materialized workload for ${cellName} dseq=${dseq}`,
          );
        }
      } else {
        consecutiveGhost = 0;
      }
    }
    await sleep(pollMs);
  }

  rememberBadProvider(provider, `forwarded_ports timeout ${providerReadyDeadlineMs()}ms on ${cellName} dseq=${dseq}`);
  await closeDeployment(dseq);
  throw new Error(`Timeout (${providerReadyDeadlineMs()}ms) for forwarded_ports ${cellName} dseq=${dseq}`);
}

export async function deployCell(params: CellSDLParams): Promise<DeployResult> {
  const sdlYaml = generateCellSDL(params);
  return _deploy(params.name, sdlYaml);
}

export async function deployTestCell(name: string): Promise<DeployResult> {
  const sdlYaml = generateTestCellSDL(name);
  return _deploy(name, sdlYaml);
}

async function _deploy(cellName: string, sdlYaml: string): Promise<DeployResult> {
  // Step 0: Wallet pre-check. Bootstrap deposit (500k uact) + worst-case topup must fit.
  // Auto-mint ACT from AKT when the wallet is below the configured floor.
  await preflightWallet(cellName);

  // Write SDL to a temp file
  const sdlPath = join(tmpdir(), `akash-sdl-${cellName}-${Date.now()}.yaml`);
  writeFileSync(sdlPath, sdlYaml, 'utf8');

  // Cosmos tx memo (`--note`). Explorers (Cloudmos, Akash Console) map this to the deployment name.
  const deploymentNote = deploymentMemo(cellName);

  try {
    // Step 1: Create deployment
    console.log(`[deploy] Creating deployment for ${cellName}...`);
    const { raw: createRaw, parsed: createResult } = await akashTxJsonExpectOk(
      'deployment create',
      [
        'tx', 'deployment', 'create', sdlPath,
        '--deposit', DEPOSIT,
        '--note', deploymentNote,
        ...BASE_TX_FLAGS,
      ],
      60_000,
    );

    if (createResult.code !== 0 && createResult.code !== undefined) {
      throw new Error(`Deployment create tx failed code=${createResult.code}: ${createResult.raw_log || createRaw.slice(0, 500)}`);
    }

    const txHash: string = String(createResult.txhash ?? '');

    // Extract dseq from events (v2 SDK returns events array at top level, not inside logs)
    let dseq: number | undefined;
    const createEvents = Array.isArray(createResult.events) ? createResult.events : [];
    for (const ev of createEvents as Array<{ type?: string; attributes?: Array<{ key?: string; value?: string }> }>) {
      if (ev.type === 'akash.deployment.v1.EventDeploymentCreated' || ev.type === 'akash.v1.EventDeploymentCreated') {
        const attr = ev.attributes?.find((a: any) => a.key === 'id');
        if (attr?.value) {
          try {
            const id = JSON.parse(attr.value);
            if (id.dseq) { dseq = Number(id.dseq); break; }
          } catch {}
        }
      }
    }

    // Fallback: regex parse the raw JSON for dseq
    if (!dseq) {
      const match = createRaw.match(/"dseq"\s*[":]+\s*"?(\d+)"?/);
      if (match) dseq = Number(match[1]);
    }

    if (!dseq) {
      // Last resort: query deployments and find the newest one we just created
      console.log('[deploy] dseq not in tx logs, querying deployment list...');
      const listRaw = await akash([
        'query', 'deployment', 'list',
        '--owner', OWNER,
        '--state', 'active',
        '--node', NODE_RPC,
        '--output', 'json',
      ]);
      const list = JSON.parse(listRaw);
      const deps: any[] = list.deployments ?? [];
      if (!deps.length) throw new Error('Could not determine dseq — no active deployments found');
      deps.sort((a, b) => Number(b.deployment?.deployment_id?.dseq ?? 0) - Number(a.deployment?.deployment_id?.dseq ?? 0));
      dseq = Number(deps[0].deployment?.deployment_id?.dseq);
    }

    console.log(`[deploy] Deployment created txhash=${txHash} dseq=${dseq}`);

    // Step 2: Wait for bids
    console.log(`[deploy] Waiting for bids on dseq=${dseq}...`);
    let bids: any[];
    try {
      bids = await waitForBids(dseq);
    } catch (err: any) {
      await closeDeployment(dseq);
      throw err;
    }
    console.log(`[deploy] Got ${bids.length} bid(s)`);

    const { provider, gseq, oseq } = pickBid(bids);
    console.log(`[deploy] Selected provider=${provider} gseq=${gseq} oseq=${oseq}`);

    // Step 3: Create lease
    console.log(`[deploy] Creating lease...`);
    const { raw: leaseRaw, parsed: leaseResult } = await akashTxJsonExpectOk(
      'lease create',
      [
        'tx', 'market', 'lease', 'create',
        '--dseq', String(dseq),
        '--gseq', String(gseq),
        '--oseq', String(oseq),
        '--provider', provider,
        '--note', deploymentNote,
        ...BASE_TX_FLAGS,
      ],
      60_000,
    );

    if (leaseResult.code !== 0 && leaseResult.code !== undefined) {
      throw new Error(`Lease create tx failed code=${leaseResult.code}: ${leaseResult.raw_log}`);
    }

    const leaseTxHash: string = String(leaseResult.txhash ?? '');
    console.log(`[deploy] Lease created txhash=${leaseTxHash}`);

    // Step 3.5: Top up escrow to AKASH_INITIAL_DEPOSIT_HOURS of runway at the realized bid price.
    // The 500_000 uact bootstrap deposit alone funds a `large` cell for ~60 seconds at the price
    // cap and ~25 min at typical bids — way too short. Fund it properly now that we know the price.
    try {
      const winningBid = bids.find((b: any) => bidEntryProvider(b) === provider);
      const pricePerBlockUact = Number(winningBid?.bid?.price?.amount ?? 0);
      if (pricePerBlockUact > 0) {
        const targetUact = Math.ceil(pricePerBlockUact * BLOCKS_PER_HOUR * initialDepositHours());
        const bootstrap = 500_000; // already in escrow from `tx deployment create`
        const topupUact = Math.max(0, targetUact - bootstrap);
        if (topupUact > 0) {
          // Make sure wallet ACT covers the top-up; auto-mint if not.
          await ensureActBalance(topupUact + 1_000_000 /* safety pad */);
          console.log(
            `[deploy] Topping up dseq=${dseq} by ${topupUact}uact (target ${initialDepositHours()}h runway @ ${pricePerBlockUact}uact/block)`,
          );
          const topupTx = await topUpDeployment(dseq, topupUact, `claws.software:bootstrap-topup ${cellName} dseq=${dseq}`);
          console.log(`[deploy] Bootstrap top-up tx=${topupTx} dseq=${dseq}`);
        } else {
          console.log(`[deploy] Bootstrap deposit (500_000uact) already covers ${initialDepositHours()}h at ${pricePerBlockUact}uact/block; no top-up needed`);
        }
      } else {
        console.warn(`[deploy] Could not read bid price for dseq=${dseq}; skipping initial top-up — reconciliation will catch up`);
      }
    } catch (err: any) {
      // Non-fatal: reconciliation will detect under-funded cells and top them up.
      console.warn(`[deploy] Initial top-up failed (non-fatal, reconciliation will retry): ${err.message}`);
    }

    // Step 4: Send manifest
    console.log(`[deploy] Sending manifest...`);
    let manifestSent = false;
    try {
      // provider-services send-manifest does NOT accept --chain-id; uses --node for chain queries
      await providerServices([
        'send-manifest', sdlPath,
        '--dseq', String(dseq),
        '--gseq', String(gseq),
        '--oseq', String(oseq),
        '--provider', provider,
        '--from', KEY_NAME,
        '--keyring-backend', KEYRING,
        '--node', NODE_RPC,
      ], 60_000);
      manifestSent = true;
      console.log(`[deploy] Manifest sent`);
    } catch (err: any) {
      console.warn(`[deploy] Manifest send failed (non-fatal, lease exists): ${err.message}`);
    }

    // Step 5: Ensure provider exposes workload ports (closes + throws on ghost leases / timeouts)
    await waitForForwardedPortsAfterManifest(cellName, dseq, provider);

    return { cell_name: cellName, dseq, gseq, oseq, provider, tx_hash: txHash, lease_tx_hash: leaseTxHash, manifest_sent: manifestSent };
  } finally {
    try { unlinkSync(sdlPath); } catch {}
  }
}

export interface DatabaseDeployResult {
  database_name: string;
  dseq: number;
  gseq: number;
  oseq: number;
  provider: string;
  tx_hash: string;
  lease_tx_hash: string;
  manifest_sent: boolean;
  host: string;
  port: number;
  dsn: string;
  superuser: string;
  password: string;
  database: string;
}

function pickLeaseHost(ep: { uris?: string[] } | undefined): string | null {
  const u = ep?.uris?.[0];
  if (!u) return null;
  return u.replace(/^https?:\/\//i, '').split('/')[0];
}

function waitForTcp(host: string, port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() > deadline) {
        reject(new Error(`TCP connect timeout ${host}:${port}`));
        return;
      }
      const socket = connect({ host, port }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        setTimeout(attempt, 2000);
      });
    };
    attempt();
  });
}

export async function akashLeaseState(dseq: number, provider: string): Promise<'active' | 'closed'> {
  try {
    const raw = await akash([
      'query', 'market', 'lease', 'list',
      '--owner', OWNER,
      '--dseq', String(dseq),
      '--provider', provider,
      '--state', 'active',
      '--node', NODE_RPC,
      '--output', 'json',
    ]);
    const data = JSON.parse(raw) as { leases?: unknown[] };
    return (data.leases?.length ?? 0) > 0 ? 'active' : 'closed';
  } catch {
    return 'closed';
  }
}

export async function deployDatabase(params: {
  name: string;
  size?: DbSize;
  version?: string;
  priceCapUact?: number;
}): Promise<DatabaseDeployResult> {
  const superuser = `u_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(32).toString('base64url');
  const database = 'app';
  const version = params.version ?? '16';

  const sdlYaml = generatePostgresSDL({
    name: params.name,
    size: params.size,
    version,
    superuser,
    password,
    database,
    priceCapUact: params.priceCapUact,
  });

  const deploy = await _deploy(params.name, sdlYaml);

  let host: string | null = null;
  let port = 5432;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const endpoints = await leaseEndpoints(deploy.dseq, deploy.provider);
      const ep = endpoints[5432];
      const picked = pickLeaseHost(ep);
      if (picked && ep) {
        host = picked;
        port = ep.externalPort ?? 5432;
        break;
      }
    } catch {
      /* lease-status not ready */
    }
    await sleep(2000);
  }
  if (!host) {
    throw new Error(`Could not discover Postgres endpoint for ${params.name} dseq=${deploy.dseq}`);
  }

  await waitForTcp(host, port, 60_000);

  const encUser = encodeURIComponent(superuser);
  const encPass = encodeURIComponent(password);
  const dsn = `postgres://${encUser}:${encPass}@${host}:${port}/${database}`;

  return {
    database_name: params.name,
    dseq: deploy.dseq,
    gseq: deploy.gseq,
    oseq: deploy.oseq,
    provider: deploy.provider,
    tx_hash: deploy.tx_hash,
    lease_tx_hash: deploy.lease_tx_hash,
    manifest_sent: deploy.manifest_sent,
    host,
    port,
    dsn,
    superuser,
    password,
    database,
  };
}
