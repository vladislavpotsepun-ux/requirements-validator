import { useEffect, useMemo, useRef, useState } from 'react';
import {
  defaultReportFormat, reportFileName, reportFormatOptions, reportFormats,
} from '../src/review/report-formats.js';
import type { ReportFormat } from '../src/review/report-formats.js';
import { criterionLabels } from '../src/review/rubric.js';
import {
  feasibilityLabels, findingKindLabels, formatClarifyingQuestionsText, formatLocation,
  groupClarifyingQuestions, readinessLabels, renderTextReport, reviewModeLabels, severityLabels,
  stakeholderLabels, summarizeReview, testReadinessLabels,
} from '../src/review/report.js';
import type {
  DownloadableReport, Finding, FindingKind, ReviewReport, SourceBlock,
} from '../src/review/types.js';

interface Props {
  report: ReviewReport;
  file: DownloadableReport;
}

type ViewTab = 'findings' | 'questions' | 'requirements';
type Filter = 'all' | 'blockers' | FindingKind;

interface ScrollTarget {
  blockId: string;
  nonce: number;
}

export function ReviewResults({ report, file }: Props) {
  const [format, setFormat] = useState<ReportFormat>(defaultReportFormat);
  const [view, setView] = useState<ViewTab>('findings');
  const [filter, setFilter] = useState<Filter>('all');
  const sourceBlocks = report.sourceBlocks ?? [];
  const hasSource = sourceBlocks.length > 0;
  const [showSource, setShowSource] = useState<boolean>(() =>
    hasSource && typeof window !== 'undefined' && window.innerWidth >= 960);
  const [highlightedBlocks, setHighlightedBlocks] = useState<string[]>([]);
  const [highlightContext, setHighlightContext] = useState<string>();
  const [scrollTarget, setScrollTarget] = useState<ScrollTarget>();

  const { run, summary, findings, readiness, unreadablePages } = report;

  useEffect(() => {
    setHighlightedBlocks([]);
    setHighlightContext(undefined);
    setScrollTarget(undefined);
    if (!hasSource) {
      setShowSource(false);
    }
  }, [report, hasSource]);

  const questionGroups = useMemo(() => groupClarifyingQuestions(findings), [findings]);
  const totalQuestions = useMemo(
    () => questionGroups.reduce((count, group) => count + group.items.length, 0),
    [questionGroups],
  );

  const findingsByBlock = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const finding of findings) {
      for (const { blockId } of finding.evidence) {
        const list = map.get(blockId) ?? [];
        if (!list.includes(finding.id)) {
          list.push(finding.id);
        }
        map.set(blockId, list);
      }
    }
    return map;
  }, [findings]);

  const filtered = findings.filter((finding) =>
    filter === 'all' || (filter === 'blockers'
      ? finding.severity === 'blocker' && finding.kind === 'defect'
      : finding.kind === filter));

  function focusSourceBlocks(blockIds: readonly string[], context: string, targetBlockId?: string) {
    if (!hasSource) {
      return;
    }
    const unique = [...new Set(blockIds)].filter((id) => sourceBlocks.some((block) => block.id === id));
    const first = unique[0];
    if (!first) {
      return;
    }
    const target = targetBlockId && unique.includes(targetBlockId) ? targetBlockId : first;
    setShowSource(true);
    setHighlightedBlocks(unique);
    setHighlightContext(context);
    setScrollTarget({ blockId: target, nonce: Date.now() });
  }

  function clearHighlight() {
    setHighlightedBlocks([]);
    setHighlightContext(undefined);
    setScrollTarget(undefined);
  }

  const splitActive = hasSource && showSource;

  return (
    <>
      <div className="result-heading">
        <div>
          <div className="result-title-row">
            <h2 id="result-title">Результаты проверки</h2>
            {run.mode === 'fintech' && (
              <span className="mode-badge">{reviewModeLabels.fintech}</span>
            )}
          </div>
          <p>{run.documentTitle} <span aria-hidden="true">·</span> {run.model}</p>
        </div>
        <div className="downloads">
          <label className="format-field">
            Формат отчёта
            <select value={format} onChange={(event) => setFormat(event.currentTarget.value as ReportFormat)}>
              {reportFormatOptions.map((option) =>
                <option key={option} value={option}>{reportFormats[option].label}</option>)}
            </select>
          </label>
          <button type="button" className="button secondary" onClick={() => downloadReport(report, file, format)}>
            Скачать {reportFormats[format].label}
          </button>
        </div>
      </div>
      <p className="review-overview">{summarizeReview(report)}</p>
      <dl className="metrics">
        <div><dt>Требования</dt><dd>{summary.requirements}</dd></div>
        <div><dt>Дефекты</dt><dd>{summary.defects}</dd></div>
        <div><dt>Блокирующие дефекты</dt><dd>{summary.blockingDefects}</dd></div>
        <div><dt>Риски и вопросы</dt><dd>{summary.risks + summary.questions}</dd></div>
      </dl>
      <dl className="readiness">
        <div>
          <dt>Разработка</dt>
          <dd data-status={readiness.development}>{readinessLabels[readiness.development]}</dd>
        </div>
        <div>
          <dt>Тестирование</dt>
          <dd data-status={readiness.testing}>{readinessLabels[readiness.testing]}</dd>
        </div>
      </dl>
      {unreadablePages.length > 0 && (
        <p className="notice">Проверка неполная. Страницы без текстового слоя: {unreadablePages.join(', ')}.</p>
      )}

      <div className="result-toolbar">
        <div className="view-controls" aria-label="Раздел отчёта">
          <button type="button" aria-pressed={view === 'findings'} onClick={() => setView('findings')}>
            Замечания ({findings.length})
          </button>
          <button type="button" aria-pressed={view === 'questions'} onClick={() => setView('questions')}>
            Вопросы команде ({totalQuestions})
          </button>
          <button type="button" aria-pressed={view === 'requirements'} onClick={() => setView('requirements')}>
            Требования ({report.requirements.length})
          </button>
        </div>
        <div className="toolbar-actions">
          {view === 'findings' && (
            <select
              aria-label="Фильтр замечаний"
              value={filter}
              onChange={(event) => setFilter(event.target.value as Filter)}
            >
              <option value="all">Все замечания</option>
              <option value="blockers">Блокирующие дефекты</option>
              <option value="defect">Дефекты</option>
              <option value="risk">Риски</option>
              <option value="question">Вопросы</option>
            </select>
          )}
          {hasSource && (
            <button
              type="button"
              className="button secondary source-toggle"
              aria-pressed={showSource}
              onClick={() => setShowSource((current) => !current)}
            >
              {showSource ? 'Скрыть исходник' : 'Показать исходник'}
            </button>
          )}
        </div>
      </div>

      <div className={splitActive ? 'results-split' : 'results-single'}>
        <div className="results-primary">
          {view === 'findings' && (
            filtered.length
              ? <div className="findings">
                  {filtered.map((finding) => (
                    <FindingCard
                      key={finding.id}
                      finding={finding}
                      hasSource={hasSource}
                      isHighlighted={finding.evidence.some(({ blockId }) => highlightedBlocks.includes(blockId))}
                      onLocate={(targetBlockId) => focusSourceBlocks(
                        finding.evidence.map(({ blockId }) => blockId),
                        `${finding.id} · ${criterionLabels[finding.criterion]}`,
                        targetBlockId,
                      )}
                    />
                  ))}
                </div>
              : <p className="empty-result">Здесь нет замечаний.</p>
          )}
          {view === 'questions' && (
            <ClarifyingQuestionsView
              groups={questionGroups}
              documentTitle={run.documentTitle}
              hasSource={hasSource}
              onLocate={(blockIds, context) => focusSourceBlocks(blockIds, context)}
            />
          )}
          {view === 'requirements' && (
            <RequirementTable
              report={report}
              hasSource={hasSource}
              onLocate={(blockId, context) => focusSourceBlocks([blockId], context, blockId)}
            />
          )}
        </div>

        {splitActive && (
          <SourceViewer
            blocks={sourceBlocks}
            documentTitle={run.documentTitle}
            highlightedBlocks={highlightedBlocks}
            highlightContext={highlightContext}
            scrollTarget={scrollTarget}
            findingsByBlock={findingsByBlock}
            onJump={(blockId) => setScrollTarget({ blockId, nonce: Date.now() })}
            onClearHighlight={clearHighlight}
            onClose={() => setShowSource(false)}
          />
        )}
      </div>
    </>
  );
}

