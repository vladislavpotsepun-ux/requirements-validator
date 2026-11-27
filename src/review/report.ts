import type { ReportFormat } from './report-formats.js';
import { criterionLabels, setCriteria } from './rubric.js';
import type { Finding, Location, ReviewMode, ReviewReport, StakeholderRole } from './types.js';

export const readinessLabels = {
  ready: 'Можно начинать',
  conditional: 'Можно после уточнений',
  blocked: 'Есть блокирующие дефекты',
} as const;

export const reviewModeLabels: Record<ReviewMode, string> = {
  standard: 'Стандартная проверка (ISO 29148 / IEEE 830)',
  fintech: 'FinTech / Banking аудит',
};

export const stakeholderOrder: readonly StakeholderRole[] = ['product', 'backend', 'qa', 'security'];

export const stakeholderLabels: Record<StakeholderRole, string> = {
  product: 'Продукт / БА',
  backend: 'Разработка',
  qa: 'Тестирование',
  security: 'Безопасность',
};

export function inferStakeholder(finding: Finding): StakeholderRole {
  if (finding.owner) {
    return finding.owner;
  }
  if (finding.affects === 'testing') {
    return 'qa';
  }
  if (finding.criterion === 'feasibility' || finding.affects === 'development') {
    return 'backend';
  }
  return 'product';
}

export interface StakeholderQuestionItem {
  findingId: string;
  severity: Finding['severity'];
  question: string;
  requirementIds: string[];
  blockIds: string[];
}

export function groupClarifyingQuestions(findings: readonly Finding[]): {
  role: StakeholderRole;
  label: string;
  items: StakeholderQuestionItem[];
}[] {
  const buckets = new Map<StakeholderRole, StakeholderQuestionItem[]>(
    stakeholderOrder.map((role) => [role, []]),
  );
  for (const finding of findings) {
    const question = finding.clarifyingQuestion?.trim()
      || (finding.kind === 'question' ? finding.description.trim() : finding.action.trim());
    if (!question) {
      continue;
    }
    const role = inferStakeholder(finding);
    buckets.get(role)!.push({
      findingId: finding.id,
      severity: finding.severity,
      question,
      requirementIds: finding.requirementIds,
      blockIds: finding.evidence.map(({ blockId }) => blockId),
    });
  }
  return stakeholderOrder
    .map((role) => ({ role, label: stakeholderLabels[role], items: buckets.get(role)! }))
    .filter(({ items }) => items.length > 0);
}

export function formatClarifyingQuestionsText(
  groups: ReturnType<typeof groupClarifyingQuestions>,
  documentTitle?: string,
): string {
  const header = documentTitle ? `Вопросы по спецификации «${documentTitle}»\n\n` : '';
  return header + groups.map(({ label, items }) =>
    `${label}:\n` + items.map((item, index) => {
      const refs = item.requirementIds.length ? ` (${item.requirementIds.join(', ')})` : '';
      return `${index + 1}. [${item.findingId}${refs}] ${item.question}`;
    }).join('\n')).join('\n\n');
}

export const feasibilityLabels = {
  feasible: 'Выполнимо в описанном объёме',
  conditional: 'Зависит от условий',
  unknown: 'Недостаточно данных',
  infeasible: 'Несовместимо с ограничениями',
} as const;

export const testReadinessLabels = {
  ready: 'Есть проверяемый результат',
  conditional: 'Нужны уточнения для теста',
  blocked: 'Нельзя задать ожидаемый результат',
} as const;

export const severityLabels = { blocker: 'Блокирующее', major: 'Существенное', minor: 'Незначительное' } as const;
export const findingKindLabels = { defect: 'Дефект', risk: 'Риск', question: 'Вопрос' } as const;
export const requirementKindLabels = {
  functional: 'Функциональное',
  nonfunctional: 'Нефункциональное',
  interface: 'Интерфейс',
  data: 'Данные',
  acceptance: 'Приёмка',
  constraint: 'Ограничение',
} as const;

const affectsLabels = {
  development: 'разработка',
  testing: 'тестирование',
  both: 'разработка и тестирование',
} as const;

