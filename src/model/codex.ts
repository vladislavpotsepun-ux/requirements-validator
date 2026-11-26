import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewError } from '../review/errors.js';
import type { ReviewModel } from '../review/types.js';

const unavailableMessage = 'Codex CLI did not complete the request. Check sign-in and quota.';

export function codexModel(model: string): ReviewModel {
  return {
    provider: 'Codex CLI',
    model,
    async generate({ instructions, data, schema, signal }) {
      const directory = await mkdtemp(join(tmpdir(), 'requirements-validator-model-'));
      try {
        const schemaPath = join(directory, 'schema.json');
        const answerPath = join(directory, 'answer.json');
        await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
        const args = [
          '--ask-for-approval', 'never',
          '--disable', 'shell_tool',
          '--disable', 'plugins',
          '--disable', 'multi_agent',
          '--disable', 'multi_agent_v2',
          '--config', 'web_search="disabled"',
          '--config', 'model_reasoning_effort="medium"',
          'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
          '--sandbox', 'read-only', '--cd', directory, `--model=${model}`,
          '--color', 'never', '--output-schema', schemaPath, '--output-last-message', answerPath, '-',
        ];
        const prompt = `Do not use tools. Return the structured response only.\n${instructions}\nData JSON:\n`
          + JSON.stringify(data);
        const timeout = AbortSignal.timeout(210_000);
        await runCli(args, prompt, signal ? AbortSignal.any([signal, timeout]) : timeout);
        return await parseAnswer(answerPath);
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof ReviewError) {
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ReviewError('MODEL_CONFIG', 'Install Codex CLI and sign in before using the codex provider.');
        }
        throw new ReviewError('MODEL_UNAVAILABLE', unavailableMessage);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

function runCli(args: string[], prompt: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = spawn('codex', args, { signal, stdio: ['pipe', 'ignore', 'ignore'] });
    client.once('error', reject);
    client.stdin.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') {
        reject(error);
      }
    });
    client.once('close', (status) => {
      if (status === 0) {
        resolve();
      } else {
        reject(new ReviewError('MODEL_UNAVAILABLE', unavailableMessage));
      }
    });
    client.stdin.end(prompt, 'utf-8');
  });
}

async function parseAnswer(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    throw new ReviewError('INVALID_MODEL_OUTPUT', 'Codex CLI did not write a JSON response.');
  }
}
