import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { hashPassword, verifyPassword } from '../server/auth.ts';
import { db } from '../server/db.ts';
import { generateExportBuffer } from '../server/exports.ts';
import { detectLanguage, processDocumentIngestion } from '../server/ingestion.ts';
import { retrieveHybridPassages } from '../server/rag.ts';

test('scrypt password hashing and verification', () => {
  const hash = hashPassword('SecurePass123!');
  assert.equal(verifyPassword('SecurePass123!', hash), true);
  assert.equal(verifyPassword('WrongPassword', hash), false);
});

test('Nepali Devanagari Unicode & English language detection', () => {
  assert.equal(detectLanguage('नेपालको संविधान २०७२ अनुसार शिक्षा मौलिक हक हो।'), 'ne');
  assert.equal(detectLanguage('Document intelligence retrieval augmented generation system.'), 'en');
  assert.equal(
    detectLanguage('DocuMind AI supports नेपाली भाषा र English documents seamlessly.'),
    'mixed'
  );
});

test('Document ingestion, Nepali Unicode indexing, and hybrid FTS5 RAG retrieval', async () => {
  const testUserId = `test_user_${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (
      id, email, password_hash, display_name, is_guest, role,
      ui_language, ai_output_language, ai_mode, ollama_url, ollama_model,
      cloud_consent_default, chunk_size, chunk_overlap, storage_quota_bytes, created_at
    ) VALUES (?, ?, NULL, 'Test User', 0, 'user', 'en', 'auto', 'offline', 'http://127.0.0.1:11434', 'llama3.2', 0, 500, 100, 10485760, ?)
  `).run(testUserId, `${testUserId}@example.com`, now);

  const tmpFile = path.resolve(process.cwd(), 'data', `${testUserId}-sample.txt`);
  fs.writeFileSync(
    tmpFile,
    'DocuMind AI Architecture Report\n\nनेपालको हिमाली क्षेत्रमा जलवायु परिवर्तनको असर तीव्र रूपमा देखिएको छ। Glacier retreat rate is 14 meters per year.',
    'utf8'
  );

  const docId = `doc_${Date.now()}`;
  db.prepare(`
    INSERT INTO documents (
      id, user_id, title, original_filename, mime_type, file_ext, file_size,
      sha256, storage_path, status, ocr_status, cloud_consented, created_at, updated_at
    ) VALUES (?, ?, 'Climate Study', 'sample.txt', 'text/plain', 'txt', 180, 'abc123', ?, 'pending', 'not_needed', 0, ?, ?)
  `).run(docId, testUserId, tmpFile, now, now);

  const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(testUserId) as never;
  await processDocumentIngestion(docId, userRow);

  const processed = db.prepare('SELECT status, detected_language, page_count FROM documents WHERE id = ?').get(docId) as {
    status: string;
    detected_language: string;
    page_count: number;
  };
  assert.equal(processed.status, 'ready');
  assert.equal(processed.detected_language, 'mixed');

  // Verify English query retrieval
  const enResults = await retrieveHybridPassages({
    user: userRow,
    query: 'glacier retreat meters',
    documentIds: [docId],
    topK: 3,
    allowCloudEmbedding: false,
  });
  assert.ok(enResults.length > 0);
  assert.equal(enResults[0].pageNumber, 1);

  // Verify Nepali Unicode query retrieval
  const neResults = await retrieveHybridPassages({
    user: userRow,
    query: 'जलवायु परिवर्तन',
    documentIds: [docId],
    topK: 3,
    allowCloudEmbedding: false,
  });
  assert.ok(neResults.length > 0);

  // Verify user isolation: another user cannot retrieve this user's doc
  const otherUser = { ...(userRow as Record<string, unknown>), id: 'other_isolated_user' } as never;
  const isolatedResults = await retrieveHybridPassages({
    user: otherUser,
    query: 'glacier',
    topK: 3,
    allowCloudEmbedding: false,
  });
  assert.equal(isolatedResults.length, 0);

  // Cleanup
  db.prepare('DELETE FROM chunks_fts WHERE user_id = ?').run(testUserId);
  db.prepare('DELETE FROM users WHERE id = ?').run(testUserId);
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
});

