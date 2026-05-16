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
    await akash(
      ['tx', 'deployment', 'close', '--dseq', String(dseq), '--note', `claws.software:close dseq=${dseq}`, ...BASE_TX_FLAGS],
      30_000,
    );
    console.log(`[deploy] Closed orphaned deployment dseq=${dseq}`);
  } catch (err: any) {
    console.warn(`[deploy] Failed to close orphaned deployment dseq=${dseq}: ${err.message}`);
  }
}

async function waitForBids(dseq: number, maxWaitMs = 120_000): Promise<any> {
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
      if (bids.length > 0) return bids;
    } catch {
      // no bids yet or query error — keep polling
    }
    await sleep(6_000); // 1 block ≈ 6s
  }
  throw new Error(`No bids appeared within ${maxWaitMs / 1000}s for dseq ${dseq}`);
}

function pickBid(bids: any[]): { provider: string; gseq: number; oseq: number } {
  // Each entry: { bid: { id: { provider, dseq, gseq, oseq }, price: { amount, denom } } }
  const sorted = bids.slice().sort((a, b) => {
    const pa = Number(a.bid?.price?.amount ?? 99999999);
    const pb = Number(b.bid?.price?.amount ?? 99999999);
    return pa - pb;
  });
  const best = sorted[0];
  const id = best.bid?.id ?? best.bid ?? best;
  return {
    provider: id.provider,
    gseq: Number(id.gseq ?? 1),
    oseq: Number(id.oseq ?? 1),
  };
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
  // Write SDL to a temp file
  const sdlPath = join(tmpdir(), `akash-sdl-${cellName}-${Date.now()}.yaml`);
  writeFileSync(sdlPath, sdlYaml, 'utf8');

  // Cosmos tx memo. Akash Console + cloudmos.io render this as the deployment "name"
  // in their UIs; without it both display "Unknown". Max 256 chars; we use far less.
  const deploymentNote = `claws.software:${cellName}`;

  try {
    // Step 1: Create deployment
    console.log(`[deploy] Creating deployment for ${cellName}...`);
    const createRaw = await akash([
      'tx', 'deployment', 'create', sdlPath,
      '--deposit', DEPOSIT,
      '--note', deploymentNote,
      ...BASE_TX_FLAGS,
    ], 60_000);

    let createResult: any;
    try {
      createResult = JSON.parse(createRaw);
    } catch {
      throw new Error(`Unexpected create output: ${createRaw.slice(0, 500)}`);
    }

    if (createResult.code !== 0 && createResult.code !== undefined) {
      throw new Error(`Deployment create tx failed code=${createResult.code}: ${createResult.raw_log || createRaw.slice(0, 500)}`);
    }

    const txHash: string = createResult.txhash;

    // Extract dseq from events (v2 SDK returns events array at top level, not inside logs)
    let dseq: number | undefined;
    for (const ev of createResult.events ?? []) {
      if (ev.type === 'akash.deployment.v1.EventDeploymentCreated' || ev.type === 'akash.v1.EventDeploymentCreated') {
        const attr = ev.attributes?.find((a: any) => a.key === 'id');
        if (attr) {
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
    const leaseRaw = await akash([
      'tx', 'market', 'lease', 'create',
      '--dseq', String(dseq),
      '--gseq', String(gseq),
      '--oseq', String(oseq),
      '--provider', provider,
      '--note', deploymentNote,
      ...BASE_TX_FLAGS,
    ], 60_000);

    let leaseResult: any;
    try {
      leaseResult = JSON.parse(leaseRaw);
    } catch {
      throw new Error(`Unexpected lease output: ${leaseRaw.slice(0, 500)}`);
    }

    if (leaseResult.code !== 0 && leaseResult.code !== undefined) {
      throw new Error(`Lease create tx failed code=${leaseResult.code}: ${leaseResult.raw_log}`);
    }

    const leaseTxHash: string = leaseResult.txhash;
    console.log(`[deploy] Lease created txhash=${leaseTxHash}`);

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
