import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCellSDL, CELL_IMAGE_DEFAULT } from './sdl.js';

test('generateCellSDL includes cell image, ports, env, and storage mount', () => {
  const sdl = generateCellSDL({
    name: 'cell-0001',
    tier: 'large',
    clawsApiUrl: 'https://api.example.com',
    cellAgentSecret: 's3cr3t"\\n',
  });
  assert.match(sdl, new RegExp(`image:\\s*${CELL_IMAGE_DEFAULT.replace(/\//g, '\\/')}`));
  assert.match(sdl, /port:\s*8081/);
  assert.match(sdl, /port:\s*80/);
  assert.match(sdl, /port:\s*443/);
  assert.match(sdl, /CELL_ID=cell-0001/);
  assert.match(sdl, /CLAWS_API_URL=/);
  assert.match(sdl, /CELL_AGENT_SECRET=/);
  assert.match(sdl, /mount:\s*\/var\/lib\/rancher\/k3s/);
  assert.match(sdl, /privileged:\s*true/);
});
