import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDocument } from '../src/review/document.js';
import { analyzeDocument } from '../src/review/pipeline.js';
import { renderMarkdown } from '../src/review/report.js';
import type { ReviewModel } from '../src/review/types.js';

const documentText = [
  '# Alert rules', '', '## Functional requirements', '',
  'FR-1. Send at most one alert in a month.',
  'FR-2. After a threshold change, send another alert in the same month.',
  '', '## Test plan', '', 'To be completed.',
].join('\n');

const extraction = {
  requirements: [
    {
      candidateId: 'B0003.1',
      summary: 'Лимит одного уведомления', kind: 'functional',
    },
    {
      candidateId: 'B0004.1',
      summary: 'Повторное уведомление', kind: 'functional',
    },
  ],
};

const individual = {
  reviews: [
    { id: 'REQ-001', feasibility: 'feasible', testReadiness: 'ready', findings: [] },
    { id: 'REQ-002', feasibility: 'feasible', testReadiness: 'ready', findings: [] },
  ],
};

const conflictingRules = {
  criterion: 'consistency', kind: 'defect', severity: 'blocker', affects: 'both', evidence: ['B0003', 'B0004'],
  description: 'У правил разные ограничения на число уведомлений за месяц. '
    + 'Первое правило запрещает повторные уведомления в том же месяце при любых условиях. '
    + 'Во втором правиле изменение порога прямо названо основанием для ещё одного уведомления.',
  impact: 'Реализация и проверка дадут разные результаты после изменения порога.',
  action: 'Определить, действует ли месячный лимит после изменения порога.',
};

const modelWith = (
  extractionResponse: unknown = extraction,
  itemResponse: unknown = individual,
  setResponse: unknown = { findings: [conflictingRules] },
): ReviewModel => ({
  provider: 'Local', model: 'test-model',
  async generate({ phase }) {
    if (phase === 'extract') return extractionResponse;
    if (phase === 'individual') return itemResponse;
    return setResponse;
  },
});

const run = { version: 'v1.0.0', date: new Date('2026-11-25T00:00:00Z') };

