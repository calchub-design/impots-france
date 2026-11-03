// Lance le serveur de jeu (tsx watch) et le client Vite en parallèle.
import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';
const npx = isWin ? 'npx.cmd' : 'npx';
const procs = [
  spawn(npx, ['tsx', 'watch', 'server/index.ts'], { stdio: 'inherit', shell: isWin }),
  spawn(npx, ['vite'], { stdio: 'inherit', shell: isWin }),
];
const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && code !== 0 && stop());
