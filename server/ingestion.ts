import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker } from 'tesseract.js';
import * as XLSX from 'xlsx';
import type { UserRecord } from './auth.ts';
import { geminiVisionOCR, generateEmbedding, isGeminiConfigured } from './ai.ts';
import { db, logAudit, UPLOADS_DIR } from './db.ts';

export const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'tiff',
  'tif',
  'svg',
]);

export const TEXT_BASED_EXTENSIONS = new Set([
  'txt',
  'md',
  'json',
  'xml',
  'yaml',
  'yml',
  'log',
  'ini',
  'toml',
  'sql',
]);

export const ALLOWED_EXTENSIONS = new Set([
  'pdf',
  'docx',
  'doc',
  'odt',
  'rtf',
  'epub',
  'pptx',
  'xlsx',
  'xls',
  'ods',
  'csv',
  'tsv',
  'html',
  'htm',
  ...TEXT_BASED_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
]);

export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

export interface ExtractedPage {
  pageNumber: number;
  text: string;
}

export interface ExtractedTable {
  title: string;
  pageNumber: number;
  headers: string[];
  rows: string[][];
}

export function detectLanguage(text: string): 'en' | 'ne' | 'mixed' {
  const devanagariMatches = text.match(/[\u0900-\u097F]/g) || [];
  const latinMatches = text.match(/[A-Za-z]/g) || [];
  const total = devanagariMatches.length + latinMatches.length;
  if (total === 0) return 'en';
  const neRatio = devanagariMatches.length / total;
  if (neRatio >= 0.6) return 'ne';
  if (neRatio >= 0.12) return 'mixed';
  return 'en';
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)));
}

function parseHtmlTables(html: string): ExtractedTable[] {
  const tables: ExtractedTable[] = [];
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let match: RegExpExecArray | null;
  let idx = 1;
  while ((match = tableRegex.exec(html)) !== null) {
    const tableBody = match[1];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const rows: string[][] = [];
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRegex.exec(tableBody)) !== null) {
      const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
        const clean = cellMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        cells.push(clean);
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) {
      tables.push({
        title: `Table ${idx++}`,
        pageNumber: 1,
        headers: rows[0],
        rows: rows.slice(1),
      });
    }
  }
  return tables;
}

async function extractPdfPages(filePath: string): Promise<{
  pages: ExtractedPage[];
  metadata: Record<string, unknown>;
}> {
  const buffer = new Uint8Array(fs.readFileSync(filePath));
  const loadingTask = pdfjsLib.getDocument({
    data: buffer,
    useSystemFonts: true,
    verbosity: 0,
  });
  const pdfDoc = await loadingTask.promise;
  const pages: ExtractedPage[] = [];

  let metaInfo: Record<string, unknown> = {};
  try {
    const meta = await pdfDoc.getMetadata();
    metaInfo = (meta.info as Record<string, unknown>) || {};
  } catch {
    metaInfo = {};
  }

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .filter(Boolean);
    pages.push({
      pageNumber: i,
      text: strings.join(' ').replace(/\s+/g, ' ').trim(),
    });
  }

  return { pages, metadata: metaInfo };
}

async function extractPptxPages(filePath: string): Promise<{
  pages: ExtractedPage[];
  tables: ExtractedTable[];
}> {
  const buf = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buf);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/i)?.[1] || 0);
      const nb = Number(b.match(/slide(\d+)\.xml/i)?.[1] || 0);
      return na - nb;
    });

  const pages: ExtractedPage[] = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async('string');
    const textNodes = Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)).map((m) =>
      decodeXmlEntities(m[1])
    );
    const slideNum = Number(slideFiles[i].match(/slide(\d+)\.xml/i)?.[1] || i + 1);

    let notesText = '';
    const notesPath = `ppt/notesSlides/notesSlide${slideNum}.xml`;
    if (zip.files[notesPath]) {
      const notesXml = await zip.files[notesPath].async('string');
      const notesNodes = Array.from(notesXml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)).map((m) =>
        decodeXmlEntities(m[1])
      );
      if (notesNodes.length > 0) {
        notesText = `\n[Speaker Notes]: ${notesNodes.join(' ')}`;
      }
    }

    pages.push({
      pageNumber: i + 1,
      text: `${textNodes.join(' ').replace(/\s+/g, ' ').trim()}${notesText}`.trim(),
    });
  }

  return { pages, tables: [] };
}

