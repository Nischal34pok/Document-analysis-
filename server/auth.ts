import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { db, getOrCreateSessionSecret, logAudit, UPLOADS_DIR } from './db.ts';

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string;
  is_guest: number;
  role: string;
  ui_language: 'en' | 'ne';
  ai_output_language: 'auto' | 'en' | 'ne' | 'bilingual';
  ai_mode: 'automatic' | 'online' | 'offline';
  ollama_url: string;
  ollama_model: string;
  cloud_consent_default: number;
  chunk_size: number;
  chunk_overlap: number;
  storage_quota_bytes: number;
  created_at: string;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  isGuest: boolean;
  role: string;
  uiLanguage: 'en' | 'ne';
  aiOutputLanguage: 'auto' | 'en' | 'ne' | 'bilingual';
  aiMode: 'automatic' | 'online' | 'offline';
  ollamaUrl: string;
  ollamaModel: string;
  cloudConsentDefault: boolean;
  chunkSize: number;
  chunkOverlap: number;
  storageQuotaBytes: number;
  createdAt: string;
}

export interface AuthenticatedRequest extends Request {
  user?: UserRecord;
}

const COOKIE_NAME = 'documind_sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SESSION_SECRET = getOrCreateSessionSecret();

export function toPublicUser(row: UserRecord): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isGuest: row.is_guest === 1,
    role: row.role,
    uiLanguage: row.ui_language,
    aiOutputLanguage: row.ai_output_language,
    aiMode: row.ai_mode,
    ollamaUrl: row.ollama_url,
    ollamaModel: row.ollama_model,
    cloudConsentDefault: row.cloud_consent_default === 1,
    chunkSize: row.chunk_size,
    chunkOverlap: row.chunk_overlap,
    storageQuotaBytes: row.storage_quota_bytes,
    createdAt: row.created_at,
  };
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string | null): boolean {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derived = crypto.scryptSync(password, salt, 64);
  if (keyBuf.length !== derived.length) return false;
  return crypto.timingSafeEqual(keyBuf, derived);
}

function hashToken(rawToken: string): string {
  return crypto.createHmac('sha256', SESSION_SECRET).update(rawToken).digest('hex');
}

function setSessionCookie(res: Response, rawToken: string): void {
  const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.APP_URL?.startsWith('https://'));
  res.cookie(COOKIE_NAME, rawToken, {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

export function createSessionForUser(res: Response, userId: string): void {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(tokenHash, userId, expires.toISOString(), now.toISOString());
  setSessionCookie(res, rawToken);
}

export function createGuestUser(res: Response): UserRecord {
  const id = `guest_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const defaultOllama = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  db.prepare(`
    INSERT INTO users (
      id, email, password_hash, display_name, is_guest, role,
      ui_language, ai_output_language, ai_mode, ollama_url, ollama_model,
      cloud_consent_default, chunk_size, chunk_overlap, storage_quota_bytes, created_at
    ) VALUES (?, ?, NULL, ?, 1, 'guest', 'en', 'auto', 'automatic', ?, 'llama3.2', 0, 900, 160, 268435456, ?)
  `).run(id, `${id}@guest.documind.local`, 'Guest Researcher', defaultOllama, now);

  createSessionForUser(res, id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRecord;
}

export function attachUserMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  try {
    const rawToken = req.cookies?.[COOKIE_NAME];
    if (typeof rawToken === 'string' && rawToken.length > 10) {
      const tokenHash = hashToken(rawToken);
      const row = db.prepare(`
        SELECT u.* FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?
      `).get(tokenHash, new Date().toISOString()) as UserRecord | undefined;

      if (row) {
        req.user = row;
        return next();
      }
    }

    // Auto-provision an isolated Guest Workspace session on first visit
    req.user = createGuestUser(res);
    return next();
  } catch (err) {
    next(err);
  }
}

export function migrateUserWorkspaceData(fromUserId: string, toUserId: string): void {
  if (fromUserId === toUserId) return;
  const tx = db.transaction(() => {
    db.prepare('UPDATE folders SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);
    db.prepare('UPDATE documents SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);
    db.prepare('UPDATE chunks SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);
    db.prepare('UPDATE chunks_fts SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);
    db.prepare('UPDATE conversations SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);
    db.prepare('UPDATE messages SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);
    db.prepare('UPDATE study_sets SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);
    db.prepare('UPDATE quiz_attempts SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);
    db.prepare('UPDATE research_reports SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);
    db.prepare('UPDATE export_history SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);
  });
  tx();

  // Move files safely into destination user folder
  const srcDir = path.join(UPLOADS_DIR, fromUserId);
  const destDir = path.join(UPLOADS_DIR, toUserId);
  if (fs.existsSync(srcDir)) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const file of fs.readdirSync(srcDir)) {
      const oldPath = path.join(srcDir, file);
      const newPath = path.join(destDir, file);
      fs.renameSync(oldPath, newPath);
      db.prepare('UPDATE documents SET storage_path = ? WHERE user_id = ? AND storage_path = ?')
        .run(newPath, toUserId, oldPath);
    }
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
}

export function clearCurrentSession(req: Request, res: Response): void {
  const rawToken = req.cookies?.[COOKIE_NAME];
  if (typeof rawToken === 'string') {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(rawToken));
  }
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export function deleteUserAndAllData(userId: string, ipAddress?: string): void {
  logAudit({
    userId,
    action: 'account.delete',
    resourceType: 'user',
    resourceId: userId,
    details: 'User permanently deleted account and all associated documents and chats.',
    ipAddress: ipAddress ?? null,
  });

  const userDir = path.join(UPLOADS_DIR, path.basename(userId));
  if (fs.existsSync(userDir)) {
    fs.rmSync(userDir, { recursive: true, force: true });
  }

  db.prepare('DELETE FROM chunks_fts WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}
