import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, sep } from 'node:path';
import { ReviewError } from './errors.js';
import type { BlockKind, SourceBlock, SourceDocument, SourceFormat } from './types.js';

export const limits = {
  bytes: 10 * 1024 * 1024,
  pages: 50,
  characters: 48_000,
} as const;

const formats = new Map<string, SourceFormat>([
  ['.pdf', 'pdf'], ['.md', 'markdown'], ['.markdown', 'markdown'], ['.txt', 'text'],
]);
const requirementsId =
  /^\s*(?:(?:[-+*]|\d+[.)])\s+)?[*_`]{0,3}(\p{L}[\p{L}\d]{0,11}[-‐‑–]\d+(?:[.-]\d+)*)(?=[\s.:)\]*_`]|$)/u;
const markdownHeading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u;
const listItem = /^\s*(?:[-+*]|\d+[.)])\s+\S/u;
const fenceStart = /^\s*(`{3,}|~{3,})/u;
const tableSeparator = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u;
const divider = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/u;
const blockLimit = 1400;

export async function loadDocument(fileName: string, bytes: Uint8Array): Promise<SourceDocument> {
  const name = basename(fileName);
  const format = formats.get(extname(name).toLowerCase());
  if (!format) {
    throw new ReviewError('UNSUPPORTED_FORMAT', 'Choose a PDF, Markdown, or TXT document.');
  }
  if (bytes.byteLength > limits.bytes) {
    throw new ReviewError('LIMIT_EXCEEDED', 'The input file exceeds 10 MiB.');
  }

  const { pages, title } = format === 'pdf' ? await readPdf(bytes) : {
    pages: [readText(bytes)],
    title: null,
  };
  if (pages.reduce((total, page) => total + page.length, 0) > limits.characters) {
    throw new ReviewError('LIMIT_EXCEEDED', 'The input exceeds 48,000 extracted characters.');
  }
  const unreadablePages = format === 'pdf'
    ? pages.flatMap((page, index) => page.trim() ? [] : [index + 1])
    : [];
  const blocks = pages.flatMap((page, index) => splitBlocks(page, format === 'pdf' ? index + 1 : undefined))
    .map((block, index) => ({ ...block, id: `B${String(index + 1).padStart(4, '0')}` }));
  if (!blocks.some(({ kind }) => kind !== 'heading')) {
    throw new ReviewError('NO_TEXT', 'No reviewable text was found. A scanned PDF needs a text layer.');
  }
  return {
    name,
    title: title || blocks.find(({ kind }) => kind === 'heading')?.text || name,
    format,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    blocks,
    unreadablePages,
  };
}

function readText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/gu, '\n');
  } catch {
    throw new ReviewError('INVALID_DOCUMENT', 'Text documents must be encoded in UTF-8.');
  }
}

async function readPdf(bytes: Uint8Array): Promise<{ pages: string[]; title: string | null }> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const packageDirectory = dirname(require.resolve('pdfjs-dist/package.json'));
  const task = getDocument({
    data: Uint8Array.from(bytes),
    cMapUrl: join(packageDirectory, 'cmaps') + sep,
    cMapPacked: true,
    standardFontDataUrl: join(packageDirectory, 'standard_fonts') + sep,
    useSystemFonts: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > limits.pages) {
      throw new ReviewError('LIMIT_EXCEEDED', 'A PDF may have at most 50 pages.');
    }
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      pages.push(pdfLines(content.items.filter((item) => 'str' in item)));
      page.cleanup();
    }
    const { info } = await pdf.getMetadata();
    const title = (info as { Title?: unknown }).Title;
    return { pages, title: typeof title === 'string' ? title.trim() || null : null };
  } catch (error) {
    if (error instanceof ReviewError) {
      throw error;
    }
    throw new ReviewError('INVALID_DOCUMENT', 'The PDF could not be read. Check whether it opens without a password.');
  } finally {
    await task.destroy();
  }
}

function pdfLines(
  items: { str: string; transform: number[]; width: number; height: number }[],
): string {
  const lines: string[] = [];
  let line = '';
  let baseline = 0;
  let right = 0;
  let previousHeight = 0;

  for (const { str, transform, width, height } of items) {
    if (!str.trim()) {
      continue;
    }
    const x = transform[4] ?? 0;
    const y = transform[5] ?? 0;
    const gap = x - right;
    if (line && (Math.abs(y - baseline) > Math.max(2, previousHeight * 0.24) || gap < -12)) {
      lines.push(line.trim());
      if (Math.abs(y - baseline) > Math.max(14, previousHeight * 1.65)) {
        lines.push('');
      }
      line = '';
    }
    if (line) {
      if (gap >= Math.max(15, previousHeight * 1.25)) {
        line += '  |  ';
      } else if (gap > 1 && !/\s$/u.test(line) && !/^\s/u.test(str)) {
        line += ' ';
      }
    }
    line += str;
    baseline = y;
    right = x + width;
    previousHeight = height || previousHeight;
  }
  if (line.trim()) {
    lines.push(line.trim());
  }
  return lines.join('\n');
}

type UnnumberedBlock = Omit<SourceBlock, 'id'>;

function splitBlocks(page: string, pageNumber?: number): UnnumberedBlock[] {
  const blocks: UnnumberedBlock[] = [];
  const sections: { level: number; title: string }[] = [];
  const lines = page.split('\n');
  let pending: { kind: BlockKind; text: string; start: number; end: number } | undefined;
  let fence: string | undefined;
  let markedHeading: UnnumberedBlock | undefined;

  const add = (kind: BlockKind, text: string, start: number, end: number) => {
    for (const part of splitLongBlock(text)) {
      const candidate = kind === 'table' ? part.replace(/^\s*\|\s*/u, '') : part;
      const block: UnnumberedBlock = {
        kind,
        text: part,
        originalId: requirementsId.exec(candidate)?.[1] ?? null,
        location: {
          section: sections.map(({ title }) => title),
          startLine: start,
          endLine: end,
          ...(pageNumber === undefined ? {} : { page: pageNumber }),
        },
      };
      if (kind === 'heading' && block.originalId) {
        markedHeading = block;
      } else if (markedHeading && kind !== 'heading') {
        block.originalId ??= markedHeading.originalId;
        markedHeading.originalId = null;
        markedHeading = undefined;
      }
      blocks.push(block);
    }
  };
  const closeMarkedHeading = () => {
    if (markedHeading) {
      markedHeading.kind = 'list';
      markedHeading = undefined;
    }
  };
  const flush = () => {
    if (pending) {
      add(pending.kind, pending.text, pending.start, pending.end);
      pending = undefined;
    }
  };

  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    const marker = fenceStart.exec(line)?.[1];
    if (fence && pending) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
        flush();
        fence = undefined;
      } else {
        pending.text += `\n${line}`;
        pending.end = number;
      }
      continue;
    }
    if (marker) {
      flush();
      fence = marker;
      pending = { kind: 'code', text: '', start: number + 1, end: number };
      continue;
    }
    if (!line.trim() || divider.test(line) || tableSeparator.test(line)) {
      flush();
      continue;
    }
    const heading = markdownHeading.exec(line);
    if (heading?.[1] && heading[2]) {
      flush();
      closeMarkedHeading();
      while (sections.at(-1) && sections.at(-1)!.level >= heading[1].length) {
        sections.pop();
      }
      sections.push({ level: heading[1].length, title: heading[2] });
      add('heading', heading[2], number, number);
      continue;
    }
    if (/^\s*\|.*\|\s*$/u.test(line) || line.includes('  |  ')) {
      flush();
      add('table', line.trim(), number, number);
      continue;
    }
    if (listItem.test(line) || requirementsId.test(line)) {
      flush();
      pending = { kind: 'list', text: line.trim(), start: number, end: number };
      continue;
    }
    if (pending && (pending.kind === 'paragraph' || pageNumber !== undefined || /^\s{2,}/u.test(line))) {
      pending.text += `\n${line.trim()}`;
      pending.end = number;
      continue;
    }
    flush();
    pending = { kind: 'paragraph', text: line.trim(), start: number, end: number };
  }
  flush();
  closeMarkedHeading();
  return blocks;
}

function splitLongBlock(text: string): string[] {
  if (!text.trim()) {
    return [];
  }
  const result = [];
  let remaining = text.trim();
  while (remaining.length > blockLimit) {
    const prefix = remaining.slice(0, blockLimit);
    const boundary = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('\n'));
    const end = boundary > blockLimit / 2 ? boundary : blockLimit;
    result.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  return [...result, remaining];
}