test('Multi-format exports (DOCX, PDF, MD, TXT, CSV)', async () => {
  for (const format of ['docx', 'pdf', 'md', 'txt', 'csv'] as const) {
    const out = await generateExportBuffer({
      title: 'Test Study Notes',
      content: 'Key finding: Nepal mountain hydrology report.\nनेपाली सारांश।',
      format,
    });
    assert.ok(out.buffer.length > 20, `Export ${format} should produce non-empty buffer`);
  }
});

test('Extra file formats ingestion (.json, .html, .svg, .rtf)', async () => {
  const testUserId = `test_extra_${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (
      id, email, password_hash, display_name, is_guest, role,
      ui_language, ai_output_language, ai_mode, ollama_url, ollama_model,
      cloud_consent_default, chunk_size, chunk_overlap, storage_quota_bytes, created_at
    ) VALUES (?, ?, NULL, 'Extra Format User', 0, 'user', 'en', 'auto', 'offline', 'http://127.0.0.1:11434', 'llama3.2', 0, 500, 100, 10485760, ?)
  `).run(testUserId, `${testUserId}@example.com`, now);

  const samples = [
    {
      ext: 'json',
      mime: 'application/json',
      content: JSON.stringify({ project: 'DocuMind Hydrology', peakFlow: 420 }),
      query: 'Hydrology',
    },
    {
      ext: 'html',
      mime: 'text/html',
      content: '<html><body><h1>Annual Audit</h1><table><tr><th>Metric</th><th>Value</th></tr><tr><td>Revenue</td><td>9500</td></tr></table></body></html>',
      query: 'Annual Audit',
    },
    {
      ext: 'svg',
      mime: 'image/svg+xml',
      content: '<svg xmlns="http://www.w3.org/2000/svg"><title>Architecture Diagram</title><text x="10" y="20">Gateway Cluster</text></svg>',
      query: 'Gateway Cluster',
    },
    {
      ext: 'rtf',
      mime: 'application/rtf',
      content: '{\\rtf1\\ansi Telemetry specification baseline validated.}',
      query: 'Telemetry specification',
    },
  ];

  const tmpPaths: string[] = [];
  try {
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(testUserId) as never;
    for (const s of samples) {
      const filePath = path.resolve(process.cwd(), 'data', `${testUserId}.${s.ext}`);
      tmpPaths.push(filePath);
      fs.writeFileSync(filePath, s.content, 'utf8');
      const docId = `doc_${s.ext}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      db.prepare(`
        INSERT INTO documents (
          id, user_id, title, original_filename, mime_type, file_ext, file_size,
          sha256, storage_path, status, ocr_status, cloud_consented, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'not_needed', 0, ?, ?)
      `).run(docId, testUserId, `Test ${s.ext}`, `sample.${s.ext}`, s.mime, s.ext, s.content.length, `sha_${docId}`, filePath, now, now);

      await processDocumentIngestion(docId, userRow);
      const row = db.prepare('SELECT status FROM documents WHERE id = ?').get(docId) as { status: string };
      assert.equal(row.status, 'ready', `${s.ext} ingestion should succeed`);

      const hits = await retrieveHybridPassages({
        user: userRow,
        query: s.query,
        documentIds: [docId],
        topK: 2,
        allowCloudEmbedding: false,
      });
      assert.ok(hits.length > 0, `${s.ext} content should be searchable via RAG`);
    }
  } finally {
    db.prepare('DELETE FROM chunks_fts WHERE user_id = ?').run(testUserId);
    db.prepare('DELETE FROM users WHERE id = ?').run(testUserId);
    for (const p of tmpPaths) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
});