const readinessPhrases = {
  ready: 'можно начинать',
  conditional: 'можно начинать после уточнений',
  blocked: 'нужно отложить до устранения блокирующих дефектов',
} as const;
const sentencesInRussian = new Intl.Segmenter('ru', { granularity: 'sentence' });

export function summarizeReview({ readiness, requirements, findings, unreadablePages }: ReviewReport): string {
  const { development, testing } = readiness;
  const verdict = development === testing
    ? `Разработку и тестирование ${readinessPhrases[development]}.`
    : `Разработку ${readinessPhrases[development]}. Тестирование ${readinessPhrases[testing]}.`;
  const feasible = requirements.filter(({ feasibility }) => feasibility === 'feasible').length;
  const feasibility = feasible === requirements.length
    ? 'По отдельности выполнимы все выделенные требования.'
    : `По отдельности выполнимость подтверждена для ${feasible} из ${requirements.length} требований.`;
  const sentences = [verdict, feasibility];
  const priority = priorityFinding(findings);
  if (priority) {
    sentences.push(summarizeFinding(priority));
  }
  if (unreadablePages.length) {
    sentences.push('Проверка неполная из-за страниц без текстового слоя.');
  }
  return sentences.join(' ');
}

function summarizeFinding({ id, criterion, description, action }: Finding): string {
  const issue = asSentence(description);
  const nextStep = asSentence(action);
  const shortIssue = sentencesInRussian.segment(issue).containing(0)?.segment.trim() ?? issue;
  const shortStep = sentencesInRussian.segment(nextStep).containing(0)?.segment.trim() ?? nextStep;
  const details = [`${issue} ${nextStep}`, `${shortIssue} ${shortStep}`, nextStep, issue, shortStep, shortIssue]
    .find((text) => text.length <= 230);
  return details
    ? `Начните с замечания ${id}. ${details}`
    : `Начните с замечания ${id} («${criterionLabels[criterion]}»).`;
}

function asSentence(text: string): string {
  const sentence = text.replace(/\s+/gu, ' ').trim();
  return /[.!?…]$/u.test(sentence) ? sentence : `${sentence}.`;
}

function isBlockingDefect({ kind, severity }: Finding) {
  return kind === 'defect' && severity === 'blocker';
}

function priorityFinding(findings: readonly Finding[]) {
  return findings.find(isBlockingDefect) ?? findings.find(({ severity }) => severity !== 'minor');
}

export function formatLocation({ page, section, startLine, endLine }: Location): string {
  const range = startLine === endLine ? `строка ${startLine}` : `строки ${startLine}–${endLine}`;
  return [
    ...section,
    page === undefined ? range : `стр. ${page}, ${range} извлечённого текста`,
  ].join(' · ');
}

type TableLayout = 'inventory' | 'assessment' | 'criteria';

export type ReportBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string; anchor?: string }
  | { kind: 'paragraph'; text: string; emphasized?: boolean }
  | { kind: 'list'; items: string[]; ordered?: boolean }
  | { kind: 'table'; layout: TableLayout; columns: string[]; rows: string[][] }
  | { kind: 'navigation'; text: string; links: { label: string; anchor: string }[] };

export const reportTitle = 'Отчёт о проверке требований';

