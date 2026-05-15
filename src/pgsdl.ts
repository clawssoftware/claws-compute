// SDL generator for Akash Postgres deployments (one DB per deployment).

import { yamlDoubleQuoted } from './sdl.js';

export type DbSize = 'xsmall' | 'small' | 'medium' | 'large';

export interface PostgresSDLParams {
  name: string;
  size?: DbSize;
  version?: string;
  image?: string;
  superuser: string;
  password: string;
  database?: string;
  priceCapUact?: number;
}

const MOULTRIE_AUDITOR = 'akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63';

export const DB_RESOURCES: Record<DbSize, { cpu: string; memory: string; storage: string; price: number }> = {
  xsmall: { cpu: '0.5', memory: '1Gi', storage: '5Gi', price: 1000 },
  small: { cpu: '1', memory: '2Gi', storage: '20Gi', price: 2000 },
  medium: { cpu: '2', memory: '4Gi', storage: '50Gi', price: 5000 },
  large: { cpu: '4', memory: '8Gi', storage: '200Gi', price: 15000 },
};

export function generatePostgresSDL(p: PostgresSDLParams): string {
  const size = p.size ?? 'small';
  const version = p.version ?? '16';
  const image = p.image ?? `postgres:${version}-alpine`;
  const database = p.database ?? 'app';
  const res = DB_RESOURCES[size];
  const priceCapUact = p.priceCapUact ?? res.price;
  const svc = p.name;
  const userQ = yamlDoubleQuoted(p.superuser);
  const passQ = yamlDoubleQuoted(p.password);
  const dbQ = yamlDoubleQuoted(database);

  return `---
version: "2.0"

services:
  ${svc}:
    image: ${image}
    expose:
      - port: 5432
        as: 5432
        to:
          - global: true
    env:
      - POSTGRES_USER=${userQ}
      - POSTGRES_PASSWORD=${passQ}
      - POSTGRES_DB=${dbQ}
      - PGDATA=/var/lib/postgresql/data/pgdata
    params:
      storage:
        data:
          mount: /var/lib/postgresql/data

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
              persistent: true
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
