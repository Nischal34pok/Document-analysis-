export class ApiConsentError extends Error {
  documentIds: string[];
  constructor(message: string, documentIds: string[]) {
    super(message);
    this.name = 'ApiConsentError';
    this.documentIds = documentIds;
  }
}

export class ApiError extends Error {
  status: number;
  code: string;
  provider?: string;
  retryable: boolean;

  constructor(params: { message: string; status: number; code?: string; provider?: string }) {
    super(params.message);
    this.name = 'ApiError';
    this.status = params.status;
    this.code = params.code || `HTTP_${params.status}`;
    this.provider = params.provider;
    this.retryable = params.status === 429 || params.status >= 500 || params.status === 0;
  }
}

export function isAIUnavailableError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return (
      err.code === 'AI_PROVIDER_ERROR' ||
      err.code === 'GEMINI_QUOTA_EXCEEDED' ||
      err.code === 'GEMINI_KEY_INVALID' ||
      err.code === 'GEMINI_UNCONFIGURED' ||
      err.code === 'OLLAMA_UNREACHABLE' ||
      err.status === 502 ||
      err.status === 503 ||
      err.status === 504 ||
      err.status === 429
    );
  }
  return false;
}

export function isQuotaExceededError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 429 || err.code === 'GEMINI_QUOTA_EXCEEDED');
}

export function getErrorMessage(err: unknown, fallback = 'An unexpected error occurred.'): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return fallback;
}

export interface ApiRequestOptions extends RequestInit {
  timeoutMs?: number;
}

export async function apiRequest<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
  const { timeoutMs = 60000, headers, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      credentials: 'include',
      signal: controller.signal,
      headers: {
        ...(fetchOptions.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(headers || {}),
      },
      ...fetchOptions,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError({
        message: 'The request timed out. Please check your connection or AI server and try again.',
        status: 504,
        code: 'REQUEST_TIMEOUT',
      });
    }
    throw new ApiError({
      message: 'Network error: Unable to reach the DocuMind AI server.',
      status: 0,
      code: 'NETWORK_ERROR',
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let payload: { error?: string; code?: string; provider?: string; documentIds?: string[] } = {};
    try {
      payload = await res.json();
    } catch {
      payload = { error: `Server returned HTTP ${res.status}` };
    }

    if (res.status === 409 && payload.code === 'CONSENT_REQUIRED') {
      throw new ApiConsentError(
        payload.error || 'Cloud AI consent required for private documents.',
        payload.documentIds || []
      );
    }

    const defaultMsg =
      res.status === 429
        ? 'Rate limit reached. Please wait a moment and try again.'
        : res.status === 503
        ? 'AI service is temporarily unavailable.'
        : `Request failed (${res.status})`;

    throw new ApiError({
      message: payload.error || defaultMsg,
      status: res.status,
      code: payload.code,
      provider: payload.provider,
    });
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError({
      message: 'Received an invalid response from the server.',
      status: res.status,
      code: 'INVALID_RESPONSE',
    });
  }
}

export function uploadFilesWithProgress(
  files: File[],
  options: { folderId?: string | null; cloudConsented?: boolean },
  onProgress: (percent: number) => void
): Promise<{
  results: Array<{
    filename: string;
    status: 'accepted' | 'duplicate' | 'rejected';
    documentId?: string;
    reason?: string;
  }>;
}> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }
    if (options.folderId) formData.append('folderId', options.folderId);
    formData.append('cloudConsented', String(Boolean(options.cloudConsented)));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/documents/upload');
    xhr.withCredentials = true;
    xhr.timeout = 120000;

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        onProgress(Math.round((ev.loaded / ev.total) * 100));
      }
    };

    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          reject(
            new ApiError({
              message: data.error || `Upload failed (${xhr.status})`,
              status: xhr.status,
              code: data.code,
            })
          );
        }
      } catch {
        reject(
          new ApiError({
            message: `Upload failed (${xhr.status})`,
            status: xhr.status,
            code: 'UPLOAD_ERROR',
          })
        );
      }
    };

    xhr.ontimeout = () =>
      reject(
        new ApiError({
          message: 'File upload timed out. Try smaller files or check your connection.',
          status: 504,
          code: 'UPLOAD_TIMEOUT',
        })
      );
    xhr.onerror = () =>
      reject(
        new ApiError({
          message: 'Network error while uploading files.',
          status: 0,
          code: 'NETWORK_ERROR',
        })
      );
    xhr.send(formData);
  });
}

export async function downloadExportFile(params: {
  title: string;
  content: string;
  format: 'pdf' | 'docx' | 'md' | 'txt' | 'csv';
  sourceType: string;
}): Promise<void> {
  const hasDevanagari = /[\u0900-\u097F]/.test(params.content + params.title);
  if (params.format === 'pdf' && hasDevanagari) {
    printUnicodePdfViaIframe(params.title, params.content);
    return;
  }

  let res: Response;
  try {
    res = await fetch('/api/exports', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  } catch {
    throw new ApiError({
      message: 'Network error while generating export file.',
      status: 0,
      code: 'NETWORK_ERROR',
    });
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Export failed' }));
    throw new ApiError({
      message: err.error || `Export failed (${res.status})`,
      status: res.status,
      code: err.code,
    });
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ext = params.format;
  const safeName = params.title.replace(/[^a-zA-Z0-9\u0900-\u097F _-]/g, '').trim() || 'documind-export';
  a.href = url;
  a.download = `${safeName}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Renders full UTF-8 / Devanagari Nepali text inside a hidden print iframe using browser HarfBuzz shaping
 * so Nepali conjuncts export cleanly to PDF without window.open().
 */
export function printUnicodePdfViaIframe(title: string, content: string): void {
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);

  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const doc = iframe.contentWindow?.document;
  if (!doc) {
    iframe.remove();
    throw new Error('Unable to initialize print frame for PDF export.');
  }

  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@400;600;700&family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
      body { font-family: 'Plus Jakarta Sans', 'Noto Sans Devanagari', sans-serif; color: #0f172a; padding: 36px; line-height: 1.65; }
      h1 { font-size: 22px; margin-bottom: 6px; }
      .meta { font-size: 11px; color: #64748b; margin-bottom: 24px; border-bottom: 1px solid #e2e8f0; padding-bottom: 12px; }
      pre { white-space: pre-wrap; font-family: inherit; font-size: 13px; }
    </style></head><body>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">Exported from DocuMind AI · ${new Date().toLocaleString()}</div>
    <pre>${escapeHtml(content)}</pre>
    </body></html>`);
  doc.close();

  setTimeout(() => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    setTimeout(() => iframe.remove(), 2000);
  }, 450);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
