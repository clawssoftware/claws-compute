import { execFileSync } from 'node:child_process';
import type { ProviderRef } from '@clawssoftware/shared';

// ── Instance size catalogue ──────────────────────────────────────────────────

export type InstanceSize = 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge';

export interface SizeSpec {
  vcpu: number;
  ram_gb: number;
  disk_gb: number;
  rate_per_hr_usd: number;
}

export const INSTANCE_SIZES: Record<InstanceSize, SizeSpec> = {
  xsmall: { vcpu: 0.25, ram_gb: 0.5,  disk_gb: 1,  rate_per_hr_usd: 0.005 },
  small:  { vcpu: 0.5,  ram_gb: 1,    disk_gb: 2,  rate_per_hr_usd: 0.012 },
  medium: { vcpu: 1,    ram_gb: 2,    disk_gb: 5,  rate_per_hr_usd: 0.025 },
  large:  { vcpu: 2,    ram_gb: 4,    disk_gb: 10, rate_per_hr_usd: 0.050 },
  xlarge: { vcpu: 4,    ram_gb: 8,    disk_gb: 20, rate_per_hr_usd: 0.100 },
};

export const VALID_SIZES = Object.keys(INSTANCE_SIZES) as InstanceSize[];

export function resolveSize(raw: string | undefined): InstanceSize {
  return VALID_SIZES.includes(raw as InstanceSize) ? (raw as InstanceSize) : 'xsmall';
}

// ── Cell model ───────────────────────────────────────────────────────────────

export interface CellCapacity {
  vcpu: number;
  ram_gb: number;
  disk_gb: number;
}

export interface Cell {
  cell_id: string;
  tier?: CellTier;
  capacity: CellCapacity;
  region: string;
  healthy: boolean;
  status: 'active' | 'draining' | 'deleted';
  provider?: string;
  akash_lease_id?: string;
  created_at: string;
  deleted_at?: string;
}

export interface CellTenant {
  compute_id: string;
  cell_id: string;
  size: InstanceSize;
  status: 'ready' | 'stopped' | 'deleted';
}

export type CellTier = 'large' | 'medium' | 'small';

export const CELL_CAPACITIES: Record<CellTier, CellCapacity> = {
  large:  { vcpu: 20, ram_gb: 40, disk_gb: 100 },
  medium: { vcpu: 10, ram_gb: 20, disk_gb: 50  },
  small:  { vcpu: 4,  ram_gb: 8,  disk_gb: 20  },
};

export const CELL_CAPACITY = CELL_CAPACITIES.large;

export const UTILIZATION_LIMIT = 0.90;
export const EXPANSION_THRESHOLD = 0.70;

// ── Scheduler ────────────────────────────────────────────────────────────────

export interface CellUtilization {
  vcpu_pct: number;
  ram_pct: number;
  disk_pct: number;
  headroom_pct: number;
  tenant_count: number;
}

export function cellUtilization(cell: Cell, tenants: CellTenant[]): CellUtilization {
  const active = tenants.filter(t => t.cell_id === cell.cell_id && t.status !== 'deleted');
  let vcpu = 0, ram_gb = 0, disk_gb = 0;
  for (const t of active) {
    const s = INSTANCE_SIZES[t.size] ?? INSTANCE_SIZES.xsmall;
    vcpu   += s.vcpu;
    ram_gb += s.ram_gb;
    disk_gb += s.disk_gb;
  }
  const vcpu_pct  = vcpu   / cell.capacity.vcpu;
  const ram_pct   = ram_gb  / cell.capacity.ram_gb;
  const disk_pct  = disk_gb / cell.capacity.disk_gb;
  const headroom_pct = 1 - Math.max(vcpu_pct, ram_pct, disk_pct);
  return { vcpu_pct, ram_pct, disk_pct, headroom_pct, tenant_count: active.length };
}

export function canFit(cell: Cell, tenants: CellTenant[], size: InstanceSize): boolean {
  if (!cell.healthy || cell.status !== 'active') return false;
  const spec = INSTANCE_SIZES[size] ?? INSTANCE_SIZES.xsmall;
  const active = tenants.filter(t => t.cell_id === cell.cell_id && t.status !== 'deleted');
  let vcpu = 0, ram_gb = 0, disk_gb = 0;
  for (const t of active) {
    const s = INSTANCE_SIZES[t.size] ?? INSTANCE_SIZES.xsmall;
    vcpu   += s.vcpu;
    ram_gb += s.ram_gb;
    disk_gb += s.disk_gb;
  }
  const afterVcpu  = (vcpu   + spec.vcpu)   / cell.capacity.vcpu;
  const afterRam   = (ram_gb  + spec.ram_gb)  / cell.capacity.ram_gb;
  const afterDisk  = (disk_gb + spec.disk_gb) / cell.capacity.disk_gb;
  return Math.max(afterVcpu, afterRam, afterDisk) <= UTILIZATION_LIMIT;
}

