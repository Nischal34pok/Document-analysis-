import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Edit3,
  FileText,
  FolderPlus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import React, { useRef, useState } from 'react';
import { apiRequest, formatBytes, getErrorMessage, uploadFilesWithProgress } from '../../lib/api';
import type { DocumentItem, FolderItem } from '../../types';
import { useToast } from '../ToastProvider';

interface DocumentsViewProps {
  mode: 'upload' | 'documents';
  documents: DocumentItem[];
  folders: FolderItem[];
  cloudConsentDefault: boolean;
  onRefresh: () => Promise<void>;
  onOpenDocument: (docId: string) => void;
}

const ALLOWED_EXT_LIST = [
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
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'tiff',
  'tif',
  'svg',
];

export const DocumentsView: React.FC<DocumentsViewProps> = ({
  mode,
  documents,
  folders,
  cloudConsentDefault,
  onRefresh,
  onOpenDocument,
}) => {
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [dragActive, setDragActive] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [uploadFolder, setUploadFolder] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [consentOnUpload, setConsentOnUpload] = useState<boolean>(cloudConsentDefault);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadFeedback, setUploadFeedback] = useState<
    Array<{ filename: string; status: string; documentId?: string; reason?: string }>
  >([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteDoc, setConfirmDeleteDoc] = useState<DocumentItem | null>(null);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setErrorMsg(null);
    setUploadFeedback([]);

    const validFiles: File[] = [];
    const clientRejected: Array<{ filename: string; status: string; reason: string }> = [];

    for (const file of Array.from(fileList)) {
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      if (!ALLOWED_EXT_LIST.includes(ext)) {
        clientRejected.push({
          filename: file.name,
          status: 'rejected',
          reason: `Unsupported extension ".${ext}".`,
        });
        continue;
      }
      if (file.size > 25 * 1024 * 1024) {
        clientRejected.push({
          filename: file.name,
          status: 'rejected',
          reason: 'Exceeds 25 MB per-file limit.',
        });
        continue;
      }
      validFiles.push(file);
    }

    if (validFiles.length === 0) {
      setUploadFeedback(clientRejected);
      for (const rej of clientRejected) {
        showToast({ type: 'error', title: 'File Rejected', message: `${rej.filename}: ${rej.reason}` });
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    try {
      const res = await uploadFilesWithProgress(
        validFiles,
        { folderId: uploadFolder || null, cloudConsented: consentOnUpload },
        (pct) => setUploadProgress(pct)
      );
      const combined = [...clientRejected, ...res.results];
      setUploadFeedback(combined);
      for (const item of combined) {
        if (item.status === 'rejected') {
          showToast({
            type: 'error',
            title: 'File Rejected',
            message: `${item.filename}: ${item.reason || 'Unsupported file.'}`,
          });
        } else if (item.status === 'duplicate') {
          showToast({
            type: 'warning',
            title: 'Duplicate Skipped',
            message: `${item.filename}: ${item.reason || 'Already exists in workspace.'}`,
          });
        }
      }
      await onRefresh();
    } catch (err) {
      const msg = getErrorMessage(err, 'Upload failed');
      setErrorMsg(msg);
      showToast({ type: 'error', title: 'Upload Failed', message: msg });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    setCreatingFolder(true);
    try {
      await apiRequest('/api/folders', {
        method: 'POST',
        body: JSON.stringify({ name: newFolderName.trim() }),
      });
      setNewFolderName('');
      await onRefresh();
      showToast({ type: 'success', title: 'Folder Created', message: 'New folder added to workspace.' });
    } catch (err) {
      const msg = getErrorMessage(err, 'Failed to create folder');
      setErrorMsg(msg);
      showToast({ type: 'error', title: 'Folder Creation Failed', message: msg });
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleDeleteFolder = async (folder: FolderItem) => {
    try {
      await apiRequest(`/api/folders/${folder.id}`, { method: 'DELETE' });
      if (selectedFolder === folder.id) setSelectedFolder('');
      await onRefresh();
      showToast({ type: 'info', title: 'Folder Deleted', message: `Removed folder "${folder.name}".` });
    } catch (err) {
      const msg = getErrorMessage(err, 'Failed to delete folder');
      setErrorMsg(msg);
      showToast({ type: 'error', title: 'Folder Delete Failed', message: msg });
    }
  };

  const handleRename = async (docId: string) => {
    if (!renameValue.trim()) return;
    try {
      await apiRequest(`/api/documents/${docId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: renameValue.trim() }),
      });
      setRenamingId(null);
      await onRefresh();
      showToast({ type: 'success', title: 'Document Renamed', message: `Renamed to "${renameValue.trim()}".` });
    } catch (err) {
      const msg = getErrorMessage(err, 'Rename failed');
      setErrorMsg(msg);
      showToast({ type: 'error', title: 'Rename Failed', message: msg });
    }
  };

  const handleMoveFolder = async (docId: string, folderId: string) => {
    try {
      await apiRequest(`/api/documents/${docId}`, {
        method: 'PATCH',
        body: JSON.stringify({ folderId: folderId || null }),
      });
      await onRefresh();
    } catch (err) {
      const msg = getErrorMessage(err, 'Move failed');
      setErrorMsg(msg);
      showToast({ type: 'error', title: 'Move Failed', message: msg });
    }
  };

  const handleRetry = async (doc: DocumentItem, grantCloud = false) => {
    try {
      const res = await apiRequest<{ document: DocumentItem }>(`/api/documents/${doc.id}/retry`, {
        method: 'POST',
        body: JSON.stringify({ cloudConsented: grantCloud }),
      });
      await onRefresh();
      if (res.document.status === 'ready') {
        showToast({
          type: 'success',
          title: 'Document Ready',
          message: `"${res.document.title}" processed successfully.`,
        });
      } else {
        const failReason = res.document.ocr_error || res.document.error_message || 'Processing failed again.';
        setErrorMsg(failReason);
        showToast({
          type: 'error',
          title: res.document.status === 'ocr_failed' ? 'OCR Failed' : 'Processing Failed',
          message: failReason,
        });
      }
    } catch (err) {
      const msg = getErrorMessage(err, 'Retry failed');
      setErrorMsg(msg);
      showToast({ type: 'error', title: 'Retry Failed', message: msg });
    }
  };

  const handleDeleteConfirmed = async () => {
    if (!confirmDeleteDoc) return;
    const targetTitle = confirmDeleteDoc.title;
    try {
      await apiRequest(`/api/documents/${confirmDeleteDoc.id}`, { method: 'DELETE' });
      setConfirmDeleteDoc(null);
      setUploadFeedback((prev) => prev.filter((item) => item.documentId !== confirmDeleteDoc.id));
      await onRefresh();
      showToast({ type: 'info', title: 'Document Deleted', message: `Deleted "${targetTitle}".` });
    } catch (err) {
      const msg = getErrorMessage(err, 'Delete failed');
      setErrorMsg(msg);
      showToast({ type: 'error', title: 'Delete Failed', message: msg });
    }
  };

  const handleRemoveRecentUpload = async (docId: string, filename: string) => {
    try {
      await apiRequest(`/api/documents/${docId}`, { method: 'DELETE' });
      setUploadFeedback((prev) => prev.filter((item) => item.documentId !== docId));
      await onRefresh();
      showToast({ type: 'info', title: 'File Removed', message: `Removed "${filename}".` });
    } catch (err) {
      const msg = getErrorMessage(err, 'Remove failed');
      setErrorMsg(msg);
      showToast({ type: 'error', title: 'Remove Failed', message: msg });
    }
  };

  const filteredDocs = documents.filter((d) => {
    if (selectedFolder && d.folder_id !== selectedFolder) return false;
    if (statusFilter !== 'all' && d.status !== statusFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      if (!d.title.toLowerCase().includes(q) && !d.original_filename.toLowerCase().includes(q)) {
        return false;
      }
    }
    return true;
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="border-b border-slate-200 pb-4 dark:border-slate-800">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          {mode === 'upload' ? 'Upload & Process Documents' : 'Document Library'}
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Supports PDF, Office &amp; e-books, spreadsheets, structured data/code, and images (max 25 MB each).
        </p>
      </div>

      {/* Upload Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          void handleFiles(e.dataTransfer.files);
        }}
        className={`rounded-xl border-2 border-dashed p-6 transition-colors ${
          dragActive
            ? 'border-blue-600 bg-blue-50/60 dark:border-blue-500 dark:bg-blue-950/30'
            : 'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900'
        }`}
      >
        <div className="flex flex-col items-center text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            <UploadCloud className="h-5 w-5" />
          </div>
          <p className="mt-3 text-sm font-medium text-slate-900 dark:text-slate-100">
            Drag and drop files here, or click to select multiple files
          </p>
          <p className="mt-1 max-w-xl font-mono text-xs text-slate-500 dark:text-slate-400">
            PDF · DOCX · DOC · ODT · RTF · EPUB · PPTX · XLSX · XLS · ODS · CSV · TSV · HTML · JSON · XML · YAML · TXT · MD · JPG · PNG · WebP · GIF · BMP · TIFF · SVG
          </p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ALLOWED_EXT_LIST.map((e) => `.${e}`).join(',')}
            onChange={(e) => void handleFiles(e.target.files)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="mt-4 rounded-lg bg-slate-950 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-500"
          >
            {uploading ? `Uploading ${uploadProgress}%...` : 'Select Files'}
          </button>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2 dark:border-slate-800">
          <label className="flex cursor-pointer items-start gap-2.5 text-xs text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={consentOnUpload}
              onChange={(e) => setConsentOnUpload(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-slate-900"
            />
            <span>
              <strong className="font-medium">Allow Online Gemini AI processing & Cloud OCR</strong>
              <span className="block text-slate-500 dark:text-slate-400">
                Unchecked files stay strictly local unless you grant consent later.
              </span>
            </span>
          </label>

          <div className="flex items-center justify-end gap-2">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-400">
              Target Folder:
            </label>
            <select
              value={uploadFolder}
              onChange={(e) => setUploadFolder(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
            >
              <option value="">Unfiled Workspace</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {uploading && (
          <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div className="h-full bg-slate-950 transition-all dark:bg-blue-600" style={{ width: `${uploadProgress}%` }} />
          </div>
        )}

        {uploadFeedback.length > 0 && (
          <div className="mt-4 space-y-1.5 border-t border-slate-100 pt-3 dark:border-slate-800">
            {uploadFeedback.map((item, i) => (
              <div key={i} className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate font-medium text-slate-800 dark:text-slate-200">{item.filename}</span>
                <div className="flex shrink-0 items-center gap-3">
                  <span
                    className={
                      item.status === 'accepted'
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : item.status === 'duplicate'
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-red-700 dark:text-red-400'
                    }
                  >
                    {item.status === 'accepted' ? 'Uploaded & indexing' : item.reason}
                  </span>
                  {item.documentId && (
                    <button
                      type="button"
                      onClick={() => void handleRemoveRecentUpload(item.documentId!, item.filename)}
                      className="inline-flex items-center gap-1 rounded border border-red-200 px-2 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40"
                    >
                      <Trash2 className="h-3 w-3" />
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {errorMsg && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
          {errorMsg}
        </div>
      )}

      {/* Folder Bar & Document List */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Folders</h2>
            <div className="mt-3 space-y-1">
              <button
                type="button"
                onClick={() => setSelectedFolder('')}
                className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs font-medium ${
                  selectedFolder === ''
                    ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                    : 'text-slate-600 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/60'
                }`}
              >
                <span>All Documents</span>
                <span className="font-mono tabular-nums">{documents.length}</span>
              </button>
              {folders.map((f) => (
                <div
                  key={f.id}
                  className={`group flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs font-medium ${
                    selectedFolder === f.id
                      ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                      : 'text-slate-600 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedFolder(f.id)}
                    className="min-w-0 flex-1 truncate text-left"
                  >
                    {f.name}
                  </button>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono tabular-nums">{f.document_count}</span>
                    <button
                      type="button"
                      onClick={() => void handleDeleteFolder(f)}
                      title="Delete folder"
                      className="opacity-0 transition-opacity group-hover:opacity-100 text-slate-400 hover:text-red-600"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <form onSubmit={handleCreateFolder} className="mt-4 flex gap-1.5">
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="New folder"
                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <button
                type="submit"
                disabled={creatingFolder}
                className="inline-flex items-center justify-center rounded-lg border border-slate-200 px-2.5 py-1.5 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                title="Create Folder"
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
            </form>
          </div>
        </div>

        <div className="space-y-4 lg:col-span-9">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by document title or filename..."
                className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 focus:border-slate-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
              {(['all', 'ready', 'ocr_failed', 'error'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                    statusFilter === st
                      ? 'bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100'
                      : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  {st === 'all' ? 'All' : st === 'ready' ? 'Ready' : st === 'ocr_failed' ? 'OCR Needed' : 'Errors'}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            {filteredDocs.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-12 text-center">
                <FileText className="h-8 w-8 text-slate-300 dark:text-slate-600" />
                <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
                  No documents match your current filter.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredDocs.map((doc) => (
                  <div key={doc.id} className="p-4 hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        {renamingId === doc.id ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              className="rounded-md border border-slate-300 px-2.5 py-1 text-sm dark:border-slate-600 dark:bg-slate-950"
                            />
                            <button
                              type="button"
                              onClick={() => void handleRename(doc.id)}
                              className="rounded-md bg-slate-950 px-2.5 py-1 text-xs font-medium text-white"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setRenamingId(null)}
                              className="text-xs text-slate-500"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onOpenDocument(doc.id)}
                            className="text-left text-sm font-semibold text-slate-900 hover:underline dark:text-slate-100"
                          >
                            {doc.title}
                          </button>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-slate-500 dark:text-slate-400">
                          <span>{doc.file_ext.toUpperCase()}</span>
                          <span>·</span>
                          <span>{doc.page_count} pages</span>
                          <span>·</span>
                          <span>{formatBytes(doc.file_size)}</span>
                          <span>·</span>
                          <span>{doc.cloud_consented ? 'Cloud AI Permitted' : 'Local Only'}</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {doc.status === 'ready' ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Ready
                          </span>
                        ) : doc.status === 'ocr_failed' || doc.status === 'error' ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-400">
                            <AlertTriangle className="h-3.5 w-3.5" /> {doc.status === 'ocr_failed' ? 'OCR Failed' : 'Failed'}
                          </span>
                        ) : (
                          <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
                            Processing...
                          </span>
                        )}

                        <select
                          value={doc.folder_id || ''}
                          onChange={(e) => void handleMoveFolder(doc.id, e.target.value)}
                          aria-label="Move to folder"
                          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300"
                        >
                          <option value="">Unfiled</option>
                          {folders.map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.name}
                            </option>
                          ))}
                        </select>

                        {doc.status === 'ready' && (
                          <button
                            type="button"
                            onClick={() => onOpenDocument(doc.id)}
                            className="rounded-md bg-slate-950 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 dark:bg-blue-600 dark:hover:bg-blue-500"
                          >
                            Open in Studio
                          </button>
                        )}

                        {(doc.status === 'ocr_failed' || doc.status === 'error') && (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleRetry(doc, false)}
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200"
                            >
                              <RefreshCw className="h-3.5 w-3.5" /> Retry
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleRetry(doc, true)}
                              className="inline-flex items-center gap-1 rounded-md bg-slate-950 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                            >
                              <ShieldCheck className="h-3.5 w-3.5" /> Retry w/ Cloud OCR
                            </button>
                          </>
                        )}

                        <button
                          type="button"
                          onClick={() => {
                            setRenamingId(doc.id);
                            setRenameValue(doc.title);
                          }}
                          title="Rename"
                          className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </button>
                        <a
                          href={`/api/documents/${doc.id}/download`}
                          title="Download original"
                          className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </a>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteDoc(doc)}
                          title="Remove uploaded file"
                          className="inline-flex items-center gap-1 rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span>Remove</span>
                        </button>
                      </div>
                    </div>

                    {(doc.ocr_error || doc.error_message) && (
                      <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
                        {doc.ocr_error || doc.error_message}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {confirmDeleteDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">Delete Document</h3>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              Permanently delete <strong>{confirmDeleteDoc.title}</strong>, its extracted text, chunks, and embeddings?
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteDoc(null)}
                className="rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-700 dark:border-slate-700 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteConfirmed()}
                className="rounded-lg bg-red-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-red-700"
              >
                Delete Permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
