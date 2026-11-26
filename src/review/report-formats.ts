export const reportFormats = {
  pdf: { label: 'PDF', extension: '.pdf', contentType: 'application/pdf' },
  markdown: { label: 'Markdown', extension: '.md', contentType: 'text/markdown; charset=utf-8' },
  text: { label: 'TXT', extension: '.txt', contentType: 'text/plain; charset=utf-8' },
} as const;

export type ReportFormat = keyof typeof reportFormats;
export const reportFormatOptions = Object.keys(reportFormats) as ReportFormat[];
export const defaultReportFormat = 'pdf';

export function reportFileName(documentName: string, format: ReportFormat): string {
  const baseName = documentName.replace(/\.[^.]+$/u, '');
  return `${baseName}-report${reportFormats[format].extension}`;
}
