import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDocument } from '../src/review/document.js';
import { renderReportFile } from '../src/review/report-file.js';
import {
  formatClarifyingQuestionsText, groupClarifyingQuestions, renderMarkdown,
} from '../src/review/report.js';
import type { ReviewReport } from '../src/review/types.js';

const report: ReviewReport = {
  run: {
    documentName: 'расходы.PDF',
    documentTitle: 'Лимит по карте',
    documentFormat: 'pdf',
    date: '2026-11-25T00:00:00Z',
    sha256: 'abc',
    model: 'test-model',
    provider: 'Local',
    version: 'test-version',
  },
  summary: { requirements: 1, defects: 0, blockingDefects: 0, risks: 0, questions: 0 },
  readiness: { development: 'ready', testing: 'ready' },
  unreadablePages: [],
  requirements: [{
    id: 'REQ-001',
    originalId: 'Ф-1',
    kind: 'functional',
    summary: 'Уведомление о расходах',
    source: {
      blockId: 'B0001',
      quote: 'Порог 1 000 ₸ → push.',
      location: { section: [], page: 2, startLine: 4, endLine: 4 },
    },
    feasibility: 'feasible',
    testReadiness: 'ready',
    findingIds: [],
  }],
  findings: [],
};

test('preserves Cyrillic and currency symbols as text in the generated PDF', async () => {
  const file = await renderReportFile(report);
  assert.equal(file.name, 'расходы-report.pdf');
  assert.equal(file.contentType, 'application/pdf');
  const document = await loadDocument(file.name, file.bytes);

  assert.equal(document.title, 'Отчёт о проверке требований');
  assert.ok(document.blocks.some(({ text }) => text.includes('Порог 1 000 ₸ → push.')));
});

test('links the PDF contents and bookmarks to a section destination', async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const file = await renderReportFile(report);
  const task = getDocument({ data: Uint8Array.from(file.bytes), verbosity: 0 });
  try {
    const pdf = await task.promise;
    const outline = await pdf.getOutline();
    const finalSection = outline?.find(({ title }) => title === 'Итог и порядок исправлений');
    const destination = await pdf.getDestination('report-conclusion');
    assert.ok(finalSection?.dest && destination);
    assert.equal(await pdf.getPageIndex(destination[0]), await pdf.getPageIndex(finalSection.dest[0]));
    assert.equal((finalSection.dest[1] as { name: string }).name, 'XYZ');
    assert.equal(finalSection.dest[3], destination[3]);

    const page = await pdf.getPage(1);
    const text = (await page.getTextContent()).items.flatMap((item) => 'str' in item ? [item.str] : []).join('\n');
    assert.match(text, /Паспорт прогона[\s\S]*Дата и время[\s\S]*Оглавление[\s\S]*Сводка[\s\S]*Разработку/u);
    const links = (await page.getAnnotations()).filter(({ subtype }) => subtype === 'Link');
    assert.ok(links.some(({ dest }) => dest === 'report-conclusion'));
  } finally {
    await task.destroy();
  }
});

test('preserves source locations that are too tall for a PDF table row', async () => {
  const review = structuredClone(report);
  review.requirements[0]!.source.location.section = [
    ...Array.from({ length: 6 }, () => 'Обязательное правило '.repeat(14)),
    'Конец исходной ссылки',
  ];
  const file = await renderReportFile(review);
  const document = await loadDocument(file.name, file.bytes);
  const text = document.blocks.map((block) => block.text).join(' ').replace(/\s+/gu, ' ');

  assert.match(text, /Конец исходной ссылки/u);
  assert.match(text, /Порог 1 000 ₸ → push\./u);
});