async function extractOdtPages(filePath: string): Promise<ExtractedPage[]> {
  const buf = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buf);
  const contentFile = zip.files['content.xml'];
  if (!contentFile) {
    throw new Error('Invalid ODT document: content.xml missing.');
  }
  const xml = await contentFile.async('string');
  const blocks = Array.from(xml.matchAll(/<text:(?:h|p)[^>]*>([\s\S]*?)<\/text:(?:h|p)>/gi))
    .map((m) => decodeXmlEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const full = blocks.join('\n\n').trim();
  const parts = chunkPages([{ pageNumber: 1, text: full }], 2400, 0);
  return parts.length > 0 ? parts.map((p, i) => ({ pageNumber: i + 1, text: p.content })) : [{ pageNumber: 1, text: full }];
}

async function extractEpubPages(filePath: string): Promise<ExtractedPage[]> {
  const buf = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buf);
  const chapterFiles = Object.keys(zip.files)
    .filter((name) => /\.(xhtml|html|htm)$/i.test(name) && !name.toLowerCase().includes('toc.'))
    .sort();
  const pages: ExtractedPage[] = [];
  let pageNum = 1;
  for (const name of chapterFiles) {
    const html = await zip.files[name].async('string');
    const cleaned = decodeXmlEntities(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<\/(p|div|h\d|li|tr|br)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
    )
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (cleaned.length > 15) {
      pages.push({ pageNumber: pageNum++, text: cleaned });
    }
  }
  return pages;
}

function extractRtfText(rawRtf: string): string {
  const stripped = rawRtf
    .replace(/\{\\\*[^{}]*\}/g, ' ')
    .replace(/\{\\(?:fonttbl|colortbl|stylesheet|info|pict|object)[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/gi, ' ')
    .replace(/\\par[d]?/gi, '\n')
    .replace(/\\line/gi, '\n')
    .replace(/\\tab/gi, '\t')
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, num) => {
      const code = Number(num);
      return String.fromCharCode(code < 0 ? code + 65536 : code);
    })
    .replace(/\\[a-z]+-?\d*\s?/gi, '')
    .replace(/[{}]/g, '');
  return stripped.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function extractHtmlDocument(html: string): { pages: ExtractedPage[]; tables: ExtractedTable[] } {
  const tables = parseHtmlTables(html);
  const cleaned = decodeXmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|h\d|li|tr|section|article|br)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const parts = chunkPages([{ pageNumber: 1, text: cleaned }], 2400, 0);
  const pages = parts.length > 0 ? parts.map((p, i) => ({ pageNumber: i + 1, text: p.content })) : [{ pageNumber: 1, text: cleaned }];
  return { pages, tables };
}

async function runLocalTesseractOCR(filePath: string): Promise<{ text: string; error?: string }> {
  try {
    let worker;
    try {
      worker = await createWorker(['eng', 'nep']);
    } catch {
      worker = await createWorker('eng');
    }
    try {
      const result = await worker.recognize(filePath);
      const text = (result.data.text || '').trim();
      if (!text) {
        return { text: '', error: 'Local OCR completed but detected no readable text.' };
      }
      return { text };
    } finally {
      await worker.terminate();
    }
  } catch (err) {
    return {
      text: '',
      error: err instanceof Error ? err.message : 'Local Tesseract OCR engine failed.',
    };
  }
}

function chunkPages(pages: ExtractedPage[], chunkSize: number, overlap: number): Array<{
  pageNumber: number;
  chunkIndex: number;
  content: string;
  isTable: boolean;
}> {
  const safeSize = Math.min(Math.max(chunkSize, 300), 2500);
  const safeOverlap = Math.min(Math.max(overlap, 0), Math.floor(safeSize / 2));
  const step = Math.max(100, safeSize - safeOverlap);

  const chunks: Array<{
    pageNumber: number;
    chunkIndex: number;
    content: string;
    isTable: boolean;
  }> = [];

  let globalIndex = 0;
  for (const page of pages) {
    const clean = page.text.trim();
    if (!clean) continue;
    if (clean.length <= safeSize) {
      chunks.push({
        pageNumber: page.pageNumber,
        chunkIndex: globalIndex++,
        content: clean,
        isTable: clean.includes('| --- |') || clean.startsWith('[Sheet:'),
      });
      continue;
    }

    let pos = 0;
    while (pos < clean.length) {
      let end = Math.min(pos + safeSize, clean.length);
      if (end < clean.length) {
        const lastBoundary = clean.lastIndexOf(' ', end);
        if (lastBoundary > pos + safeSize * 0.5) {
          end = lastBoundary;
        }
      }
      const slice = clean.slice(pos, end).trim();
      if (slice.length > 0) {
        chunks.push({
          pageNumber: page.pageNumber,
          chunkIndex: globalIndex++,
          content: slice,
          isTable: slice.includes('| --- |') || slice.startsWith('[Sheet:'),
        });
      }
      if (end >= clean.length) break;
      pos += step;
    }
  }
  return chunks;
}

