import { spawnSync } from 'node:child_process';
for (const suite of ['test-subsidies.mts', 'test-vehicles.mts', 'test-refresh.mts', 'test-regions.mts', 'test-pages.mts', 'test-benefit-calculation.mts', 'test-benefit-policy.mts', 'test-local-benefits.mts', 'test-memory.mts']) {
  const result = spawnSync(process.execPath, [...(suite==='test-memory.mts'?['--max-old-space-size=64','--max-semi-space-size=4']:[]),'--expose-gc', '--import', 'tsx', `scripts/${suite}`], {stdio:'inherit'});
  if (result.status !== 0 || result.signal || result.error) process.exit(result.status || 1);
}