// Returns the best cell for placement: highest headroom among candidates that can fit.
// Returns null when no cell has capacity → caller should trigger cell expansion.
export function place(cells: Cell[], tenants: CellTenant[], size: InstanceSize): Cell | null {
  const candidates = cells.filter(c => canFit(c, tenants, size));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => {
    const ua = cellUtilization(a, tenants).headroom_pct;
    const ub = cellUtilization(b, tenants).headroom_pct;
    return ub - ua;
  })[0];
}

export function tenantUrl(name: string, computeId: string, domain = 'sludgy.ai'): string {
  const slug = computeId.replace(/^cmp_/, '').slice(0, 8).toLowerCase();
  const safe = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'app';
  return `https://${safe}-${slug}.${domain}`;
}

// ── Legacy Akash provider-services adapter (kept for claws-postgres) ─────────

export type AdapterPlan = ProviderRef & {
  mode: 'live' | 'dev-fallback';
  required_env?: string[];
  present_env?: string[];
};

export interface ComputeAdapter {
  name: 'akash';
  provider: 'akash' | 'local-control-plane';
  planDeploy(source: any): AdapterPlan;
}

export const requiredEnv = ['AKASH_ENABLED', 'AKASH_KEY_NAME', 'AKASH_CHAIN_ID', 'AKASH_NODE'];

function commandAvailable(cmd: string): boolean {
  try {
    execFileSync('sh', ['-lc', `command -v ${cmd}`], { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch { return false; }
}

export function readiness() {
  const cli = commandAvailable('provider-services');
  const network = Boolean(process.env.AKASH_CHAIN_ID && process.env.AKASH_NODE);
  const identity = Boolean(process.env.AKASH_KEY_NAME || process.env.AKASH_FROM);
  const enabled = process.env.AKASH_ENABLED === 'true';
  const executionMode = process.env.AKASH_EXECUTION_MODE === 'provider-services-cli';
  const ready = enabled && cli && network && identity && executionMode;
  return { ready, enabled, cli, network, identity, executionMode };
}

export function computeAdapter(): ComputeAdapter {
  const r = readiness();
  return {
    name: 'akash',
    provider: r.ready ? 'akash' : 'local-control-plane',
    planDeploy(source: any): AdapterPlan {
      return {
        provider: r.ready ? 'akash' : 'local-control-plane',
        status: r.ready ? 'ready' : 'fallback',
        plan: r.ready
          ? [`submit SDL for ${source?.image ?? source?.value ?? 'image'} to Akash cell`, 'create lease', 'send manifest', 'wait for readiness']
          : [`[dev-fallback] would deploy ${source?.image ?? source?.value ?? 'image'} on Akash cell`],
        mode: r.ready ? 'live' : 'dev-fallback',
        required_env: requiredEnv,
        present_env: requiredEnv.filter(n => Boolean(process.env[n])),
        warnings: r.ready ? [] : ['provider-services CLI not available; cell placement uses local-control-plane fallback'],
      };
    },
  };
}

export {
  deployCell,
  deployTestCell,
  deployDatabase,
  closeDeployment,
  leaseEndpoints,
  akashLeaseState,
  walletBalances,
  bmeVaultState,
  mintActFromAkt,
  ensureActBalance,
  topUpDeployment,
  deploymentEscrow,
  leasePrice,
  setOnProviderBlocked,
  loadPersistedBlocklist,
  InsufficientFundsError,
} from './deploy.js';
export type {
  DeployResult,
  LeaseEndpoint,
  DatabaseDeployResult,
  WalletBalances,
  BmeVaultState,
  MintResult,
  DeploymentEscrow,
} from './deploy.js';
export { generateCellSDL, generateTestCellSDL, CELL_IMAGE_DEFAULT } from './sdl.js';
export type { CellSDLParams } from './sdl.js';
export type { DbSize } from './pgsdl.js';