test('reports every extracted requirement and grounds a set contradiction in both source lines', async () => {
  const document = await loadDocument('alerts.md', Buffer.from(documentText));
  const report = await analyzeDocument(document, modelWith(), run);

  assert.deepEqual(report.requirements.map(({ id, originalId }) => [id, originalId]), [
    ['REQ-001', 'FR-1'], ['REQ-002', 'FR-2'],
  ]);
  assert.equal(report.findings.length, 1);
  const [finding] = report.findings;
  assert.deepEqual(finding?.evidence.map(({ location }) => location.startLine), [5, 6]);
  assert.deepEqual(finding?.requirementIds, ['REQ-001', 'REQ-002']);
  assert.equal(report.summary.defects, 1);
  assert.equal(report.summary.blockingDefects, 1);
  assert.deepEqual(report.readiness, { development: 'blocked', testing: 'blocked' });
  assert.equal(report.run.version, 'v1.0.0');
  assert.equal(report.run.model, 'test-model');
  assert.equal(report.requirements[0]?.source.quote, 'Send at most one alert in a month.');
  const markdown = renderMarkdown(report);
  assert.match(markdown, /Паспорт прогона[\s\S]*FR-1[\s\S]*У правил разные ограничения/);
  const overview = markdown.match(/## Сводка\n\n([^\n]+)/u)?.[1] ?? '';
  assert.match(overview, /Разработку и тестирование.*блокирующ/u);
  assert.match(overview, /F-001.*У правил разные ограничения.*Определить, действует ли месячный лимит/u);
  assert.doesNotMatch(overview, /Первое правило запрещает/u);
  assert.ok(overview.length <= 450);
});

test('rejects an extraction that skips an explicit requirement identifier', async () => {
  const document = await loadDocument('alerts.md', Buffer.from(documentText));
  await assert.rejects(
    analyzeDocument(document, modelWith({ requirements: extraction.requirements.slice(0, 1) }), run),
    { code: 'INVALID_MODEL_OUTPUT' },
  );
});

test('rejects an invented excerpt identifier or an invented finding reference', async () => {
  const document = await loadDocument('alerts.md', Buffer.from(documentText));
  const badExtraction = {
    requirements: [{ ...extraction.requirements[0], candidateId: 'B0003.99' }, extraction.requirements[1]],
  };
  await assert.rejects(analyzeDocument(document, modelWith(badExtraction), run), { code: 'INVALID_MODEL_OUTPUT' });
  await assert.rejects(
    analyzeDocument(document, modelWith(extraction, individual, {
      findings: [{ ...conflictingRules, evidence: ['B0003', 'B9999'] }],
    }), run),
    { code: 'INVALID_MODEL_OUTPUT' },
  );
});

test('requires two independent source passages for a conflict between requirements', async () => {
  const document = await loadDocument('alerts.md', Buffer.from(documentText));
  await assert.rejects(analyzeDocument(document, modelWith(extraction, individual, {
    findings: [{ ...conflictingRules, evidence: ['B0003', 'B0003'] }],
  }), run), { code: 'INVALID_MODEL_OUTPUT' });
});

test('rejects per-item review that leaves a requirement unevaluated', async () => {
  const document = await loadDocument('alerts.md', Buffer.from(documentText));
  await assert.rejects(
    analyzeDocument(document, modelWith(extraction, { reviews: individual.reviews.slice(0, 1) }), run),
    { code: 'INVALID_MODEL_OUTPUT' },
  );
});

test('requires a blocking defect when the model says an item cannot be tested', async () => {
  const document = await loadDocument('alerts.md', Buffer.from(documentText));
  const model = modelWith(extraction, {
    reviews: [{ ...individual.reviews[0], testReadiness: 'blocked' }, individual.reviews[1]],
  });
  await assert.rejects(analyzeDocument(document, model, run), { code: 'INVALID_MODEL_OUTPUT' });
});

test('distinguishes feasibility unknowns from a defect and from readiness for testing', async () => {
  const document = await loadDocument('alerts.md', Buffer.from(documentText));
  const model = modelWith(extraction, {
    reviews: [
      { ...individual.reviews[0], feasibility: 'unknown' },
      individual.reviews[1],
    ],
  }, {
    findings: [{
      ...conflictingRules,
      criterion: 'feasibility', kind: 'question', severity: 'major', affects: 'development', evidence: ['B0003'],
      description: 'Нужно подтвердить доступность истории уведомлений.',
    }],
  });
  const report = await analyzeDocument(document, model, run);

  assert.equal(report.summary.defects, 0);
  assert.equal(report.summary.questions, 1);
  assert.deepEqual(report.readiness, { development: 'conditional', testing: 'ready' });
  const markdown = renderMarkdown(report);
  assert.match(markdown, /Недостаточно данных/);
  const overview = markdown.match(/## Сводка\n\n([^\n]+)/u)?.[1] ?? '';
  assert.match(overview, /Разработку можно начинать после уточнений\. Тестирование можно начинать\./u);
  assert.match(overview, /выполнимость подтверждена для 1 из 2 требований/u);
});

test('a supported and testable document with no findings passes both readiness gates', async () => {
  const document = await loadDocument('alerts.md', Buffer.from(documentText));
  const report = await analyzeDocument(document, modelWith(extraction, individual, { findings: [] }), run);

  assert.equal(report.summary.defects, 0);
  assert.deepEqual(report.readiness, { development: 'ready', testing: 'ready' });
});

const compoundSource = [
  '# Alert rules', '', 'FR-1. Send an alert quickly. Save the same alert quickly.',
  'FR-2. Do not send alerts after 22:00.',
].join('\n');

const compoundExtraction = {
  requirements: [
    { ...extraction.requirements[0], candidateId: 'B0002.1' },
    { ...extraction.requirements[1], candidateId: 'B0002.2' },
    { ...extraction.requirements[1], candidateId: 'B0003.1' },
  ],
};

const { evidence: _unusedEvidence, ...itemFields } = conflictingRules;
const speedDefect = {
  ...itemFields,
  criterion: 'verifiability', severity: 'major', affects: 'testing',
  description: 'Время выражено словом «быстро».',
};

test('keeps independent findings on two obligations in the same source block', async () => {
  const document = await loadDocument('alerts.md', Buffer.from(compoundSource));
  const model = modelWith(compoundExtraction, {
    reviews: [
      { ...individual.reviews[0], findings: [{ ...speedDefect, action: 'Определить время отправки.' }] },
      { ...individual.reviews[1], findings: [{ ...speedDefect, action: 'Определить время сохранения.' }] },
      { ...individual.reviews[1], id: 'REQ-003' },
    ],
  }, { findings: [] });
  const report = await analyzeDocument(document, model, run);
  assert.deepEqual(report.findings.map(({ requirementIds }) => requirementIds), [['REQ-001'], ['REQ-002']]);
  assert.equal(report.summary.defects, 2);
});

test('keeps a citation at source level when several independent obligations share the cited block', async () => {
  const document = await loadDocument('alerts.md', Buffer.from(compoundSource));
  const report = await analyzeDocument(document, modelWith(compoundExtraction, {
    reviews: [...individual.reviews, { ...individual.reviews[1], id: 'REQ-003' }],
  }, {
    findings: [{ ...conflictingRules, evidence: ['B0002', 'B0003'] }],
  }), run);
  assert.deepEqual(report.findings[0]?.requirementIds, ['REQ-003']);
  assert.deepEqual(report.findings[0]?.evidence.map(({ blockId }) => blockId), ['B0002', 'B0003']);
});

test('rejects different requirements that use the same excerpt instead of silently discarding an item', async () => {
  const document = await loadDocument('alerts.md', Buffer.from(documentText));
  await assert.rejects(
    analyzeDocument(document, modelWith({
      requirements: [...extraction.requirements, { ...extraction.requirements[0], summary: 'Третье правило' }],
    }), run),
    { code: 'INVALID_MODEL_OUTPUT' },
  );
});
