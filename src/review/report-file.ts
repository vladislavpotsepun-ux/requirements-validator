import { defaultReportFormat, reportFileName, reportFormats } from './report-formats.js';
import type { ReportFormat } from './report-formats.js';
import { renderTextReport } from './report.js';
import type { ReviewReport } from './types.js';

export async function renderReportFile(report: ReviewReport, format: ReportFormat = defaultReportFormat) {
  return {
    name: reportFileName(report.run.documentName, format),
    contentType: reportFormats[format].contentType,
    bytes: await renderBytes(report, format),
  };
}

async function renderBytes(report: ReviewReport, format: ReportFormat): Promise<Buffer> {
  if (format === 'pdf') {
    const { renderPdf } = await import('./report-pdf.js');
    return renderPdf(report);
  }
  return Buffer.from(renderTextReport(report, format), 'utf8');
}
