export function textPdf(pages: [text: string, x: number, y: number][][]): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${4 + 2 * index} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, rows] of pages.entries()) {
    const page = 4 + 2 * index;
    const stream = rows.map(([text, x, y]) => `BT /F1 12 Tf ${x} ${y} Td (${text}) Tj ET`).join('\n');
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 820] /Contents ${page + 1} 0 R `
      + '/Resources << /Font << /F1 3 0 R >> >> >>',
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  let document = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(document);
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}