export function getSafeUserUploadDir(userId: string): string {
  const safeUser = path.basename(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(UPLOADS_DIR, safeUser);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function processDocumentIngestion(documentId: string, user: UserRecord): Promise<void> {
  const doc = db
    .prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?')
    .get(documentId, user.id) as {
    id: string;
    user_id: string;
    title: string;
    original_filename: string;
    mime_type: string;
    file_ext: string;
    file_size: number;
    storage_path: string;
    cloud_consented: number;
  } | undefined;

  if (!doc) return;

  db.prepare(`UPDATE documents SET status = 'processing', error_message = NULL, updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), documentId);

  try {
    let pages: ExtractedPage[] = [];
    let tables: ExtractedTable[] = [];
    let metadata: Record<string, unknown> = {};
    let ocrStatus: 'not_needed' | 'completed' | 'failed' = 'not_needed';
    let ocrError: string | null = null;

    const ext = doc.file_ext.toLowerCase();
    const allowCloud = doc.cloud_consented === 1 || user.cloud_consent_default === 1;

    if (ext === 'pdf') {
      const pdfResult = await extractPdfPages(doc.storage_path);
      pages = pdfResult.pages;
      metadata = pdfResult.metadata;
      const totalChars = pages.reduce((acc, p) => acc + p.text.trim().length, 0);

      if (totalChars < 30) {
        // Scanned PDF detected
        if (allowCloud && user.ai_mode !== 'offline' && isGeminiConfigured()) {
          try {
            const base64Data = fs.readFileSync(doc.storage_path).toString('base64');
            const ocrText = await geminiVisionOCR({
              base64Data,
              mimeType: 'application/pdf',
              filename: doc.original_filename,
              userId: user.id,
            });
            if (!ocrText || ocrText.includes('[OCR_UNREADABLE]')) {
              ocrStatus = 'failed';
              ocrError = 'Scanned PDF OCR returned unreadable or empty text.';
            } else {
              ocrStatus = 'completed';
              const splitPages = ocrText.split(/---\s*PAGE\s+\d+\s*---/i).map((s) => s.trim()).filter(Boolean);
              pages = splitPages.length > 0
                ? splitPages.map((txt, idx) => ({ pageNumber: idx + 1, text: txt }))
                : [{ pageNumber: 1, text: ocrText }];
            }
          } catch (ocrErr) {
            ocrStatus = 'failed';
            ocrError = ocrErr instanceof Error ? ocrErr.message : 'Cloud Vision OCR failed on scanned PDF.';
          }
        } else {
          ocrStatus = 'failed';
          ocrError =
            'Scanned PDF has no embedded text layer. Grant Cloud AI consent for Vision OCR (or switch to Online/Automatic mode) and click Retry OCR.';
        }
      }
    } else if (ext === 'docx') {
      const rawRes = await mammoth.extractRawText({ path: doc.storage_path });
      const htmlRes = await mammoth.convertToHtml({ path: doc.storage_path });
      tables = parseHtmlTables(htmlRes.value);
      const text = rawRes.value.trim();
      const pageChunks = chunkPages([{ pageNumber: 1, text }], 2600, 0);
      pages = pageChunks.map((c, idx) => ({ pageNumber: idx + 1, text: c.content }));
      if (pages.length === 0 && text) pages = [{ pageNumber: 1, text }];
    } else if (ext === 'doc') {
      const buf = fs.readFileSync(doc.storage_path);
      const asciiRuns = buf.toString('latin1').match(/[\x20-\x7E\r\n\t]{5,}/g) || [];
      const extracted = asciiRuns.join(' ').replace(/\s+/g, ' ').trim();
      if (extracted.length < 40) {
        throw new Error('Legacy binary .doc file could not be reliably decoded. Please convert to .docx or .pdf and re-upload.');
      }
      pages = [{ pageNumber: 1, text: extracted }];
    } else if (ext === 'odt') {
      pages = await extractOdtPages(doc.storage_path);
    } else if (ext === 'epub') {
      pages = await extractEpubPages(doc.storage_path);
    } else if (ext === 'rtf') {
      const raw = fs.readFileSync(doc.storage_path, 'utf8');
      const text = extractRtfText(raw);
      const parts = chunkPages([{ pageNumber: 1, text }], 2400, 0);
      pages = parts.length > 0 ? parts.map((p, i) => ({ pageNumber: i + 1, text: p.content })) : [{ pageNumber: 1, text }];
    } else if (ext === 'html' || ext === 'htm') {
      const html = fs.readFileSync(doc.storage_path, 'utf8');
      const parsed = extractHtmlDocument(html);
      pages = parsed.pages;
      tables = parsed.tables;
    } else if (ext === 'xlsx' || ext === 'xls' || ext === 'ods' || ext === 'csv' || ext === 'tsv') {
      const workbook = XLSX.readFile(doc.storage_path);
      workbook.SheetNames.forEach((sheetName, idx) => {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' })
          .map((r) => r.map((cell) => String(cell ?? '').trim()))
          .filter((r) => r.some((cell) => cell.length > 0));
        if (rows.length > 0) {
          tables.push({
            title: sheetName,
            pageNumber: idx + 1,
            headers: rows[0],
            rows: rows.slice(1, 200),
          });
        }
        const csvText = XLSX.utils.sheet_to_csv(sheet).trim();
        pages.push({
          pageNumber: idx + 1,
          text: `[Sheet: ${sheetName}]\n${csvText}`,
        });
      });
    } else if (ext === 'pptx') {
      const pptxRes = await extractPptxPages(doc.storage_path);
      pages = pptxRes.pages;
      tables = pptxRes.tables;
    } else if (TEXT_BASED_EXTENSIONS.has(ext)) {
      const rawText = fs.readFileSync(doc.storage_path, 'utf8').trim();
      let text = rawText;
      if (ext === 'json') {
        try {
          text = JSON.stringify(JSON.parse(rawText), null, 2);
        } catch {
          text = rawText;
        }
      }
      const parts = chunkPages([{ pageNumber: 1, text }], 2400, 0);
      pages = parts.length > 0 ? parts.map((p, i) => ({ pageNumber: i + 1, text: p.content })) : [{ pageNumber: 1, text }];
    } else if (ext === 'svg') {
      const svgRaw = fs.readFileSync(doc.storage_path, 'utf8');
      const labels = Array.from(svgRaw.matchAll(/<(?:text|tspan|title|desc)[^>]*>([\s\S]*?)<\/(?:text|tspan|title|desc)>/gi))
        .map((m) => decodeXmlEntities(m[1].replace(/<[^>]+>/g, ' ')).trim())
        .filter(Boolean);
      const extractedSvg = labels.length > 0 ? labels.join('\n') : `[SVG Vector Graphic: ${doc.original_filename}]`;
      pages = [{ pageNumber: 1, text: extractedSvg }];
    } else if (IMAGE_EXTENSIONS.has(ext)) {
      let ocrText = '';
      let cloudOcrErr: string | null = null;
      const visionSupported = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext);

      if (visionSupported && allowCloud && user.ai_mode !== 'offline' && isGeminiConfigured()) {
        try {
          const base64Data = fs.readFileSync(doc.storage_path).toString('base64');
          const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
          const visionText = await geminiVisionOCR({
            base64Data,
            mimeType: mime,
            filename: doc.original_filename,
            userId: user.id,
          });
          if (visionText && !visionText.includes('[OCR_UNREADABLE]')) {
            ocrText = visionText;
            ocrStatus = 'completed';
          } else {
            cloudOcrErr = 'Cloud Vision OCR could not detect readable text or visual labels.';
          }
        } catch (err) {
          cloudOcrErr = err instanceof Error ? err.message : 'Cloud Vision OCR failed.';
        }
      }

      if (!ocrText && (user.ai_mode !== 'online' || !allowCloud || !isGeminiConfigured() || !visionSupported)) {
        const localRes = await runLocalTesseractOCR(doc.storage_path);
        if (localRes.text) {
          ocrText = localRes.text;
          ocrStatus = 'completed';
        } else {
          ocrStatus = 'failed';
          ocrError = cloudOcrErr
            ? `${cloudOcrErr} Local OCR fallback also failed: ${localRes.error || 'No text detected.'}`
            : localRes.error || 'Local OCR returned no text.';
        }
      } else if (!ocrText) {
        ocrStatus = 'failed';
        ocrError = cloudOcrErr || 'Image OCR could not detect readable text.';
      }

      if (ocrText) {
        pages = [{ pageNumber: 1, text: ocrText }];
      }
    }

    if (ocrStatus === 'failed') {
      db.prepare(`
        UPDATE documents
        SET status = 'ocr_failed', ocr_status = 'failed', ocr_error = ?, error_message = ?, updated_at = ?
        WHERE id = ?
      `).run(ocrError, ocrError, new Date().toISOString(), documentId);

      logAudit({
        userId: user.id,
        action: 'document.ocr_failed',
        resourceType: 'document',
        resourceId: documentId,
        details: ocrError,
      });
      return;
    }

    const fullText = pages.map((p) => p.text).filter(Boolean).join('\n\n');
    if (!fullText.trim()) {
      throw new Error('No extractable text found in this document.');
    }

    const detectedLang = detectLanguage(fullText);
    const pageCount = Math.max(1, pages.length);

    // Replace existing chunks & FTS entries safely
    const oldChunks = db.prepare('SELECT id FROM chunks WHERE document_id = ?').all(documentId) as Array<{ id: string }>;
    const delTx = db.transaction(() => {
      for (const c of oldChunks) {
        db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(c.id);
      }
      db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);
    });
    delTx();

    const chunks = chunkPages(pages, user.chunk_size || 900, user.chunk_overlap || 160);
    const insertChunk = db.prepare(`
      INSERT INTO chunks (id, document_id, user_id, page_number, chunk_index, content, is_table, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(`
      INSERT INTO chunks_fts (chunk_id, document_id, user_id, content)
      VALUES (?, ?, ?, ?)
    `);

    const insertedChunks: Array<{ id: string; content: string }> = [];
    const insTx = db.transaction(() => {
      for (const ch of chunks) {
        const chunkId = crypto.randomUUID();
        const approxTokens = Math.ceil(ch.content.split(/\s+/).length * 1.3);
        insertChunk.run(
          chunkId,
          documentId,
          user.id,
          ch.pageNumber,
          ch.chunkIndex,
          ch.content,
          ch.isTable ? 1 : 0,
          approxTokens
        );
        insertFts.run(chunkId, documentId, user.id, ch.content);
        insertedChunks.push({ id: chunkId, content: ch.content });
      }
    });
    insTx();

    // Mark document ready immediately so keyword RAG works even while/if embeddings run
    db.prepare(`
      UPDATE documents
      SET status = 'ready',
          ocr_status = ?,
          ocr_error = NULL,
          detected_language = ?,
          page_count = ?,
          extracted_text = ?,
          pages_json = ?,
          tables_json = ?,
          metadata_json = ?,
          error_message = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(
      ocrStatus,
      detectedLang,
      pageCount,
      fullText,
      JSON.stringify(pages),
      JSON.stringify(tables),
      JSON.stringify({ ...metadata, chunkCount: chunks.length, tableCount: tables.length }),
      new Date().toISOString(),
      documentId
    );

    // Generate embeddings for top chunks (up to 40 chunks per doc to keep ingestion snappy)
    const embedLimit = insertedChunks.slice(0, 40);
    const insertEmb = db.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, document_id, provider, model, dimensions, vector_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const ch of embedLimit) {
      const emb = await generateEmbedding(ch.content, user, allowCloud);
      if (emb) {
        insertEmb.run(ch.id, documentId, emb.provider, emb.model, emb.vector.length, JSON.stringify(emb.vector));
      } else {
        break;
      }
    }

    logAudit({
      userId: user.id,
      action: 'document.processed',
      resourceType: 'document',
      resourceId: documentId,
      details: `Extracted ${pageCount} pages, ${chunks.length} chunks (${detectedLang}).`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Document processing failed.';
    db.prepare(`UPDATE documents SET status = 'error', error_message = ?, updated_at = ? WHERE id = ?`)
      .run(message, new Date().toISOString(), documentId);
    logAudit({
      userId: user.id,
      action: 'document.error',
      resourceType: 'document',
      resourceId: documentId,
      details: message,
    });
  }
}
