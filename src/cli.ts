import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { link, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { agentVersion, loadEnvironment } from './config.js';
import { createReviewModel } from './model/provider.js';
import { limits, loadDocument } from './review/document.js';
import { ReviewError } from './review/errors.js';
import { analyzeDocument } from './review/pipeline.js';
import { renderReportFile } from './review/report-file.js';
import { defaultReportFormat, reportFileName, reportFormatOptions, reportFormats } from './review/report-formats.js';
import type { ReviewMode } from './review/types.js';

async function run() {
  const args = process.argv.slice(2);
  const usage = 'Usage: npm run review -- [--fintech] <requirements.pdf|.md|.markdown|.txt> [report.pdf|.md|.markdown|.txt]';
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return;
  }
  let fintechFlag = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === '--fintech') {
      fintechFlag = true;
    } else if (arg.startsWith('--')) {
      throw new ReviewError('INVALID_DOCUMENT', usage);
    } else {
      positional.push(arg);
    }
  }
  const [input, reportPath] = positional;
  if (!input || positional.length > 2) {
    throw new ReviewError('INVALID_DOCUMENT', usage);
  }
  const replaceExisting = reportPath !== undefined;
  const output = reportPath ?? join(dirname(input), reportFileName(basename(input), defaultReportFormat));
  const extension = extname(output).toLowerCase();
  const format = extension === '.markdown'
    ? 'markdown'
    : reportFormatOptions.find((candidate) => reportFormats[candidate].extension === extension);
  if (!format) {
    throw new ReviewError('UNSUPPORTED_FORMAT', 'Choose a PDF, Markdown, or TXT output path.');
  }
  if (resolve(input) === resolve(output)) {
    throw new ReviewError('INVALID_DOCUMENT', 'The input document and output report must be different files.');
  }

  loadEnvironment();
  const mode: ReviewMode = fintechFlag || process.env.REVIEW_MODE?.trim().toLowerCase() === 'fintech'
    ? 'fintech'
    : 'standard';
  const size = await stat(input);
  if (!size.isFile() || size.size > limits.bytes) {
    throw new ReviewError('LIMIT_EXCEEDED', 'Choose a regular input file of at most 10 MiB.');
  }
  await checkOutputPath(size, output, replaceExisting);
  const source = await loadDocument(input, await readFile(input));
  const model = createReviewModel();
  const phaseLabels = {
    extract: 'Extracting requirements',
    individual: 'Reviewing requirements',
    set: 'Reviewing the set',
  };
  const report = await analyzeDocument(source, model, {
    version: agentVersion(),
    mode,
    onProgress: ({ phase, completed, total }) => console.error(`${phaseLabels[phase]} (${completed + 1}/${total})`),
  });
  const { bytes } = await renderReportFile(report, format);
  await saveReport(output, bytes, size, replaceExisting);
  console.log(`Report written to ${output}`);
}

async function checkOutputPath(source: Stats, output: string, replaceExisting: boolean) {
  try {
    const destination = await (replaceExisting ? stat(output) : lstat(output));
    if (!replaceExisting) {
      throw new ReviewError('INVALID_DOCUMENT', 'The default report already exists. Specify a different output path.');
    }
    if (source.dev === destination.dev && source.ino === destination.ino) {
      throw new ReviewError('INVALID_DOCUMENT', 'The input document and output report must be different files.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

async function saveReport(output: string, content: Uint8Array, source: Stats, replaceExisting: boolean) {
  const directory = dirname(output);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    if (replaceExisting) {
      await checkOutputPath(source, output, true);
      await rename(temporary, output);
    } else {
      await link(temporary, output);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

run().catch((error: unknown) => {
  if (error instanceof ReviewError) {
    console.error(`${error.code}: ${error.message}`);
  } else if (error instanceof Error && 'code' in error) {
    console.error(`File or environment error (${String(error.code)}).`);
  } else {
    console.error('The review could not be completed.');
  }
  process.exitCode = 1;
});