export function reportBlocks(report: ReviewReport): ReportBlock[] {
  const { run, summary, requirements, findings, readiness, unreadablePages } = report;
  const critical = findings.filter(isBlockingDefect);
  const setFindings = findings.filter(({ scope }) => scope === 'set');
  const individualFindings = findings.filter(({ scope }) => scope === 'individual');
  const priorities = findings.filter(({ severity }) => severity !== 'minor').slice(0, 6);
  const passport: ReportBlock[] = [
    { kind: 'heading', level: 2, text: 'Паспорт прогона', anchor: 'report-run' },
    { kind: 'list', items: [
      `Документ — ${run.documentTitle} (${run.documentName})`,
      `Дата и время (UTC) — ${run.date}`,
      `Модель — ${run.model} (${run.provider})`,
      ...(run.mode === 'fintech' ? [`Режим проверки — ${reviewModeLabels[run.mode]}`] : []),
      `Версия агента — ${run.version}`,
      `SHA-256 исходного файла — ${run.sha256}`,
    ] },
  ];
  if (unreadablePages.length) {
    passport.push({
      kind: 'paragraph',
      text: `Ограничение прогона. На страницах ${unreadablePages.join(', ')} не найден текстовый слой.`,
      emphasized: true,
    });
  }
  const overview: ReportBlock[] = [
    { kind: 'heading', level: 2, text: 'Сводка', anchor: 'report-summary' },
    { kind: 'paragraph', text: summarizeReview(report) },
    { kind: 'list', items: [
      `Требований — ${summary.requirements}`,
      `Дефектов — ${summary.defects}, из них блокирующих — ${summary.blockingDefects}`,
      `Рисков — ${summary.risks}. Вопросов — ${summary.questions}.`,
      `Готовность к разработке — ${readinessLabels[readiness.development]}`,
      `Готовность к тестированию — ${readinessLabels[readiness.testing]}`,
    ] },
  ];
  const sections: ReportBlock[] = [
    { kind: 'heading', level: 2, text: 'Блокирующие дефекты', anchor: 'report-blockers' },
    critical.length
      ? { kind: 'list', items: critical.map(({ id, description }) => `${id}. ${description}`) }
      : { kind: 'paragraph', text: 'Блокирующих дефектов не выявлено.' },
    { kind: 'heading', level: 2, text: 'Выделенные требования', anchor: 'report-inventory' },
    {
      kind: 'paragraph',
      text: 'У составных требований исходный номер может повторяться. Пробелы в цитатах нормализованы.',
    },
    {
      kind: 'table',
      layout: 'inventory',
      columns: ['ID отчёта', 'ID источника', 'Формулировка', 'Место', 'Цитата'],
      rows: requirements.map((item) => [
        item.id, item.originalId ?? '—', item.summary, formatLocation(item.source.location), item.source.quote,
      ]),
    },
    { kind: 'heading', level: 2, text: 'Проверка каждого требования', anchor: 'report-assessment' },
    {
      kind: 'table',
      layout: 'assessment',
      columns: ['ID', 'Тип', 'Выполнимость', 'Проверяемость', 'Замечания'],
      rows: requirements.map((item) => [
        item.id, requirementKindLabels[item.kind], feasibilityLabels[item.feasibility],
        testReadinessLabels[item.testReadiness], item.findingIds.join(', ') || 'Не выявлены',
      ]),
    },
    ...individualFindings.flatMap(findingBlocks),
    {
      kind: 'heading', level: 2, text: 'Проверка всего набора и выполнимости проекта', anchor: 'report-project',
    },
    {
      kind: 'table',
      layout: 'criteria',
      columns: ['Критерий', 'Замечания к набору'],
      rows: setCriteria.map((criterion) => {
        const ids = setFindings.filter((finding) => finding.criterion === criterion).map(({ id }) => id);
        return [criterionLabels[criterion], ids.join(', ') || 'Не выявлены'];
      }),
    },
    ...setFindings.flatMap(findingBlocks),
    { kind: 'heading', level: 2, text: 'Итог и порядок исправлений', anchor: 'report-conclusion' },
    { kind: 'list', items: [
      `Разработка — ${readinessLabels[readiness.development]}.`,
      `Тестирование — ${readinessLabels[readiness.testing]}.`,
    ] },
  ];
  if (priorities.length) {
    sections.push({ kind: 'list', ordered: true, items: priorities.map(({ id, action }) => `${id}. ${action}`) });
  } else if (readiness.development === 'ready' && readiness.testing === 'ready') {
    sections.push({ kind: 'paragraph', text: 'Существенных исправлений по результатам этого прогона не выявлено.' });
  } else {
    sections.push({
      kind: 'paragraph',
      text: 'Уточните условия выполнимости и проверяемости из таблицы и повторите прогон.',
    });
  }
  sections.push(
    { kind: 'heading', level: 2, text: 'Методика', anchor: 'report-method' },
    {
      kind: 'paragraph',
      text: 'Агент выделил требования, проверил каждое и сопоставил разделы документа. Критерии основаны на '
        + 'ISO/IEC/IEEE 29148:2018 (§ 5.2.5–5.2.6) и IEEE 830-1998 (§ 4.3).'
        + (run.mode === 'fintech'
          ? ' Дополнительно выполнен FinTech / Banking аудит (идемпотентность, валюты и округления, часовые пояса, сторно, маскирование PII/PCI и аудит).'
          : ''),
    },
    { kind: 'paragraph', text: 'Проверка набора выводит до 12 наиболее существенных замечаний.' },
    {
      kind: 'paragraph',
      text: 'Сводка учитывает дефекты, риски и вопросы отдельно. '
        + 'Оценка выполнимости опирается на сведения из документа.',
    },
  );
  const links = passport.concat(overview, sections).flatMap((block) =>
    block.kind === 'heading' && block.level === 2 && block.anchor
      ? [{ label: block.text, anchor: block.anchor }]
      : []);
  const priority = priorityFinding(findings);
  if (priority) {
    links.splice(2, 0, { label: `Приоритетное замечание ${priority.id}`, anchor: findingAnchor(priority.id) });
  }
  return [
    { kind: 'heading', level: 1, text: reportTitle },
    ...passport,
    { kind: 'navigation', text: 'Оглавление', links },
    ...overview,
    ...sections,
  ];
}

