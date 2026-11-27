import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log([
    'One-command cross-platform launcher (Windows, macOS, Linux):',
    '  node scripts/run.mjs                                 Start the web app (http://127.0.0.1:3000)',
    '  node scripts/run.mjs --review [--fintech] <file>     Run a CLI requirements review',
  ].join('\n'));
  process.exit(0);
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node.js >= 22.13 is required (current: ${process.versions.node}).`);
  process.exit(1);
}

const tsxEntry = join(root, 'node_modules', 'tsx');
if (!existsSync(tsxEntry)) {
  const hasLockfile = existsSync(join(root, 'package-lock.json'));
  const installArgs = hasLockfile
    ? ['ci', '--no-audit', '--no-fund']
    : ['install', '--no-audit', '--no-fund'];
  console.log(`Installing dependencies via npm ${installArgs[0]}...`);
  const installed = spawnSync('npm', installArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (installed.status !== 0) {
    process.exit(installed.status ?? 1);
  }
}

const envPath = join(root, '.env');
const envLocalPath = join(root, '.env.local');
const envExamplePath = join(root, '.env.example');
if (!existsSync(envPath) && !existsSync(envLocalPath) && existsSync(envExamplePath)) {
  copyFileSync(envExamplePath, envPath);
  console.log('Created .env from .env.example. Set GEMINI_API_KEY in .env (or run Ollama locally).');
}

function hasConfiguredKey() {
  if (process.env.GEMINI_API_KEY?.trim() || process.env.LLM_PROVIDER?.trim().toLowerCase() === 'local'
    || process.env.LLM_PROVIDER?.trim().toLowerCase() === 'codex') {
    return true;
  }
  for (const file of [envLocalPath, envPath]) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (/^\s*GEMINI_API_KEY\s*=\s*\S+/mu.test(text)
      || /^\s*LLM_PROVIDER\s*=\s*(?:local|codex)\b/imu.test(text)) {
      return true;
    }
  }
  return false;
}

if (!hasConfiguredKey()) {
  console.log('Hint: set GEMINI_API_KEY in .env (or environment) before starting a review, or run Ollama locally.');
}

const reviewMode = args[0] === '--review';
const childArgs = reviewMode
  ? ['--import', 'tsx', join(root, 'src', 'cli.ts'), ...args.slice(1)]
  : ['--import', 'tsx', join(root, 'src', 'server.ts'), '--dev'];

const childEnv = reviewMode
  ? process.env
  : { ...process.env, HOST: process.env.HOST?.trim() || '127.0.0.1' };

const child = spawn(process.execPath, childArgs, {
  cwd: root,
  stdio: 'inherit',
  env: childEnv,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
