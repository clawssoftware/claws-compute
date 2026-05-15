#!/usr/bin/env tsx
// CLI test harness: deploys a test cell to Akash mainnet.
// Usage: tsx src/deploy-cli.ts [cell-name]
// Example: tsx src/deploy-cli.ts cell-0001

import { deployTestCell } from './deploy.js';

const name = process.argv[2] ?? 'cell-0001';

console.log(`Deploying test cell "${name}" to Akash mainnet...`);
deployTestCell(name)
  .then(result => {
    console.log('\n=== Deployment successful ===');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error('\n=== Deployment failed ===');
    console.error(err.message);
    process.exit(1);
  });
