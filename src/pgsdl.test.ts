import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePostgresSDL } from './pgsdl.js';

test('generatePostgresSDL small tier exposes port 5432 and postgres env', () => {
  const sdl = generatePostgresSDL({
    name: 'db-7f3a',
    size: 'small',
    version: '16',
    superuser: 'u_abcd1234',
    password: 'p@ss"w\\ord',
    database: 'app',
  });
  assert.match(sdl, /image:\s*postgres:16-alpine/);
  assert.match(sdl, /port:\s*5432/);
  assert.match(sdl, /POSTGRES_USER=/);
  assert.match(sdl, /POSTGRES_PASSWORD=/);
  assert.match(sdl, /POSTGRES_DB=/);
  assert.match(sdl, /PGDATA=\/var\/lib\/postgresql\/data\/pgdata/);
  assert.match(sdl, /size:\s*20Gi/);
  assert.match(sdl, /persistent:\s*true/);
  assert.match(sdl, /amount:\s*2000/);
});
