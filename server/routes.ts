import { Type } from '@google/genai';
import express, { type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AIProviderError,
  checkOllamaStatus,
  ConsentRequiredError,
  generateWithAIRouter,
  getGeminiUsageSummary,
  type InlineImagePart,
  isGeminiConfigured,
  sanitizeOllamaUrl,
  transcribeAudioWithGemini,
} from './ai.ts';
import {
  type AuthenticatedRequest,
  clearCurrentSession,
  createGuestUser,
  createSessionForUser,
  deleteUserAndAllData,
  hashPassword,
  migrateUserWorkspaceData,
  toPublicUser,
  type UserRecord,
  verifyPassword,
} from './auth.ts';
import { db, logAudit } from './db.ts';
import { type ExportFormat, generateExportBuffer } from './exports.ts';
import {
  ALLOWED_EXTENSIONS,
  getSafeUserUploadDir,
  MAX_FILE_SIZE_BYTES,
  processDocumentIngestion,
} from './ingestion.ts';
import {
  answerDocumentQuestion,
  buildUntrustedContextBlock,
  retrieveHybridPassages,
} from './rag.ts';

export const apiRouter = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please wait a few minutes.' },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 45,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI rate limit reached. Please pause briefly before sending another request.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 10,
  },
});

function handleRouteError(res: Response, err: unknown): void {
  if (err instanceof ConsentRequiredError) {
    res.status(409).json({
      error: err.message,
      code: 'CONSENT_REQUIRED',
      documentIds: err.documentIds,
    });
    return;
  }
  if (err instanceof AIProviderError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code || 'AI_PROVIDER_ERROR',
      provider: err.provider,
    });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unexpected server error';
  res.status(500).json({ error: message });
}

