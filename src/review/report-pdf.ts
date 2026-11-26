import { resolve as resolvePath } from 'node:path';
import PDFDocument from 'pdfkit';
import { reportBlocks, reportTitle } from './report.js';
import type { ReportBlock } from './report.js';
import type { ReviewReport } from './types.js';

type TableBlock = Extract<ReportBlock, { kind: 'table' }>;

const colors = { ink: '#162B24', muted: '#486256', line: '#CFDBD4', band: '#EAF1EC', link: '#20604D' };
const headings = {
  1: { size: 22, before: 0, after: 12 },
  2: { size: 15, before: 13, after: 6 },
  3: { size: 11, before: 8, after: 4 },
} as const;
const columnFractions = {
  inventory: [0.12, 0.12, 0.24, 0.20, 0.32],
  assessment: [0.12, 0.18, 0.23, 0.25, 0.22],
  criteria: [0.46, 0.54],
};
const tableFontSize = 8.4;
const tablePadding = 5;

export function renderPdf(report: ReviewReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A4',
      margins: { top: 44, right: 46, bottom: 56, left: 46 },
      bufferPages: true,
      info: { Title: reportTitle, Subject: report.run.documentTitle },
    });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.once('error', reject);
    pdf.once('end', () => resolve(Buffer.concat(chunks)));
    try {
      const fonts = resolvePath('assets', 'fonts');
      pdf.registerFont('report-body', resolvePath(fonts, 'DejaVuSans.ttf'));
      pdf.registerFont('report-bold', resolvePath(fonts, 'DejaVuSans-Bold.ttf'));
      const blocks = reportBlocks(report);
      for (const [index, block] of blocks.entries()) {
        drawBlock(pdf, block, blocks[index + 1]);
      }
      numberPages(pdf);
      pdf.end();
    } catch (error) {
      pdf.destroy();
      reject(error);
    }
  });
}

function drawBlock(pdf: PDFKit.PDFDocument, block: ReportBlock, nextBlock?: ReportBlock) {
  switch (block.kind) {
    case 'heading': {
      const style = headings[block.level];
      const nextHeight = nextBlock?.kind === 'table' ? tableStartHeight(pdf, nextBlock) : 24;
      pdf.font('report-bold').fontSize(style.size);
      const height = style.before + pdf.heightOfString(block.text, { width: pageWidth(pdf) }) + style.after;
      const reserved = height + nextHeight < pageHeight(pdf) ? nextHeight : 24;
      if (pdf.y + height + reserved >= pdf.page.maxY()) {
        pdf.addPage();
      }
      pdf.y += style.before;
      if (block.anchor) {
        const top = pdf.y - 6;
        pdf.addNamedDestination(block.anchor, 'XYZ', null, top, null);
        if (block.level === 2) {
          // В PDFKit 0.21 горизонтальный отступ цели закладки отсчитывается от правого края.
          const options = { expanded: false, fit: false, top, left: pdf.page.width };
          pdf.outline.addItem(block.text, options);
        }
      }
      pdf.fillColor(colors.ink).text(block.text, pdf.page.margins.left, pdf.y, { width: pageWidth(pdf) });
      pdf.y += style.after;
      return;
    }
    case 'paragraph':
      drawBody(pdf, block.text, block.emphasized);
      pdf.y += 5;
      return;
    case 'list':
      for (const [index, text] of block.items.entries()) {
        drawBody(pdf, `${block.ordered ? `${index + 1}.` : '•'}  ${text}`);
        pdf.y += 2;
      }
      return;
    case 'table':
      drawTable(pdf, block);
      return;
    case 'navigation':
      drawBlock(pdf, { kind: 'heading', level: 2, text: block.text });
      pdf.font('report-body').fontSize(9.6).fillColor(colors.link);
      for (const { label, anchor } of block.links) {
        pdf.text(label, pdf.page.margins.left, pdf.y, { width: pageWidth(pdf), underline: true, goTo: anchor });
        pdf.y += 2;
      }
      pdf.y += 5;
  }
}