test('downloads Markdown even when the source document is PDF', async () => {
  const file = await renderReportFile(report, 'markdown');
  assert.equal(file.name, 'расходы-report.md');
  assert.equal(file.contentType, 'text/markdown; charset=utf-8');
  assert.match(file.bytes.toString('utf8'), /## Паспорт прогона[\s\S]*\| REQ-001 \| Ф-1 \|/u);
});

test('links every Markdown contents entry to a report section', () => {
  const markdown = renderMarkdown(report);
  const headings = Array.from(markdown.matchAll(/^## (.+)$/gmu), ([, title]) => title);
  assert.deepEqual(headings.slice(0, 3), ['Паспорт прогона', 'Оглавление', 'Сводка']);
  const contents = markdown.match(/## Оглавление\n\n([^\n]+(?:\n- [^\n]+)*)/u)?.[1] ?? '';
  const links = [...contents.matchAll(/\]\(#([\w-]+)\)/gu)];
  assert.ok(links.length >= 6);
  assert.deepEqual(links.slice(0, 2).map(([, anchor]) => anchor), ['report-run', 'report-summary']);
  for (const [, anchor] of links) {
    assert.ok(markdown.includes(`<a name="${anchor}"></a>`), anchor);
  }
});

test('renders TXT as plain text with requirement evidence', async () => {
  const file = await renderReportFile(report, 'text');
  assert.equal(file.name, 'расходы-report.txt');
  assert.equal(file.contentType, 'text/plain; charset=utf-8');
  const text = file.bytes.toString('utf8');
  assert.match(text, /^Отчёт о проверке требований/u);
  assert.doesNotMatch(text, /^#{1,3} |^\|/mu);
  assert.match(text, /\nПаспорт прогона\n[\s\S]*\nОглавление\n[\s\S]*\nСводка\n\nРазработку и тестирование/u);
  assert.match(text, /REQ-001[\s\S]*Ф-1[\s\S]*Порог 1 000 ₸ → push\./u);
});

test('renders fintech mode metadata, suggested rewrites, and groups clarifying questions by stakeholder', async () => {
  const fintechReport: ReviewReport = {
    ...structuredClone(report),
    run: { ...report.run, mode: 'fintech' },
    summary: { requirements: 1, defects: 1, blockingDefects: 1, risks: 1, questions: 0 },
    readiness: { development: 'blocked', testing: 'blocked' },
    findings: [
      {
        id: 'F-001',
        scope: 'individual',
        criterion: 'unambiguity',
        kind: 'defect',
        severity: 'blocker',
        affects: 'both',
        owner: 'product',
        description: 'Не указан способ округления суммы порога.',
        impact: 'Порог может срабатывать по-разному.',
        action: 'Зафиксировать правило округления.',
        suggestedRewrite: 'Порог 1 000,00 ₸ округляется по правилу half-even (банковское округление).',
        clarifyingQuestion: 'Какое правило округления применять к суммам в тиынах?',
        requirementIds: ['REQ-001'],
        evidence: [{
          blockId: 'B0001',
          quote: 'Порог 1 000 ₸ → push.',
          location: { section: [], page: 2, startLine: 4, endLine: 4 },
        }],
      },
      {
        id: 'F-002',
        scope: 'set',
        criterion: 'completeness',
        kind: 'risk',
        severity: 'major',
        affects: 'development',
        owner: 'security',
        description: 'Не заданы правила маскирования номера карты в push-уведомлении.',
        impact: 'Утечка PAN в журнал уведомлений.',
        action: 'Указать формат маскирования карты.',
        clarifyingQuestion: 'Допустимо ли выводить последние 4 цифры PAN в тексте push-уведомления?',
        requirementIds: ['REQ-001'],
        evidence: [{
          blockId: 'B0001',
          quote: 'Порог 1 000 ₸ → push.',
          location: { section: [], page: 2, startLine: 4, endLine: 4 },
        }],
      },
    ],
  };

  const markdown = renderMarkdown(fintechReport);
  assert.match(markdown, /Режим проверки — FinTech \/ Banking аудит/u);
  assert.match(markdown, /Предлагаемая формулировка — «Порог 1 000,00 ₸/u);
  assert.match(markdown, /Вопрос автору — Какое правило округления/u);

  const groups = groupClarifyingQuestions(fintechReport.findings);
  assert.deepEqual(groups.map(({ role }) => role), ['product', 'security']);
  const text = formatClarifyingQuestionsText(groups, fintechReport.run.documentTitle);
  assert.match(text, /Продукт \/ БА:/u);
  assert.match(text, /Безопасность:/u);
  assert.match(text, /\[F-001 \(REQ-001\)\]/u);

  const pdf = await renderReportFile(fintechReport, 'pdf');
  const parsed = await loadDocument(pdf.name, pdf.bytes);
  assert.ok(parsed.blocks.some(({ text: blockText }) => blockText.includes('FinTech / Banking аудит')));
});