function getUserOrFail(req: AuthenticatedRequest): UserRecord {
  if (!req.user) throw new Error('User session missing');
  return req.user;
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseAIJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    const startIdx = candidate.indexOf('{');
    const endIdx = candidate.lastIndexOf('}');
    if (startIdx >= 0 && endIdx > startIdx) {
      try {
        return JSON.parse(candidate.slice(startIdx, endIdx + 1)) as T;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Health & AI Provider Status
// ---------------------------------------------------------------------------
apiRouter.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

apiRouter.get('/ai/status', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const ollama = await checkOllamaStatus(user.ollama_url);
    const usageSummary = getGeminiUsageSummary(user.id);
    res.json({
      aiMode: user.ai_mode,
      cloudConsentDefault: user.cloud_consent_default === 1,
      billingMode: 'direct_gemini_api',
      online: {
        provider: 'gemini',
        configured: isGeminiConfigured(),
        textModel: 'gemini-4-hydrogen',
        embeddingModel: 'gemini-embedding-2',
      },
      offline: ollama,
      usageSummary,
    });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.post('/ai/test', aiLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const aiRes = await generateWithAIRouter({
      user,
      prompt: 'Reply with strictly one word: OK',
      systemInstruction: 'Connectivity test.',
      requiresDocumentConsent: false,
    });
    res.json({
      ok: true,
      providerUsed: aiRes.providerUsed,
      modelUsed: aiRes.modelUsed,
      modeNotice: aiRes.modeNotice,
    });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Authentication, Profile & Settings
// ---------------------------------------------------------------------------
apiRouter.get('/auth/me', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.post('/auth/register', authLimiter, (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUser = getUserOrFail(req);
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const displayName = String(req.body?.displayName || '').trim() || email.split('@')[0];
    const migrateGuest = req.body?.migrateGuest !== false;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters long.' });
      return;
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists.' });
      return;
    }

    const pwHash = hashPassword(password);
    const newId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO users (
        id, email, password_hash, display_name, is_guest, role,
        ui_language, ai_output_language, ai_mode, ollama_url, ollama_model,
        cloud_consent_default, chunk_size, chunk_overlap, storage_quota_bytes, created_at
      ) VALUES (?, ?, ?, ?, 0, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newId,
      email,
      pwHash,
      displayName,
      currentUser.ui_language,
      currentUser.ai_output_language,
      currentUser.ai_mode,
      currentUser.ollama_url,
      currentUser.ollama_model,
      currentUser.cloud_consent_default,
      currentUser.chunk_size,
      currentUser.chunk_overlap,
      currentUser.storage_quota_bytes,
      now
    );

    if (currentUser.is_guest === 1 && migrateGuest) {
      migrateUserWorkspaceData(currentUser.id, newId);
    }

    clearCurrentSession(req, res);
    createSessionForUser(res, newId);
    const created = db.prepare('SELECT * FROM users WHERE id = ?').get(newId) as UserRecord;
    logAudit({
      userId: newId,
      action: 'auth.register',
      resourceType: 'user',
      resourceId: newId,
      ipAddress: req.ip,
    });
    res.status(201).json({ user: toPublicUser(created) });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.post('/auth/login', authLimiter, (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUser = getUserOrFail(req);
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const migrateGuest = Boolean(req.body?.migrateGuest);

    const found = db.prepare('SELECT * FROM users WHERE email = ? AND is_guest = 0').get(email) as UserRecord | undefined;
    if (!found || !verifyPassword(password, found.password_hash)) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    if (currentUser.is_guest === 1 && migrateGuest) {
      migrateUserWorkspaceData(currentUser.id, found.id);
    }

    clearCurrentSession(req, res);
    createSessionForUser(res, found.id);
    logAudit({
      userId: found.id,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: found.id,
      ipAddress: req.ip,
    });
    res.json({ user: toPublicUser(found) });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.post('/auth/logout', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    logAudit({ userId: user.id, action: 'auth.logout', resourceType: 'user', resourceId: user.id, ipAddress: req.ip });
    clearCurrentSession(req, res);
    const guest = createGuestUser(res);
    res.json({ user: toPublicUser(guest) });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.patch('/auth/settings', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const b = req.body || {};

    const displayName = typeof b.displayName === 'string' && b.displayName.trim() ? b.displayName.trim().slice(0, 80) : user.display_name;
    const uiLanguage = b.uiLanguage === 'ne' ? 'ne' : b.uiLanguage === 'en' ? 'en' : user.ui_language;
    const aiOutputLanguage = ['auto', 'en', 'ne', 'bilingual'].includes(b.aiOutputLanguage)
      ? b.aiOutputLanguage
      : user.ai_output_language;
    const aiMode = ['automatic', 'online', 'offline'].includes(b.aiMode) ? b.aiMode : user.ai_mode;
    const ollamaUrl = typeof b.ollamaUrl === 'string' ? sanitizeOllamaUrl(b.ollamaUrl) : user.ollama_url;
    const ollamaModel = typeof b.ollamaModel === 'string' && b.ollamaModel.trim() ? b.ollamaModel.trim().slice(0, 80) : user.ollama_model;
    const cloudConsentDefault =
      typeof b.cloudConsentDefault === 'boolean' ? (b.cloudConsentDefault ? 1 : 0) : user.cloud_consent_default;
    const chunkSize =
      typeof b.chunkSize === 'number' ? Math.min(Math.max(Math.round(b.chunkSize), 300), 2500) : user.chunk_size;
    const chunkOverlap =
      typeof b.chunkOverlap === 'number'
        ? Math.min(Math.max(Math.round(b.chunkOverlap), 0), Math.floor(chunkSize / 2))
        : user.chunk_overlap;

    db.prepare(`
      UPDATE users
      SET display_name = ?, ui_language = ?, ai_output_language = ?, ai_mode = ?,
          ollama_url = ?, ollama_model = ?, cloud_consent_default = ?, chunk_size = ?, chunk_overlap = ?
      WHERE id = ?
    `).run(
      displayName,
      uiLanguage,
      aiOutputLanguage,
      aiMode,
      ollamaUrl,
      ollamaModel,
      cloudConsentDefault,
      chunkSize,
      chunkOverlap,
      user.id
    );

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as UserRecord;
    logAudit({
      userId: user.id,
      action: 'settings.update',
      resourceType: 'user',
      resourceId: user.id,
      details: `mode=${aiMode}, ui=${uiLanguage}, cloudDefault=${cloudConsentDefault}`,
    });
    res.json({ user: toPublicUser(updated) });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.delete('/auth/account', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    deleteUserAndAllData(user.id, req.ip);
    clearCurrentSession(req, res);
    const freshGuest = createGuestUser(res);
    res.json({ deleted: true, user: toPublicUser(freshGuest) });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Dashboard Summary
// ---------------------------------------------------------------------------
apiRouter.get('/dashboard', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const docs = db
      .prepare(
        `SELECT id, title, original_filename, file_ext, file_size, detected_language, page_count, status, ocr_status, ocr_error, cloud_consented, created_at, updated_at
         FROM documents WHERE user_id = ? ORDER BY created_at DESC`
      )
      .all(user.id) as Array<{
      id: string;
      title: string;
      original_filename: string;
      file_ext: string;
      file_size: number;
      detected_language: string;
      page_count: number;
      status: string;
      ocr_status: string;
      ocr_error: string | null;
      cloud_consented: number;
      created_at: string;
      updated_at: string;
    }>;

    const storageUsedBytes = docs.reduce((sum, d) => sum + (d.file_size || 0), 0);
    const recentQuestions = db
      .prepare(
        `SELECT m.id, m.conversation_id, m.content, m.created_at
         FROM messages m
         WHERE m.user_id = ? AND m.role = 'user'
         ORDER BY m.created_at DESC LIMIT 5`
      )
      .all(user.id);

    const recentSummaries = db
      .prepare(
        `SELECT id, title, analysis_json, updated_at
         FROM documents
         WHERE user_id = ? AND analysis_json != '{}'
         ORDER BY updated_at DESC LIMIT 5`
      )
      .all(user.id)
      .map((row: unknown) => {
        const r = row as { id: string; title: string; analysis_json: string; updated_at: string };
        const parsed = safeJsonParse<{ summary?: string }>(r.analysis_json, {});
        return {
          documentId: r.id,
          title: r.title,
          summaryPreview: (parsed.summary || '').slice(0, 180),
          updatedAt: r.updated_at,
        };
      })
      .filter((s) => s.summaryPreview.length > 0);

    const quizStats = db
      .prepare(
        `SELECT COUNT(*) AS attempts, COALESCE(AVG(CAST(score AS FLOAT) / NULLIF(total, 0) * 100), 0) AS avgScore
         FROM quiz_attempts WHERE user_id = ?`
      )
      .get(user.id) as { attempts: number; avgScore: number };

    res.json({
      totalDocuments: docs.length,
      readyDocuments: docs.filter((d) => d.status === 'ready').length,
      processingDocuments: docs.filter((d) => d.status === 'processing' || d.status === 'pending').length,
      failedDocuments: docs.filter((d) => d.status === 'ocr_failed' || d.status === 'error').length,
      storageUsedBytes,
      storageQuotaBytes: user.storage_quota_bytes,
      recentDocuments: docs.slice(0, 6),
      recentQuestions,
      recentSummaries,
      quizStats: {
        attempts: quizStats.attempts,
        avgScore: Math.round(quizStats.avgScore),
      },
    });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------
apiRouter.get('/folders', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const folders = db
      .prepare(
        `SELECT f.*, COUNT(d.id) AS document_count
         FROM folders f
         LEFT JOIN documents d ON d.folder_id = f.id AND d.user_id = f.user_id
         WHERE f.user_id = ?
         GROUP BY f.id
         ORDER BY f.name ASC`
      )
      .all(user.id);
    res.json({ folders });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.post('/folders', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const color = String(req.body?.color || '#1D4ED8').slice(0, 20);
    if (!name) {
      res.status(400).json({ error: 'Folder name is required.' });
      return;
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO folders (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      user.id,
      name,
      color,
      now
    );
    res.status(201).json({ folder: { id, user_id: user.id, name, color, created_at: now, document_count: 0 } });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.delete('/folders/:id', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    db.prepare('UPDATE documents SET folder_id = NULL WHERE folder_id = ? AND user_id = ?').run(req.params.id, user.id);
    db.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').run(req.params.id, user.id);
    res.json({ deleted: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Documents: Upload, List, Detail, Consent, Retry, Rename, Folder, Download, Delete
// ---------------------------------------------------------------------------
apiRouter.get('/documents', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const q = String(req.query.q || '').trim().toLowerCase();
    const folderId = String(req.query.folderId || '').trim();
    const status = String(req.query.status || '').trim();

    let sql = `
      SELECT id, folder_id, title, original_filename, mime_type, file_ext, file_size, sha256,
             detected_language, page_count, status, ocr_status, ocr_error, cloud_consented,
             metadata_json, error_message, created_at, updated_at
      FROM documents
      WHERE user_id = ?
    `;
    const params: unknown[] = [user.id];

    if (folderId) {
      sql += ' AND folder_id = ?';
      params.push(folderId);
    }
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (q) {
      sql += ' AND (LOWER(title) LIKE ? OR LOWER(original_filename) LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY created_at DESC';

    const rows = db.prepare(sql).all(...params);
    res.json({ documents: rows });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.post('/documents/upload', upload.array('files', 10), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({ error: 'No files were uploaded.' });
      return;
    }

    const folderId = typeof req.body?.folderId === 'string' && req.body.folderId ? req.body.folderId : null;
    const cloudConsented = req.body?.cloudConsented === 'true' || user.cloud_consent_default === 1 ? 1 : 0;

    const currentUsageRow = db
      .prepare('SELECT COALESCE(SUM(file_size), 0) AS used FROM documents WHERE user_id = ?')
      .get(user.id) as { used: number };
    let usedBytes = currentUsageRow.used;

    const uploadDir = getSafeUserUploadDir(user.id);
    const results: Array<{
      filename: string;
      status: 'accepted' | 'duplicate' | 'rejected';
      documentId?: string;
      reason?: string;
    }> = [];

    for (const file of files) {
      const safeOriginal = path.basename(file.originalname || 'document');
      const ext = path.extname(safeOriginal).replace(/^\./, '').toLowerCase();

      if (!ALLOWED_EXTENSIONS.has(ext)) {
        results.push({
          filename: safeOriginal,
          status: 'rejected',
          reason: `Unsupported file type ".${ext || 'unknown'}".`,
        });
        continue;
      }

      if (file.size === 0) {
        results.push({ filename: safeOriginal, status: 'rejected', reason: 'File is empty.' });
        continue;
      }

      if (usedBytes + file.size > user.storage_quota_bytes) {
        results.push({
          filename: safeOriginal,
          status: 'rejected',
          reason: 'Workspace storage quota exceeded.',
        });
        continue;
      }

      const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
      const dup = db
        .prepare('SELECT id, title FROM documents WHERE user_id = ? AND sha256 = ?')
        .get(user.id, sha256) as { id: string; title: string } | undefined;

      if (dup) {
        results.push({
          filename: safeOriginal,
          status: 'duplicate',
          documentId: dup.id,
          reason: `Identical file already exists as "${dup.title}".`,
        });
        continue;
      }

      const docId = crypto.randomUUID();
      const storedFilename = `${docId}.${ext}`;
      const storagePath = path.join(uploadDir, storedFilename);
      fs.writeFileSync(storagePath, file.buffer);
      usedBytes += file.size;

      const title = safeOriginal.replace(/\.[^.]+$/, '') || safeOriginal;
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO documents (
          id, user_id, folder_id, title, original_filename, mime_type, file_ext, file_size,
          sha256, storage_path, status, ocr_status, cloud_consented, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'not_needed', ?, ?, ?)
      `).run(
        docId,
        user.id,
        folderId,
        title,
        safeOriginal,
        file.mimetype || 'application/octet-stream',
        ext,
        file.size,
        sha256,
        storagePath,
        cloudConsented,
        now,
        now
      );

      logAudit({
        userId: user.id,
        action: 'document.upload',
        resourceType: 'document',
        resourceId: docId,
        details: `${safeOriginal} (${file.size} bytes)`,
        ipAddress: req.ip,
      });

      // Kick off background extraction/indexing
      void processDocumentIngestion(docId, user);

      results.push({
        filename: safeOriginal,
        status: 'accepted',
        documentId: docId,
      });
    }

    res.status(201).json({ results });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.get('/documents/:id', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const doc = db
      .prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?')
      .get(req.params.id, user.id) as Record<string, unknown> | undefined;

    if (!doc) {
      res.status(404).json({ error: 'Document not found.' });
      return;
    }

    res.json({
      document: {
        ...doc,
        pages: safeJsonParse(doc.pages_json as string, []),
        tables: safeJsonParse(doc.tables_json as string, []),
        metadata: safeJsonParse(doc.metadata_json as string, {}),
        analysis: safeJsonParse(doc.analysis_json as string, {}),
      },
    });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.patch('/documents/:id', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const doc = db.prepare('SELECT id FROM documents WHERE id = ? AND user_id = ?').get(req.params.id, user.id);
    if (!doc) {
      res.status(404).json({ error: 'Document not found.' });
      return;
    }

    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim().slice(0, 140) : undefined;
    const folderId = req.body?.folderId === null ? null : typeof req.body?.folderId === 'string' ? req.body.folderId : undefined;
    const cloudConsented = typeof req.body?.cloudConsented === 'boolean' ? (req.body.cloudConsented ? 1 : 0) : undefined;

    if (title !== undefined) {
      db.prepare('UPDATE documents SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(title, new Date().toISOString(), req.params.id, user.id);
    }
    if (folderId !== undefined) {
      db.prepare('UPDATE documents SET folder_id = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(folderId, new Date().toISOString(), req.params.id, user.id);
    }
    if (cloudConsented !== undefined) {
      db.prepare('UPDATE documents SET cloud_consented = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(cloudConsented, new Date().toISOString(), req.params.id, user.id);
      logAudit({
        userId: user.id,
        action: cloudConsented ? 'privacy.cloud_consent_granted' : 'privacy.cloud_consent_revoked',
        resourceType: 'document',
        resourceId: req.params.id,
      });
    }

    const updated = db.prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?').get(req.params.id, user.id);
    res.json({ document: updated });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.post('/documents/consent', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const documentIds = Array.isArray(req.body?.documentIds) ? (req.body.documentIds as string[]) : [];
    const rememberDefault = Boolean(req.body?.rememberDefault);

    if (rememberDefault) {
      db.prepare('UPDATE users SET cloud_consent_default = 1 WHERE id = ?').run(user.id);
    }

    if (documentIds.length > 0) {
      const placeholders = documentIds.map(() => '?').join(',');
      db.prepare(
        `UPDATE documents SET cloud_consented = 1, updated_at = ? WHERE user_id = ? AND id IN (${placeholders})`
      ).run(new Date().toISOString(), user.id, ...documentIds);
    }

    logAudit({
      userId: user.id,
      action: 'privacy.cloud_consent_granted',
      resourceType: 'document',
      details: `Consented ${documentIds.length} document(s); rememberDefault=${rememberDefault}`,
    });

    res.json({ consented: true, rememberDefault });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.post('/documents/:id/retry', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const doc = db.prepare('SELECT id FROM documents WHERE id = ? AND user_id = ?').get(req.params.id, user.id);
    if (!doc) {
      res.status(404).json({ error: 'Document not found.' });
      return;
    }
    if (req.body?.cloudConsented === true) {
      db.prepare('UPDATE documents SET cloud_consented = 1 WHERE id = ? AND user_id = ?').run(req.params.id, user.id);
    }
    await processDocumentIngestion(req.params.id, user);
    const updated = db.prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?').get(req.params.id, user.id);
    res.json({ document: updated });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.get('/documents/:id/download', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const doc = db
      .prepare('SELECT original_filename, mime_type, storage_path FROM documents WHERE id = ? AND user_id = ?')
      .get(req.params.id, user.id) as { original_filename: string; mime_type: string; storage_path: string } | undefined;

    if (!doc || !fs.existsSync(doc.storage_path)) {
      res.status(404).json({ error: 'Original file not found.' });
      return;
    }
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.original_filename)}"`);
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    const stream = fs.createReadStream(doc.storage_path);
    stream.on('error', (err) => {
      if (!res.headersSent) {
        handleRouteError(res, err);
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.get('/documents/:id/raw', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const doc = db
      .prepare('SELECT original_filename, mime_type, storage_path FROM documents WHERE id = ? AND user_id = ?')
      .get(req.params.id, user.id) as { original_filename: string; mime_type: string; storage_path: string } | undefined;

    if (!doc || !fs.existsSync(doc.storage_path)) {
      res.status(404).json({ error: 'Original file not found.' });
      return;
    }
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.original_filename)}"`);
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if ((doc.mime_type || '').includes('svg') || (doc.mime_type || '').includes('html')) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:;");
    }
    const stream = fs.createReadStream(doc.storage_path);
    stream.on('error', (err) => {
      if (!res.headersSent) {
        handleRouteError(res, err);
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.delete('/documents/:id', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const doc = db
      .prepare('SELECT id, title, storage_path FROM documents WHERE id = ? AND user_id = ?')
      .get(req.params.id, user.id) as { id: string; title: string; storage_path: string } | undefined;

    if (!doc) {
      res.status(404).json({ error: 'Document not found.' });
      return;
    }

    if (fs.existsSync(doc.storage_path)) {
      fs.unlinkSync(doc.storage_path);
    }

    db.prepare('DELETE FROM chunks_fts WHERE document_id = ? AND user_id = ?').run(doc.id, user.id);
    db.prepare('DELETE FROM documents WHERE id = ? AND user_id = ?').run(doc.id, user.id);

    logAudit({
      userId: user.id,
      action: 'document.delete',
      resourceType: 'document',
      resourceId: doc.id,
      details: `Deleted "${doc.title}"`,
      ipAddress: req.ip,
    });

    res.json({ deleted: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Document AI Understanding & Translation
// ---------------------------------------------------------------------------
apiRouter.post('/documents/:id/analyze', aiLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const doc = db
      .prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?')
      .get(req.params.id, user.id) as {
      id: string;
      title: string;
      status: string;
      cloud_consented: number;
      extracted_text: string;
      pages_json: string;
      tables_json: string;
      analysis_json: string;
    } | undefined;

    if (!doc) {
      res.status(404).json({ error: 'Document not found.' });
      return;
    }
    if (doc.status !== 'ready') {
      res.status(400).json({ error: 'Document text is not ready yet. Check processing or OCR status.' });
      return;
    }

    const action = String(req.body?.action || 'full_analysis');
    const outputLanguage = String(req.body?.language || user.ai_output_language || 'en');
    const pageNumber = typeof req.body?.pageNumber === 'number' ? req.body.pageNumber : null;
    const paragraphText = typeof req.body?.paragraphText === 'string' ? req.body.paragraphText : '';

    const consented = doc.cloud_consented === 1 || user.cloud_consent_default === 1;
    const langDirective =
      outputLanguage === 'ne'
        ? 'Write ALL output fields in Nepali (Devanagari Unicode).'
        : outputLanguage === 'bilingual'
        ? 'Write clear English followed by Nepali (Devanagari Unicode) where helpful.'
        : 'Write all output fields in clear English.';

    if (action === 'page_summary' && pageNumber) {
      const pages = safeJsonParse<Array<{ pageNumber: number; text: string }>>(doc.pages_json, []);
      const target = pages.find((p) => p.pageNumber === pageNumber);
      if (!target) {
        res.status(404).json({ error: `Page ${pageNumber} not found.` });
        return;
      }
      const aiRes = await generateWithAIRouter({
        user,
        requiresDocumentConsent: true,
        documentsConsented: consented,
        unconsentedDocIds: [doc.id],
        systemInstruction: `Summarize only the provided page excerpt accurately. ${langDirective}`,
        prompt: `Document: ${doc.title} (Page ${pageNumber})\n<untrusted_document_content>\n${target.text.slice(0, 12000)}\n</untrusted_document_content>\n\nProvide a concise page summary and key takeaways.`,
      });
      res.json({ result: aiRes.text, providerUsed: aiRes.providerUsed, modeNotice: aiRes.modeNotice });
      return;
    }

    if (action === 'explain' && paragraphText) {
      const aiRes = await generateWithAIRouter({
        user,
        requiresDocumentConsent: true,
        documentsConsented: consented,
        unconsentedDocIds: [doc.id],
        systemInstruction: `Explain the given passage clearly in plain language without inventing outside facts. ${langDirective}`,
        prompt: `Explain this passage from "${doc.title}":\n<untrusted_document_content>\n${paragraphText.slice(0, 6000)}\n</untrusted_document_content>`,
      });
      res.json({ result: aiRes.text, providerUsed: aiRes.providerUsed, modeNotice: aiRes.modeNotice });
      return;
    }

    if (action === 'table_analysis') {
      const tables = safeJsonParse<Array<{ title: string; headers: string[]; rows: string[][] }>>(doc.tables_json, []);
      if (tables.length === 0) {
        res.json({ result: 'No structured tables were extracted from this document.' });
        return;
      }
      const aiRes = await generateWithAIRouter({
        user,
        requiresDocumentConsent: true,
        documentsConsented: consented,
        unconsentedDocIds: [doc.id],
        systemInstruction: `Analyze the extracted tables accurately, highlighting trends, anomalies, and key numbers. ${langDirective}`,
        prompt: `Extracted Tables from "${doc.title}":\n<untrusted_document_content>\n${JSON.stringify(tables).slice(0, 18000)}\n</untrusted_document_content>`,
      });
      res.json({ result: aiRes.text, providerUsed: aiRes.providerUsed, modeNotice: aiRes.modeNotice });
      return;
    }

    // Full comprehensive document understanding (structured JSON)
    const excerpt = doc.extracted_text.slice(0, 26000);
    const aiRes = await generateWithAIRouter({
      user,
      requiresDocumentConsent: true,
      documentsConsented: consented,
      unconsentedDocIds: [doc.id],
      systemInstruction: `Perform thorough document intelligence analysis strictly grounded in the uploaded text. ${langDirective}`,
      prompt: `Analyze "${doc.title}":\n<untrusted_document_content>\n${excerpt}\n</untrusted_document_content>`,
      jsonSchema: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING, description: 'Executive summary of the document.' },
          classification: { type: Type.STRING, description: 'Document category/type (e.g., Legal Contract, Academic Paper, Policy Report).' },
          keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
          topics: { type: Type.ARRAY, items: { type: Type.STRING } },
          keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
          definitions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                term: { type: Type.STRING },
                definition: { type: Type.STRING },
              },
            },
          },
          namedEntities: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'People, organizations, and places mentioned.' },
          datesAndNumbers: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Key dates, quantities, and monetary or statistical figures.' },
          outline: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                heading: { type: Type.STRING },
                summary: { type: Type.STRING },
              },
            },
          },
          chapterSummaries: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                section: { type: Type.STRING },
                summary: { type: Type.STRING },
              },
            },
          },
        },
      },
    });

    const parsed = parseAIJson<Record<string, unknown>>(aiRes.text, { summary: aiRes.text });
    db.prepare('UPDATE documents SET analysis_json = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(JSON.stringify(parsed), new Date().toISOString(), doc.id, user.id);

    res.json({
      analysis: parsed,
      providerUsed: aiRes.providerUsed,
      modelUsed: aiRes.modelUsed,
      modeNotice: aiRes.modeNotice,
    });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.post('/documents/:id/translate', aiLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const doc = db
      .prepare('SELECT id, title, status, cloud_consented, extracted_text, pages_json FROM documents WHERE id = ? AND user_id = ?')
      .get(req.params.id, user.id) as {
      id: string;
      title: string;
      status: string;
      cloud_consented: number;
      extracted_text: string;
      pages_json: string;
    } | undefined;

    if (!doc) {
      res.status(404).json({ error: 'Document not found.' });
      return;
    }
    if (doc.status !== 'ready') {
      res.status(400).json({ error: 'Document must be processed before translating.' });
      return;
    }

    const targetLanguage = req.body?.targetLanguage === 'en' ? 'en' : req.body?.targetLanguage === 'bilingual' ? 'bilingual' : 'ne';
    const pageNumber = typeof req.body?.pageNumber === 'number' ? req.body.pageNumber : null;
    const customText = typeof req.body?.text === 'string' && req.body.text.trim() ? req.body.text.trim() : '';

    let sourceText = customText;
    if (!sourceText) {
      if (pageNumber) {
        const pages = safeJsonParse<Array<{ pageNumber: number; text: string }>>(doc.pages_json, []);
        sourceText = pages.find((p) => p.pageNumber === pageNumber)?.text || '';
      } else {
        sourceText = doc.extracted_text.slice(0, 14000);
      }
    }

    if (!sourceText) {
      res.status(400).json({ error: 'No text found for translation.' });
      return;
    }

    const consented = doc.cloud_consented === 1 || user.cloud_consent_default === 1;
    const directive =
      targetLanguage === 'ne'
        ? 'Translate the text accurately into natural, formal Nepali using proper Devanagari Unicode script.'
        : targetLanguage === 'en'
        ? 'Translate the text accurately into clear, natural English.'
        : 'Provide a structured bilingual output: section-by-section English text paired with its accurate Nepali (Devanagari Unicode) translation and key glossary terms.';

    const aiRes = await generateWithAIRouter({
      user,
      requiresDocumentConsent: true,
      documentsConsented: consented,
      unconsentedDocIds: [doc.id],
      systemInstruction: `You are an expert English-Nepali technical and literary translator. ${directive}`,
      prompt: `Source content from "${doc.title}":\n<untrusted_document_content>\n${sourceText}\n</untrusted_document_content>`,
    });

    res.json({
      translation: aiRes.text,
      targetLanguage,
      providerUsed: aiRes.providerUsed,
      modeNotice: aiRes.modeNotice,
    });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Hybrid Search
// ---------------------------------------------------------------------------
apiRouter.post('/search', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const query = String(req.body?.query || '').trim();
    const documentIds = Array.isArray(req.body?.documentIds) ? (req.body.documentIds as string[]) : undefined;
    const topK = typeof req.body?.topK === 'number' ? req.body.topK : 10;

    if (!query) {
      res.status(400).json({ error: 'Search query cannot be empty.' });
      return;
    }

    const allowCloudEmbedding = user.cloud_consent_default === 1;
    const passages = await retrieveHybridPassages({
      user,
      query,
      documentIds,
      topK,
      allowCloudEmbedding,
    });

    res.json({ results: passages });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// AI Chat Studio (Document Chat + General Chat)
// ---------------------------------------------------------------------------
apiRouter.get('/chat/conversations', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const conversations = db
      .prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC')
      .all(user.id)
      .map((c: unknown) => {
        const row = c as Record<string, unknown>;
        return {
          ...row,
          documentIds: safeJsonParse(row.document_ids_json as string, []),
        };
      });
    res.json({ conversations });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.post('/chat/conversations', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const title = String(req.body?.title || 'New Conversation').trim().slice(0, 100);
    const chatType = req.body?.chatType === 'general' ? 'general' : 'document';
    const documentIds = Array.isArray(req.body?.documentIds) ? req.body.documentIds : [];
    const language = ['auto', 'en', 'ne', 'bilingual'].includes(req.body?.language) ? req.body.language : user.ai_output_language;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO conversations (id, user_id, title, chat_type, document_ids_json, language, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.id, title, chatType, JSON.stringify(documentIds), language, now, now);

    res.status(201).json({
      conversation: {
        id,
        user_id: user.id,
        title,
        chat_type: chatType,
        documentIds,
        language,
        created_at: now,
        updated_at: now,
      },
    });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.patch('/chat/conversations/:id', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, user.id);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }

    const b = req.body || {};
    if (Array.isArray(b.documentIds)) {
      db.prepare('UPDATE conversations SET document_ids_json = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(JSON.stringify(b.documentIds), new Date().toISOString(), req.params.id, user.id);
    }
    if (b.chatType === 'general' || b.chatType === 'document') {
      db.prepare('UPDATE conversations SET chat_type = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(b.chatType, new Date().toISOString(), req.params.id, user.id);
    }
    if (['auto', 'en', 'ne', 'bilingual'].includes(b.language)) {
      db.prepare('UPDATE conversations SET language = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(b.language, new Date().toISOString(), req.params.id, user.id);
    }

    res.json({ updated: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.get('/chat/conversations/:id/messages', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, user.id);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    const messages = db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at ASC')
      .all(req.params.id, user.id)
      .map((m: unknown) => {
        const row = m as Record<string, unknown>;
        return {
          ...row,
          citations: safeJsonParse(row.citations_json as string, []),
        };
      });
    res.json({ messages });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.post('/chat/conversations/:id/messages', aiLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const conv = db
      .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
      .get(req.params.id, user.id) as {
      id: string;
      title: string;
      chat_type: 'document' | 'general';
      document_ids_json: string;
      language: 'auto' | 'en' | 'ne' | 'bilingual';
    } | undefined;

    if (!conv) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }

    const content = String(req.body?.content || '').trim();
    const regenerate = Boolean(req.body?.regenerate);
    const overrideLanguage = ['auto', 'en', 'ne', 'bilingual'].includes(req.body?.language)
      ? (req.body.language as 'auto' | 'en' | 'ne' | 'bilingual')
      : conv.language;
    const overrideChatType = req.body?.chatType === 'general' ? 'general' : req.body?.chatType === 'document' ? 'document' : conv.chat_type;
    const overrideDocIds = Array.isArray(req.body?.documentIds)
      ? (req.body.documentIds as string[])
      : safeJsonParse<string[]>(conv.document_ids_json, []);

    const rawAttachment = req.body?.imageAttachment as
      | { mimeType?: string; dataUrlOrBase64?: string; filename?: string }
      | undefined;
    const inlineImages: InlineImagePart[] = [];
    let attachmentLabel = '';
    if (rawAttachment && typeof rawAttachment.dataUrlOrBase64 === 'string') {
      const allowedMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
      const mimeType = String(rawAttachment.mimeType || '').toLowerCase();
      if (!allowedMimes.has(mimeType)) {
        res.status(400).json({ error: 'Attached chat image must be PNG, JPEG, WebP, or GIF.' });
        return;
      }
      const cleanBase64 = rawAttachment.dataUrlOrBase64.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').trim();
      if (cleanBase64.length > 5_600_000) {
        res.status(413).json({ error: 'Attached chat image exceeds 4 MB limit.' });
        return;
      }
      if (cleanBase64) {
        inlineImages.push({ mimeType, base64Data: cleanBase64 });
        const safeName = path.basename(String(rawAttachment.filename || 'image')).slice(0, 60);
        attachmentLabel = `[Attached Image: ${safeName}]`;
      }
    }

    if (!content && !regenerate && inlineImages.length === 0) {
      res.status(400).json({ error: 'Message content cannot be empty.' });
      return;
    }

    const effectiveContent = content || 'Analyze this attached image carefully.';
    const storedUserText = attachmentLabel ? `${attachmentLabel}\n${effectiveContent}` : effectiveContent;

    const priorMsgs = db
      .prepare('SELECT id, role, content FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at ASC')
      .all(conv.id, user.id) as Array<{ id: string; role: 'user' | 'assistant'; content: string }>;

    let questionText = effectiveContent;
    let historySource = priorMsgs;

    if (regenerate && priorMsgs.length > 0) {
      const lastMsg = priorMsgs[priorMsgs.length - 1];
      if (lastMsg.role === 'assistant') {
        db.prepare('DELETE FROM messages WHERE id = ? AND user_id = ?').run(lastMsg.id, user.id);
        historySource = priorMsgs.slice(0, -1);
      }
      const lastUserMsg = [...historySource].reverse().find((m) => m.role === 'user');
      if (!lastUserMsg) {
        res.status(400).json({ error: 'Nothing to regenerate.' });
        return;
      }
      questionText = lastUserMsg.content;
    } else {
      const userMsgId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO messages (id, conversation_id, user_id, role, content, citations_json, created_at)
        VALUES (?, ?, ?, 'user', ?, '[]', ?)
      `).run(userMsgId, conv.id, user.id, storedUserText, new Date().toISOString());

      if (conv.title === 'New Conversation' && priorMsgs.length === 0) {
        db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(effectiveContent.slice(0, 56), conv.id);
      }
    }

    const formattedHistory = historySource.slice(-10).map((m) => ({
      role: (m.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
      text: m.content,
    }));

    let assistantText = '';
    let citations: unknown[] = [];
    let providerUsed = 'gemini';
    let modeNotice: string | undefined;

    if (overrideChatType === 'general') {
      const langDirective =
        overrideLanguage === 'ne'
          ? 'Respond in Nepali (Devanagari Unicode).'
          : overrideLanguage === 'en'
          ? 'Respond in English.'
          : overrideLanguage === 'bilingual'
          ? 'Respond bilingually in English and Nepali (Devanagari Unicode).'
          : 'Respond in the same language as the user.';

      const aiRes = await generateWithAIRouter({
        user,
        prompt: questionText,
        systemInstruction: `You are DocuMind AI in General Assistant mode (not querying uploaded documents). ${langDirective}`,
        requiresDocumentConsent: false,
        history: formattedHistory,
        inlineImages,
      });
      assistantText = aiRes.text;
      providerUsed = aiRes.providerUsed;
      modeNotice = aiRes.modeNotice;
    } else {
      const ragRes = await answerDocumentQuestion({
        user,
        question: questionText,
        documentIds: overrideDocIds,
        outputLanguage: overrideLanguage,
        history: formattedHistory,
        inlineImages,
      });
      assistantText = ragRes.answer;
      citations = ragRes.citations;
      providerUsed = ragRes.providerUsed;
      modeNotice = ragRes.modeNotice;
    }

    const assistantMsgId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO messages (id, conversation_id, user_id, role, content, citations_json, provider_used, mode_notice, created_at)
      VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?)
    `).run(assistantMsgId, conv.id, user.id, assistantText, JSON.stringify(citations), providerUsed, modeNotice || null, now);

    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conv.id);

    const updatedMessages = db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at ASC')
      .all(conv.id, user.id)
      .map((m: unknown) => {
        const row = m as Record<string, unknown>;
        return { ...row, citations: safeJsonParse(row.citations_json as string, []) };
      });

    res.json({ messages: updatedMessages });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.delete('/chat/conversations/:id', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(req.params.id, user.id);
    res.json({ deleted: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Voice Audio Transcription
// ---------------------------------------------------------------------------
apiRouter.post('/voice/transcribe', aiLimiter, upload.single('audio'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    if (!req.file) {
      res.status(400).json({ error: 'Audio recording file is required.' });
      return;
    }
    if (user.ai_mode === 'offline') {
      res.status(400).json({ error: 'Server audio transcription requires Online or Automatic mode. Use browser speech input offline.' });
      return;
    }
    const transcript = await transcribeAudioWithGemini({
      base64Audio: req.file.buffer.toString('base64'),
      mimeType: req.file.mimetype || 'audio/webm',
      languageHint: typeof req.body?.language === 'string' ? req.body.language : 'auto',
      userId: user.id,
    });
    res.json({ transcript });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// AI Study Assistant
// ---------------------------------------------------------------------------
apiRouter.get('/study/sets', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const sets = db
      .prepare('SELECT * FROM study_sets WHERE user_id = ? ORDER BY created_at DESC')
      .all(user.id)
      .map((s: unknown) => {
        const row = s as Record<string, unknown>;
        return {
          ...row,
          documentIds: safeJsonParse(row.document_ids_json as string, []),
          content: safeJsonParse(row.content_json as string, {}),
        };
      });
    const attempts = db
      .prepare('SELECT * FROM quiz_attempts WHERE user_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(user.id)
      .map((a: unknown) => {
        const row = a as Record<string, unknown>;
        return {
          ...row,
          weakTopics: safeJsonParse(row.weak_topics_json as string, []),
        };
      });
    res.json({ studySets: sets, attempts });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.post('/study/generate', aiLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const documentIds = Array.isArray(req.body?.documentIds) ? (req.body.documentIds as string[]) : [];
    const kind = String(req.body?.kind || 'mcq');
    const difficulty = String(req.body?.difficulty || 'intermediate');
    const language = String(req.body?.language || 'en');
    const count = Math.min(Math.max(Number(req.body?.count || 6), 3), 15);
    const topicFocus = String(req.body?.topic || '').trim();

    if (documentIds.length === 0) {
      res.status(400).json({ error: 'Select at least one ready document to generate study material.' });
      return;
    }

    const placeholders = documentIds.map(() => '?').join(',');
    const docs = db
      .prepare(`SELECT id, title, cloud_consented, extracted_text FROM documents WHERE user_id = ? AND status = 'ready' AND id IN (${placeholders})`)
      .all(user.id, ...documentIds) as Array<{ id: string; title: string; cloud_consented: number; extracted_text: string }>;

    if (docs.length === 0) {
      res.status(400).json({ error: 'Selected documents are not ready yet.' });
      return;
    }

    const unconsented = user.cloud_consent_default === 1 ? [] : docs.filter((d) => d.cloud_consented !== 1).map((d) => d.id);
    const consented = unconsented.length === 0;

    const combinedText = docs
      .map((d) => `### Document: ${d.title}\n<untrusted_document_content>\n${d.extracted_text.slice(0, 12000)}\n</untrusted_document_content>`)
      .join('\n\n');

    const langDirective =
      language === 'ne'
        ? 'Generate ALL questions, options, answers, explanations, and notes in Nepali (Devanagari Unicode).'
        : language === 'bilingual'
        ? 'Provide clear English alongside Nepali (Devanagari Unicode) translations.'
        : 'Generate all content in clear English.';

    const difficultyDirective = `Difficulty level: ${difficulty.toUpperCase()} (${topicFocus ? `Focus topic: ${topicFocus}` : 'cover core concepts evenly'}).`;

    let schema: Record<string, unknown>;
    let taskInstruction = '';

    if (kind === 'mcq' || kind === 'quiz') {
      taskInstruction = `Generate ${count} multiple-choice questions strictly grounded in the documents.`;
      schema = {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          questions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                question: { type: Type.STRING },
                options: { type: Type.ARRAY, items: { type: Type.STRING } },
                correctIndex: { type: Type.INTEGER },
                explanation: { type: Type.STRING },
                topic: { type: Type.STRING },
              },
            },
          },
        },
      };
    } else if (kind === 'flashcards') {
      taskInstruction = `Generate ${count} high-retention flashcards (front prompt, concise back answer, and source topic).`;
      schema = {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          cards: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                front: { type: Type.STRING },
                back: { type: Type.STRING },
                topic: { type: Type.STRING },
              },
            },
          },
        },
      };
    } else if (kind === 'short_answer' || kind === 'long_answer') {
      taskInstruction = `Generate ${count} ${kind === 'short_answer' ? 'short-answer' : 'long-answer essay'} exam questions with model answers and grading rubrics.`;
      schema = {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                question: { type: Type.STRING },
                modelAnswer: { type: Type.STRING },
                keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
                topic: { type: Type.STRING },
              },
            },
          },
        },
      };
    } else {
      // revision_notes, chapter_notes, study_plan
      taskInstruction =
        kind === 'study_plan'
          ? 'Create a structured day-by-day study plan with daily objectives, active recall exercises, and time allocations based on the documents.'
          : 'Create comprehensive, well-structured revision and chapter-wise study notes with definitions, formulas/dates, and key takeaways.';
      schema = {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          markdownNotes: { type: Type.STRING },
          sections: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                heading: { type: Type.STRING },
                summary: { type: Type.STRING },
                bulletPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
            },
          },
        },
      };
    }

    const aiRes = await generateWithAIRouter({
      user,
      requiresDocumentConsent: true,
      documentsConsented: consented,
      unconsentedDocIds: unconsented,
      systemInstruction: `You are DocuMind Study Coach. ${taskInstruction} ${difficultyDirective} ${langDirective}`,
      prompt: combinedText,
      jsonSchema: schema as never,
    });

    const parsed = parseAIJson<Record<string, unknown>>(aiRes.text, { markdownNotes: aiRes.text });
    const title = String(parsed.title || `${docs[0].title} — ${kind.replace('_', ' ')}`);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO study_sets (id, user_id, title, document_ids_json, kind, difficulty, language, content_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.id, title, JSON.stringify(documentIds), kind, difficulty, language, JSON.stringify(parsed), now);

    res.status(201).json({
      studySet: {
        id,
        title,
        documentIds,
        kind,
        difficulty,
        language,
        content: parsed,
        created_at: now,
      },
      providerUsed: aiRes.providerUsed,
      modeNotice: aiRes.modeNotice,
    });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.post('/study/attempts', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const studySetId = String(req.body?.studySetId || '');
    const score = Number(req.body?.score || 0);
    const total = Number(req.body?.total || 0);
    const weakTopics = Array.isArray(req.body?.weakTopics) ? req.body.weakTopics : [];
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];

    const setExists = db.prepare('SELECT id FROM study_sets WHERE id = ? AND user_id = ?').get(studySetId, user.id);
    if (!setExists) {
      res.status(404).json({ error: 'Study set not found.' });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO quiz_attempts (id, user_id, study_set_id, score, total, weak_topics_json, answers_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.id, studySetId, score, total, JSON.stringify(weakTopics), JSON.stringify(answers), now);

    res.status(201).json({ id, score, total, weakTopics, created_at: now });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.delete('/study/sets/:id', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    db.prepare('DELETE FROM study_sets WHERE id = ? AND user_id = ?').run(req.params.id, user.id);
    res.json({ deleted: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Document Research Assistant
// ---------------------------------------------------------------------------
apiRouter.get('/research/reports', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const reports = db
      .prepare('SELECT * FROM research_reports WHERE user_id = ? ORDER BY created_at DESC')
      .all(user.id)
      .map((r: unknown) => {
        const row = r as Record<string, unknown>;
        return {
          ...row,
          documentIds: safeJsonParse(row.document_ids_json as string, []),
          report: safeJsonParse(row.report_json as string, {}),
        };
      });
    res.json({ reports });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.post('/research/analyze', aiLimiter, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const documentIds = Array.isArray(req.body?.documentIds) ? (req.body.documentIds as string[]) : [];
    const mode = String(req.body?.mode || 'report'); // compare | contradictions | report | references
    const query = String(req.body?.query || 'Synthesize key findings across the selected documents.').trim();
    const language = String(req.body?.language || 'en');

    if (documentIds.length === 0) {
      res.status(400).json({ error: 'Select at least one ready document for research analysis.' });
      return;
    }

    const placeholders = documentIds.map(() => '?').join(',');
    const docs = db
      .prepare(`SELECT id, title, cloud_consented, extracted_text FROM documents WHERE user_id = ? AND status = 'ready' AND id IN (${placeholders})`)
      .all(user.id, ...documentIds) as Array<{ id: string; title: string; cloud_consented: number; extracted_text: string }>;

    if (docs.length === 0) {
      res.status(400).json({ error: 'Selected documents are not ready.' });
      return;
    }

    const unconsented = user.cloud_consent_default === 1 ? [] : docs.filter((d) => d.cloud_consented !== 1).map((d) => d.id);
    const consented = unconsented.length === 0;

    // Retrieve top passages across selected docs AND include leading context from each doc
    const passages = await retrieveHybridPassages({
      user,
      query,
      documentIds,
      topK: 10,
      allowCloudEmbedding: consented,
    });

    const contextBlock = buildUntrustedContextBlock(passages);
    const docPreviews = docs
      .map((d) => `Document "${d.title}":\n<untrusted_document_content>\n${d.extracted_text.slice(0, 5000)}\n</untrusted_document_content>`)
      .join('\n\n');

    const langDirective =
      language === 'ne'
        ? 'Write all report sections in Nepali (Devanagari Unicode).'
        : language === 'bilingual'
        ? 'Provide English analysis paired with Nepali (Devanagari Unicode) summaries.'
        : 'Write all report sections in clear academic English.';

    const modeDirective =
      mode === 'compare'
        ? 'Compare the selected documents across methodologies, claims, metrics, scope, and conclusions.'
        : mode === 'contradictions'
        ? 'Identify explicit contradictions, numerical discrepancies, or conflicting statements between the documents. Never invent contradictions if none exist.'
        : mode === 'references'
        ? 'Extract all cited references, laws, organizations, standards, and external sources mentioned in the documents.'
        : 'Generate a structured research synthesis report answering the research focus with verified document citations.';

    const aiRes = await generateWithAIRouter({
      user,
      requiresDocumentConsent: true,
      documentsConsented: consented,
      unconsentedDocIds: unconsented,
      systemInstruction: `You are DocuMind Research Analyst. ${modeDirective} ${langDirective} Cite document titles and page numbers strictly from the provided passages.`,
      prompt: `Research Focus: ${query}\n\nRetrieved High-Relevance Passages:\n${contextBlock}\n\nDocument Previews:\n${docPreviews}`,
      jsonSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          executiveSummary: { type: Type.STRING },
          comparisonMatrix: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                dimension: { type: Type.STRING },
                findings: { type: Type.STRING },
              },
            },
          },
          contradictions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                topic: { type: Type.STRING },
                detail: { type: Type.STRING },
              },
            },
          },
          extractedReferences: { type: Type.ARRAY, items: { type: Type.STRING } },
          structuredMarkdown: { type: Type.STRING },
        },
      },
    });

    const parsed = parseAIJson<Record<string, unknown>>(aiRes.text, { structuredMarkdown: aiRes.text });
    const title = String(parsed.title || `Research Report — ${docs.map((d) => d.title).join(', ').slice(0, 60)}`);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO research_reports (id, user_id, title, query, document_ids_json, report_json, language, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.id, title, query, JSON.stringify(documentIds), JSON.stringify({ ...parsed, citations: passages }), language, now);

    res.status(201).json({
      reportRecord: {
        id,
        title,
        query,
        documentIds,
        report: { ...parsed, citations: passages },
        language,
        created_at: now,
      },
      providerUsed: aiRes.providerUsed,
      modeNotice: aiRes.modeNotice,
    });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.delete('/research/reports/:id', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    db.prepare('DELETE FROM research_reports WHERE id = ? AND user_id = ?').run(req.params.id, user.id);
    res.json({ deleted: true });
  } catch (err) {
    handleRouteError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Exports & Audit Logs
// ---------------------------------------------------------------------------
apiRouter.get('/exports/history', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const history = db
      .prepare('SELECT * FROM export_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 30')
      .all(user.id);
    res.json({ history });
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.post('/exports', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const title = String(req.body?.title || 'DocuMind Export').trim().slice(0, 120);
    const content = String(req.body?.content || '');
    const format = (['pdf', 'docx', 'md', 'txt', 'csv'].includes(req.body?.format) ? req.body.format : 'md') as ExportFormat;
    const sourceType = String(req.body?.sourceType || 'document');
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : undefined;

    if (!content && (!rows || rows.length === 0)) {
      res.status(400).json({ error: 'Export content cannot be empty.' });
      return;
    }

    const exported = await generateExportBuffer({ title, content, format, rows });

    db.prepare(`
      INSERT INTO export_history (id, user_id, title, format, source_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), user.id, title, format, sourceType, new Date().toISOString());

    res.setHeader('Content-Type', exported.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(exported.filename)}"`);
    res.send(exported.buffer);
  } catch (err) {
    handleRouteError(res, err);
  }
});

apiRouter.get('/audit-logs', (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = getUserOrFail(req);
    const logs = db
      .prepare('SELECT * FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(user.id);
    res.json({ logs });
  } catch (err) {
    handleRouteError(res, err);
  }
});
