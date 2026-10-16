import { spawnSync } from 'node:child_process';

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(command, ['--filter', '@workspace/comptaorion-lite', 'run', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production', PORT: '8787', BASE_PATH: '/' },
});
process.exit(result.status ?? 1);
