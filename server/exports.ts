import { Document as DocxDocument, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import PDFDocument from 'pdfkit';

export type ExportFormat = 'pdf' | 'docx' | 'md' | 'txt' | 'csv';

export async function generateExportBuffer(params: {
  title: string;
  content: string;
  format: ExportFormat;
  rows?: Array<Record<string, string | number>>;
}): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  const safeBase = params.title
    .replace(/[^a-zA-Z0-9\u0900-\u097F _-]/g, '')
    .trim()
    .slice(0, 60) || 'documind-export';

  if (params.format === 'md') {
    const md = `# ${params.title}\n\n${params.content}\n`;
    return {
      buffer: Buffer.from(md, 'utf8'),
      mimeType: 'text/markdown; charset=utf-8',
      filename: `${safeBase}.md`,
    };
  }

  if (params.format === 'txt') {
    const txt = `${params.title}\n${'='.repeat(Math.min(params.title.length, 60))}\n\n${params.content}\n`;
    return {
      buffer: Buffer.from(txt, 'utf8'),
      mimeType: 'text/plain; charset=utf-8',
      filename: `${safeBase}.txt`,
    };
  }

  if (params.format === 'csv') {
    const escapeCsv = (val: unknown) => `"${String(val ?? '').replace(/"/g, '""')}"`;
    let csvContent = '';
    if (params.rows && params.rows.length > 0) {
      const headers = Object.keys(params.rows[0]);
      csvContent += headers.map(escapeCsv).join(',') + '\n';
      for (const row of params.rows) {
        csvContent += headers.map((h) => escapeCsv(row[h])).join(',') + '\n';
      }
    } else {
      csvContent = 'Section,Content\n';
      const lines = params.content.split(/\n+/).filter(Boolean);
      lines.forEach((line, idx) => {
        csvContent += `${idx + 1},${escapeCsv(line)}\n`;
      });
    }
    return {
      buffer: Buffer.from('\uFEFF' + csvContent, 'utf8'),
      mimeType: 'text/csv; charset=utf-8',
      filename: `${safeBase}.csv`,
    };
  }

  if (params.format === 'docx') {
    const paragraphs: Paragraph[] = [
      new Paragraph({
        text: params.title,
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 240 },
      }),
    ];

    for (const line of params.content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        paragraphs.push(new Paragraph({ text: '' }));
      } else if (trimmed.startsWith('## ')) {
        paragraphs.push(
          new Paragraph({
            text: trimmed.replace(/^##\s+/, ''),
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 120 },
          })
        );
      } else if (trimmed.startsWith('### ')) {
        paragraphs.push(
          new Paragraph({
            text: trimmed.replace(/^###\s+/, ''),
            heading: HeadingLevel.HEADING_3,
            spacing: { before: 160, after: 80 },
          })
        );
      } else {
        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text: line })],
            spacing: { after: 100 },
          })
        );
      }
    }

    const doc = new DocxDocument({
      sections: [{ children: paragraphs }],
    });
    const buffer = await Packer.toBuffer(doc);
    return {
      buffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${safeBase}.docx`,
    };
  }

  // PDF format via pdfkit
  const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
    const pdf = new PDFDocument({ margin: 54, size: 'A4' });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    pdf.fontSize(18).text(params.title, { align: 'left' });
    pdf.moveDown(0.5);
    pdf.fontSize(9).fillColor('#64748b').text(`Exported from DocuMind AI · ${new Date().toISOString()}`);
    pdf.moveDown(1);
    pdf.fontSize(11).fillColor('#0f172a').text(params.content, {
      lineGap: 4,
    });
    pdf.end();
  });

  return {
    buffer: pdfBuffer,
    mimeType: 'application/pdf',
    filename: `${safeBase}.pdf`,
  };
}