function drawBody(pdf: PDFKit.PDFDocument, text: string, emphasized = false) {
  pdf.font(emphasized ? 'report-bold' : 'report-body').fontSize(9.6).fillColor(colors.ink);
  pdf.text(singleLine(text), pdf.page.margins.left, pdf.y, { width: pageWidth(pdf), lineGap: 2 });
}

function drawTable(pdf: PDFKit.PDFDocument, block: TableBlock) {
  const width = pageWidth(pdf);
  const columnWidths = columnFractions[block.layout].map((fraction) => fraction * width);
  const headerHeight = measureRow(pdf, block.columns, columnWidths, true);
  const rowHeights = block.rows.map((row) => measureRow(pdf, row, columnWidths));
  if (rowHeights.some((height) => headerHeight + height >= pageHeight(pdf))) {
    // PDFKit обрезает содержимое ячеек, которые выше страницы.
    for (const row of block.rows) {
      for (const [index, value] of row.entries()) {
        drawBody(pdf, `${block.columns[index]} — ${value}`, index === 0);
      }
      pdf.y += 6;
    }
    return;
  }
  if (pdf.y + headerHeight + (rowHeights[0] ?? 0) >= pdf.page.maxY()) {
    pdf.addPage();
  }
  pdf.font('report-body').fontSize(tableFontSize).fillColor(colors.ink);
  const options: PDFKit.Mixins.TableOptionsWithData & { headerRows: number } = {
    position: { x: pdf.page.margins.left, y: pdf.y },
    maxWidth: width,
    headerRows: 1,
    columnStyles: columnWidths,
    defaultStyle: { padding: tablePadding, border: [0, 0, 0.4, 0], borderColor: colors.line, textColor: colors.ink },
    rowStyles: (index) => ({ backgroundColor: index === 0 ? colors.band : index % 2 === 0 ? '#F7F9F7' : '#FFFFFF' }),
    data: [
      block.columns.map((text) => ({ text, font: { src: 'report-bold' }, type: 'TH' })),
      ...block.rows.map((row) => row.map(singleLine)),
    ],
  };
  pdf.table(options);
  pdf.y += 6;
}

function tableStartHeight(pdf: PDFKit.PDFDocument, block: TableBlock) {
  const widths = columnFractions[block.layout].map((fraction) => fraction * pageWidth(pdf));
  const headerHeight = measureRow(pdf, block.columns, widths, true);
  const firstRow = block.rows[0];
  return headerHeight + (firstRow ? measureRow(pdf, firstRow, widths) : 0);
}

function measureRow(pdf: PDFKit.PDFDocument, row: string[], widths: number[], bold = false) {
  pdf.font(bold ? 'report-bold' : 'report-body').fontSize(tableFontSize);
  return Math.max(...row.map((text, index) =>
    pdf.heightOfString(singleLine(text), { width: widths[index]! - 2 * tablePadding }))) + 2 * tablePadding;
}

function numberPages(pdf: PDFKit.PDFDocument) {
  const { start, count } = pdf.bufferedPageRange();
  for (let index = start; index < start + count; index += 1) {
    pdf.switchToPage(index);
    const { height, margins } = pdf.page;
    const right = margins.left + pageWidth(pdf);
    const label = `${index - start + 1} / ${count}`;
    pdf.strokeColor(colors.line).lineWidth(0.5).moveTo(margins.left, height - 42).lineTo(right, height - 42).stroke();
    pdf.font('report-body').fontSize(8).fillColor(colors.muted);
    pdf.text(label, right - pdf.widthOfString(label), height - 33, { lineBreak: false });
  }
}

function pageWidth(pdf: PDFKit.PDFDocument) {
  const { width, margins } = pdf.page;
  return width - margins.left - margins.right;
}

function pageHeight(pdf: PDFKit.PDFDocument) {
  return pdf.page.maxY() - pdf.page.margins.top;
}

function singleLine(text: string) {
  return text.replace(/\s+/gu, ' ').trim();
}
