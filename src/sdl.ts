// SDL generator for Akash cell deployments.

type CellTier = 'large' | 'medium' | 'small';

/** Default cell image (k3s + cell-agent); override via `CELL_IMAGE` env or SDL `image` param. */
export const CELL_IMAGE_DEFAULT =
  process.env.CELL_IMAGE?.trim() || 'ghcr.io/clawssoftware/claws-cell:latest';

export interface CellSDLParams {
  name: string; // e.g. "cell-0001" — used as service name throughout SDL
  tier?: CellTier; // cell size tier; defaults to 'large'
  image?: string; // Docker image; defaults to CELL_IMAGE_DEFAULT
  port?: number; // legacy single-port SDL (unused for cell image; cell-agent uses 8081 in-container)
  priceCapUact?: number; // max we'll pay per block in uact; overrides tier default
  clawsApiUrl: string;
  cellAgentSecret: string;
}

// Moultrie Audits — the active community auditor for Akash providers
const MOULTRIE_AUDITOR = 'akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63';

const TIER_RESOURCES: Record<CellTier, { cpu: string; memory: string; storage: string }> = {
  large: { cpu: '20', memory: '40Gi', storage: '100Gi' },
  medium: { cpu: '10', memory: '20Gi', storage: '50Gi' },
  small: { cpu: '4', memory: '8Gi', storage: '20Gi' },
};

// Price cap in uact/block, scaled roughly proportional to resources.
const TIER_PRICE_CAP_UACT: Record<CellTier, number> = {
  large: 50000,
  medium: 25000,
  small: 10000,
};

export function yamlDoubleQuoted(s: string): string {
  return JSON.stringify(s);
}

export function generateCellSDL(params: CellSDLParams): string {
  const {
    name,
    tier = 'large',
    image = CELL_IMAGE_DEFAULT,
    clawsApiUrl,
    cellAgentSecret,
  } = params;

  const priceCapUact = params.priceCapUact ?? TIER_PRICE_CAP_UACT[tier];
  const res = TIER_RESOURCES[tier];
  const svc = name;
  const cellImage = image;
  const clawsQ = yamlDoubleQuoted(clawsApiUrl);
  const secretQ = yamlDoubleQuoted(cellAgentSecret);

  return `---
version: "2.0"

services:
  ${svc}:
    image: ${cellImage}
    expose:
      - port: 8081
        as: 8081
        to:
          - global: true
      - port: 80
        as: 80
        to:
          - global: true
      - port: 443
        as: 443
        to:
          - global: true
    env:
      - CELL_ID=${name}
      - CLAWS_API_URL=${clawsQ}
      - CELL_AGENT_SECRET=${secretQ}
    params:
      privileged: true
      storage:
        data:
          mount: /var/lib/rancher/k3s

profiles:
  compute:
    ${svc}:
      resources:
        cpu:
          units: ${res.cpu}
        memory:
          size: ${res.memory}
        storage:
          - size: ${res.storage}
            name: data
            attributes:
              persistent: false
  placement:
    dcloud:
      attributes:
        host: akash
      signedBy:
        anyOf:
          - "${MOULTRIE_AUDITOR}"
      pricing:
        ${svc}:
          denom: uact
          amount: ${priceCapUact}

deployment:
  ${svc}:
    dcloud:
      profile: ${svc}
      count: 1
`;
}

// Minimal SDL for end-to-end testing: xsmall resources, hello-world image.
// Same structure and naming convention as production cells.
export function generateTestCellSDL(name: string): string {
  const svc = name;
  return `---
version: "2.0"

services:
  ${svc}:
    image: ghcr.io/akash-network/hello-akash-world:0.2.0
    expose:
      - port: 8080
        as: 80
        to:
          - global: true
    env:
      - CELL_ID=${name}

profiles:
  compute:
    ${svc}:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 512Mi
        storage:
          - size: 512Mi

  placement:
    dcloud:
      attributes:
        host: akash
      signedBy:
        anyOf:
          - "${MOULTRIE_AUDITOR}"
      pricing:
        ${svc}:
          denom: uact
          amount: 10000

deployment:
  ${svc}:
    dcloud:
      profile: ${svc}
      count: 1
`;
}
