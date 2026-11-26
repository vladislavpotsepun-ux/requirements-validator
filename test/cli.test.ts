import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

test('refuses an output path that refers to the input through a filesystem alias', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-cli-'));
  t.after(() => rm(directory, { recursive: true }));
  const original = join(directory, 'source.md');
  const alias = join(directory, 'alias.md');
  const contents = 'FR-1. Notify the owner after a successful deposit.';
  await writeFile(original, contents);
  await symlink(original, alias);

  const invoke = promisify(execFile);
  await assert.rejects(
    invoke(process.execPath, ['--import', 'tsx', 'src/cli.ts', alias, original]),
    /INVALID_DOCUMENT:.*different files/u,
  );
  assert.equal(await readFile(original, 'utf-8'), contents);
});

test('accepts an independent report path and permits the default PDF path', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-cli-'));
  t.after(() => rm(directory, { recursive: true }));
  const invoke = promisify(execFile);

  for (const paths of [['source.pdf', 'review.markdown'], ['source.txt', 'review.pdf'], ['source.md']]) {
    await assert.rejects(
      invoke(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...paths.map((path) => join(directory, path))]),
      /File or environment error \(ENOENT\)/u,
    );
  }
  await assert.rejects(
    invoke(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'source.md', 'review.json']),
    /UNSUPPORTED_FORMAT:.*output path/u,
  );
});

test('protects a file at the implicit report path', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'review-cli-'));
  t.after(() => rm(directory, { recursive: true }));
  const input = join(directory, 'requirements.md');
  const output = join(directory, 'requirements-report.pdf');
  await writeFile(input, 'FR-1. Notify the owner after a successful deposit.');
  await writeFile(output, 'An existing report');

  const invoke = promisify(execFile);
  await assert.rejects(
    invoke(process.execPath, ['--import', 'tsx', 'src/cli.ts', input]),
    /The default report already exists/u,
  );
  assert.equal(await readFile(output, 'utf-8'), 'An existing report');
});
