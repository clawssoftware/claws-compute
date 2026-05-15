import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { ProviderRef } from '@claws/shared';

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

function akashIdentityPresent(): boolean {
  return Boolean(process.env.AKASH_KEY_NAME || process.env.AKASH_FROM);
}

export function readiness() {
  const cli = commandAvailable('provider-services');
  const network = Boolean(process.env.AKASH_CHAIN_ID && process.env.AKASH_NODE);
  const identity = akashIdentityPresent();
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
          ? [`submit SDL for ${source?.image ?? 'image'} to Akash`, 'create lease', 'send manifest', 'wait for readiness']
          : [`[dev-fallback] would deploy ${source?.image ?? 'image'} on Akash`],
        mode: r.ready ? 'live' : 'dev-fallback',
        required_env: requiredEnv,
        present_env: requiredEnv.filter(n => Boolean(process.env[n])),
        warnings: r.ready ? [] : ['AKASH_ENABLED is not true or provider-services CLI is missing; execution is dev-fallback only'],
      };
    },
  };
}