function FindingCard({
  finding,
  hasSource,
  isHighlighted,
  onLocate,
}: {
  finding: Finding;
  hasSource: boolean;
  isHighlighted: boolean;
  onLocate: (targetBlockId?: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copyRewrite() {
    if (!finding.suggestedRewrite) {
      return;
    }
    const ok = await copyToClipboard(finding.suggestedRewrite);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }

  const originalQuote = finding.evidence[0]?.quote;
  const locateLabel = finding.evidence.length > 1
    ? `Показать в тексте (${finding.evidence.length} фрагмента)`
    : 'Показать в тексте';

  return (
    <details className={`finding ${isHighlighted ? 'is-linked' : ''}`}>
      <summary>
        <span className="finding-content">
          <span className="finding-category">
            {finding.id} · {criterionLabels[finding.criterion]} · {findingKindLabels[finding.kind]}
            {finding.owner ? ` · ${stakeholderLabels[finding.owner]}` : ''}
          </span>
          <strong>{finding.description}</strong>
        </span>
        <span className={`severity ${finding.severity}`}>{severityLabels[finding.severity]}</span>
      </summary>
      <div className="finding-body">
        <p><strong>Последствия.</strong> {finding.impact}</p>
        <p><strong>Следующий шаг.</strong> {finding.action}</p>

        {finding.suggestedRewrite && (
          <div className="rewrite-box">
            <div className="rewrite-header">
              <span>Предлагаемая формулировка</span>
              <button type="button" className="copy-button" onClick={() => void copyRewrite()}>
                {copied ? 'Скопировано ✓' : 'Скопировать формулировку'}
              </button>
            </div>
            {originalQuote && (
              <div className="rewrite-before">
                <span className="rewrite-tag">Было</span>
                <p>{originalQuote}</p>
              </div>
            )}
            <div className="rewrite-after">
              <span className="rewrite-tag">Стало</span>
              <p>{finding.suggestedRewrite}</p>
            </div>
          </div>
        )}

        {finding.clarifyingQuestion && (
          <p className="clarifying-callout">
            <strong>Вопрос автору.</strong> {finding.clarifyingQuestion}
          </p>
        )}

        <div className="finding-meta-row">
          {finding.requirementIds.length > 0 && (
            <span className="finding-reqs">Требования: {finding.requirementIds.join(', ')}</span>
          )}
          {hasSource && finding.evidence.length > 0 && (
            <button type="button" className="locate-button" onClick={() => onLocate()}>
              {locateLabel} →
            </button>
          )}
        </div>

        {finding.evidence.map(({ blockId, location, quote }, index) => (
          <blockquote key={`${blockId}-${index}`} className={hasSource ? 'is-clickable' : ''}>
            {hasSource ? (
              <button
                type="button"
                className="evidence-link"
                onClick={() => onLocate(blockId)}
              >
                <cite>{blockId} · {formatLocation(location)}</cite>
                <span aria-hidden="true">Перейти →</span>
              </button>
            ) : (
              <cite>{formatLocation(location)}</cite>
            )}
            <p>{quote}</p>
          </blockquote>
        ))}
      </div>
    </details>
  );
}

function ClarifyingQuestionsView({
  groups,
  documentTitle,
  hasSource,
  onLocate,
}: {
  groups: ReturnType<typeof groupClarifyingQuestions>;
  documentTitle: string;
  hasSource: boolean;
  onLocate: (blockIds: readonly string[], context: string) => void;
}) {
  const [copiedKey, setCopiedKey] = useState<string>();

  async function handleCopy(key: string, text: string) {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((current) => (current === key ? undefined : current)), 1800);
    }
  }

  if (!groups.length) {
    return <p className="empty-result">Уточняющих вопросов по результатам проверки нет.</p>;
  }

  return (
    <div className="questions-panel">
      <div className="questions-toolbar">
        <p>Вопросы сгруппированы по ролям — готово для отправки команде в чат или трекер задач.</p>
        <button
          type="button"
          className="button secondary copy-all-button"
          onClick={() => void handleCopy('all', formatClarifyingQuestionsText(groups, documentTitle))}
        >
          {copiedKey === 'all' ? 'Все вопросы скопированы ✓' : 'Скопировать все вопросы'}
        </button>
      </div>
      <div className="question-groups">
        {groups.map((group) => (
          <section className="question-group" key={group.role}>
            <div className="question-group-header">
              <div>
                <h3>{group.label}</h3>
                <span>{group.items.length}</span>
              </div>
              <button
                type="button"
                className="copy-button"
                onClick={() => void handleCopy(group.role, formatClarifyingQuestionsText([group]))}
              >
                {copiedKey === group.role ? 'Скопировано ✓' : 'Скопировать блок'}
              </button>
            </div>
            <ol className="question-list">
              {group.items.map((item) => (
                <li key={item.findingId}>
                  <div className="question-item-head">
                    <span className="monospace">{item.findingId}</span>
                    <span className={`severity ${item.severity}`}>{severityLabels[item.severity]}</span>
                    {item.requirementIds.length > 0 && (
                      <span className="question-refs">{item.requirementIds.join(', ')}</span>
                    )}
                    {hasSource && item.blockIds.length > 0 && (
                      <button
                        type="button"
                        className="locate-button"
                        onClick={() => onLocate(item.blockIds, `${item.findingId} · ${group.label}`)}
                      >
                        В тексте →
                      </button>
                    )}
                  </div>
                  <p>{item.question}</p>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

function RequirementTable({
  report,
  hasSource,
  onLocate,
}: {
  report: ReviewReport;
  hasSource: boolean;
  onLocate: (blockId: string, context: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th scope="col">ID</th><th scope="col">Требование и цитата</th><th scope="col">Оценка</th></tr>
        </thead>
        <tbody>
          {report.requirements.map((item) => (
            <tr key={item.id}>
              <th scope="row">
                <span className="monospace">{item.id}</span>
                {item.originalId && <small>{item.originalId}</small>}
              </th>
              <td>
                <strong>{item.summary}</strong>
                <div className="req-source-row">
                  <details className="source-detail">
                    <summary>{formatLocation(item.source.location)}</summary>
                    <blockquote>{item.source.quote}</blockquote>
                  </details>
                  {hasSource && (
                    <button
                      type="button"
                      className="locate-button"
                      onClick={() => onLocate(item.source.blockId, `${item.id} · ${item.originalId ?? 'Исходный текст'}`)}
                    >
                      В тексте →
                    </button>
                  )}
                </div>
              </td>
              <td>
                <span>{feasibilityLabels[item.feasibility]}</span>
                <small>{testReadinessLabels[item.testReadiness]}</small>
                {item.findingIds.length > 0 && <small>{item.findingIds.join(', ')}</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SourceViewer({
  blocks,
  documentTitle,
  highlightedBlocks,
  highlightContext,
  scrollTarget,
  findingsByBlock,
  onJump,
  onClearHighlight,
  onClose,
}: {
  blocks: readonly SourceBlock[];
  documentTitle: string;
  highlightedBlocks: readonly string[];
  highlightContext?: string;
  scrollTarget?: ScrollTarget;
  findingsByBlock: Map<string, string[]>;
  onJump: (blockId: string) => void;
  onClearHighlight: () => void;
  onClose: () => void;
}) {
  const blockRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (!scrollTarget) {
      return;
    }
    const element = blockRefs.current.get(scrollTarget.blockId);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [scrollTarget]);

  const highlightIndex = useMemo(() => {
    const map = new Map<string, number>();
    highlightedBlocks.forEach((id, index) => map.set(id, index + 1));
    return map;
  }, [highlightedBlocks]);

  return (
    <aside className="source-panel" aria-label="Исходный документ">
      <div className="source-panel-header">
        <div>
          <h3>Исходный текст</h3>
          <p>{documentTitle}</p>
        </div>
        <button type="button" className="text-button source-close" onClick={onClose}>
          Скрыть
        </button>
      </div>

      {highlightedBlocks.length > 0 && (
        <div className="jump-bar">
          <div className="jump-bar-head">
            <span>{highlightContext ?? 'Выделенные фрагменты'}</span>
            <button type="button" className="text-button" onClick={onClearHighlight}>Сбросить</button>
          </div>
          <div className="jump-buttons">
            {highlightedBlocks.map((blockId, index) => (
              <button
                key={blockId}
                type="button"
                className={`jump-chip ${scrollTarget?.blockId === blockId ? 'is-active' : ''}`}
                onClick={() => onJump(blockId)}
              >
                [{index + 1}] {blockId}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="source-blocks">
        {blocks.map((block) => {
          const order = highlightIndex.get(block.id);
          const isHighlighted = order !== undefined;
          const isFocused = scrollTarget?.blockId === block.id;
          const relatedFindings = findingsByBlock.get(block.id) ?? [];
          return (
            <div
              key={block.id}
              ref={(node) => {
                if (node) {
                  blockRefs.current.set(block.id, node);
                } else {
                  blockRefs.current.delete(block.id);
                }
              }}
              className={`source-block kind-${block.kind} ${isHighlighted ? 'is-highlighted' : ''} ${isFocused ? 'is-focused' : ''}`}
            >
              <div className="source-block-meta">
                <span className="monospace">{block.id}</span>
                {block.originalId && <span className="source-orig-id">{block.originalId}</span>}
                <span className="source-loc">{formatLocation(block.location)}</span>
                {isHighlighted && (
                  <span className="highlight-index">Фрагмент [{order}]</span>
                )}
              </div>
              {block.kind === 'code' || block.kind === 'table'
                ? <pre className="source-pre"><code>{block.text}</code></pre>
                : <p className="source-text">{block.text}</p>}
              {relatedFindings.length > 0 && (
                <div className="source-findings">
                  Замечания: {relatedFindings.join(', ')}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to execCommand inside restricted iframe contexts.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function downloadReport(report: ReviewReport, pdf: DownloadableReport, format: ReportFormat) {
  const contents = format === 'pdf'
    ? Uint8Array.from(atob(pdf.base64), (character) => character.charCodeAt(0))
    : renderTextReport(report, format);
  const url = URL.createObjectURL(new Blob([contents], { type: reportFormats[format].contentType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = format === 'pdf' ? pdf.name : reportFileName(report.run.documentName, format);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
