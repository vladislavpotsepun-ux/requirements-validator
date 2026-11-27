import { execFileSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';

export function loadEnvironment() {
  for (const file of ['.env.local', '.env']) {
    try {
      loadEnvFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

export function agentVersion(): string {
  const deployedVersion = process.env.AGENT_VERSION?.trim();
  if (deployedVersion) {
    return deployedVersion;
  }
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 1000,
    }).trim();
  } catch {
    return 'v1.2.0';
  }
}