function findingBlocks(finding: Finding): ReportBlock[] {
  const {
    id, criterion, kind, severity, affects, owner, description, impact, action,
    suggestedRewrite, clarifyingQuestion, evidence, requirementIds,
  } = finding;
  return [
    { kind: 'heading', level: 3, text: `${id}. ${criterionLabels[criterion]}`, anchor: findingAnchor(id) },
    {
      kind: 'paragraph',
      text: [
        findingKindLabels[kind],
        severityLabels[severity],
        affectsLabels[affects],
        ...(owner ? [stakeholderLabels[owner]] : []),
      ].join(' · '),
      emphasized: true,
    },
    { kind: 'paragraph', text: description },
    { kind: 'list', items: [
      `Последствия — ${impact}`,
      `Следующий шаг — ${action}`,
      ...(suggestedRewrite ? [`Предлагаемая формулировка — «${suggestedRewrite}»`] : []),
      ...(clarifyingQuestion ? [`Вопрос автору — ${clarifyingQuestion}`] : []),
      ...(requirementIds.length ? [`Требования — ${requirementIds.join(', ')}`] : []),
      ...evidence.map(({ blockId, location, quote }) => `${blockId} · ${formatLocation(location)} — «${quote}»`),
    ] },
  ];
}

function findingAnchor(id: string) {
  return `finding-${id.toLowerCase()}`;
}

export function renderMarkdown(report: ReviewReport): string {
  const sections = reportBlocks(report).map((block) => {
    switch (block.kind) {
      case 'heading':
        return (block.anchor ? `<a name="${block.anchor}"></a>\n\n` : '')
          + `${'#'.repeat(block.level)} ${md(block.text)}`;
      case 'paragraph':
        return block.emphasized ? `**${md(block.text)}**` : md(block.text);
      case 'list':
        return block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : '-'} ${md(item)}`).join('\n');
      case 'table':
        return [block.columns, block.columns.map(() => '---'), ...block.rows]
          .map((row) => `| ${row.map(md).join(' | ')} |`).join('\n');
      case 'navigation':
        return `## ${md(block.text)}\n\n`
          + block.links.map(({ label, anchor }) => `- [${md(label)}](#${anchor})`).join('\n');
    }
  });
  return sections.join('\n\n') + '\n';
}

export function renderTextReport(report: ReviewReport, format: Exclude<ReportFormat, 'pdf'>): string {
  if (format === 'markdown') {
    return renderMarkdown(report);
  }
  const sections = reportBlocks(report).map((block) => {
    switch (block.kind) {
      case 'heading':
      case 'paragraph':
        return block.text;
      case 'list':
        return block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : '-'} ${item}`).join('\n');
      case 'table':
        return block.rows.map((row) => row.map((value, index) =>
          `${block.columns[index]} — ${value}`).join('\n')).join('\n\n');
      case 'navigation':
        return `${block.text}\n\n` + block.links.map(({ label }) => `- ${label}`).join('\n');
    }
  });
  return sections.join('\n\n') + '\n';
}

function md(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\\|`*_\[\]#]/gu, '\\$&');
}
