import { useState } from 'react';
import {
  defaultReportFormat, reportFileName, reportFormatOptions, reportFormats,
} from '../src/review/report-formats.js';
import type { ReportFormat } from '../src/review/report-formats.js';
import { criterionLabels } from '../src/review/rubric.js';
import {
  feasibilityLabels, findingKindLabels, formatLocation, readinessLabels, severityLabels, testReadinessLabels,
  renderTextReport, summarizeReview,
} from '../src/review/report.js';
import type { DownloadableReport, Finding, FindingKind, ReviewReport } from '../src/review/types.js';

interface Props {
  report: ReviewReport;
  file: DownloadableReport;
}

type Filter = 'all' | 'blockers' | FindingKind;

export function ReviewResults({ report, file }: Props) {
  const [format, setFormat] = useState<ReportFormat>(defaultReportFormat);
  const [view, setView] = useState<'findings' | 'requirements'>('findings');
  const [filter, setFilter] = useState<Filter>('all');
  const { run, summary, findings, readiness, unreadablePages } = report;
  const filtered = findings.filter((finding) =>
    filter === 'all' || (filter === 'blockers'
      ? finding.severity === 'blocker' && finding.kind === 'defect'
      : finding.kind === filter));

  return (
    <>
      <div className="result-heading">
        <div>
          <h2 id="result-title">Результаты проверки</h2>
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
            Замечания
          </button>
          <button type="button" aria-pressed={view === 'requirements'} onClick={() => setView('requirements')}>
            Требования
          </button>
        </div>
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
      </div>

      {view === 'findings' ? (
        filtered.length
          ? <div className="findings">
              {filtered.map((finding) => <FindingCard finding={finding} key={finding.id} />)}
            </div>
          : <p className="empty-result">Здесь нет замечаний.</p>
      ) : <RequirementTable report={report} />}
    </>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  return (
    <details className="finding">
      <summary>
        <span className="finding-content">
          <span className="finding-category">
            {finding.id} · {criterionLabels[finding.criterion]} · {findingKindLabels[finding.kind]}
          </span>
          <strong>{finding.description}</strong>
        </span>
        <span className={`severity ${finding.severity}`}>{severityLabels[finding.severity]}</span>
      </summary>
      <div className="finding-body">
        <p><strong>Последствия.</strong> {finding.impact}</p>
        <p><strong>Следующий шаг.</strong> {finding.action}</p>
        {finding.requirementIds.length > 0 && <p>Требования: {finding.requirementIds.join(', ')}</p>}
        {finding.evidence.map(({ blockId, location, quote }) => (
          <blockquote key={blockId}><cite>{formatLocation(location)}</cite><p>{quote}</p></blockquote>
        ))}
      </div>
    </details>
  );
}

function RequirementTable({ report }: { report: ReviewReport }) {
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
                <details className="source-detail">
                  <summary>{formatLocation(item.source.location)}</summary>
                  <blockquote>{item.source.quote}</blockquote>
                </details>
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
