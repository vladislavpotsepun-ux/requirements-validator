import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDocument } from '../src/review/document.js';
import { textPdf } from './fixtures.js';

test('retains identifiers, table rows and source line ranges in Markdown', async () => {
  const input = [
    '# Payment alerts', '', '## Acceptance', '',
    '* **Ф-1.** Send an alert at the threshold.', '',
    '| Event | Result |', '| --- | --- |', '| Refund | Decrease total |',
  ].join('\n');
  const source = await loadDocument('requirements.md', Buffer.from(input));

  assert.equal(source.title, 'Payment alerts');
  assert.equal(source.format, 'markdown');
  assert.match(source.sha256, /^[a-f0-9]{64}$/);
  const explicit = source.blocks.find((block) => block.originalId === 'Ф-1');
  assert.equal(explicit?.text, '* **Ф-1.** Send an alert at the threshold.');
  assert.deepEqual(explicit?.location, { section: ['Payment alerts', 'Acceptance'], startLine: 5, endLine: 5 });
  const row = source.blocks.find((block) => block.text === '| Refund | Decrease total |');
  assert.equal(row?.kind, 'table');
  assert.equal(row?.location.startLine, 9);
});

test('reads text PDFs, keeping page numbers and cells on the same row', async () => {
  const input = textPdf([
    [['First page', 45, 780], ['Event', 45, 740], ['Result', 260, 740]],
    [['FR-2. Reject an expired token.', 45, 780]],
  ]);
  const source = await loadDocument('requirements.pdf', input);

  assert.equal(source.format, 'pdf');
  assert.ok(source.blocks.some((block) => /Event\s+\|\s+Result/.test(block.text) && block.location.page === 1));
  assert.ok(source.blocks.some((block) => block.originalId === 'FR-2' && block.location.page === 2));
});

test('preserves a table ID and a heading ID on their requirement text', async () => {
  const input = [
    '# Alert rules', '', '| ID | Requirement |', '| --- | --- |', '| FR-1 | Send the alert once. |',
    '', '## FR-2. Expiration', '', 'Discard every alert older than one hour.',
  ].join('\n');
  const source = await loadDocument('requirements.md', Buffer.from(input));
  assert.equal(source.blocks.find(({ text }) => text.includes('Send the alert'))?.originalId, 'FR-1');
  assert.equal(source.blocks.find(({ text }) => text.startsWith('Discard every'))?.originalId, 'FR-2');
});

test('rejects a PDF with no text layer instead of reviewing an empty document', async () => {
  await assert.rejects(loadDocument('scan.pdf', textPdf([[]])), { code: 'NO_TEXT' });
});

test('identifies unreadable pages of a partially text-based PDF', async () => {
  const source = await loadDocument('mixed.pdf', textPdf([[['FR-1. Alert after a failed login.', 45, 780]], []]));
  assert.deepEqual(source.unreadablePages, [2]);
});

test('rejects unsupported formats, malformed UTF-8, and malformed PDFs', async () => {
  await assert.rejects(loadDocument('requirements.docx', Buffer.from('content')), { code: 'UNSUPPORTED_FORMAT' });
  await assert.rejects(loadDocument('requirements.txt', Uint8Array.of(0xc3, 0x28)), { code: 'INVALID_DOCUMENT' });
  await assert.rejects(
    loadDocument('requirements.pdf', Buffer.from('%PDF-1.7\ntruncated')),
    { code: 'INVALID_DOCUMENT' },
  );
});
