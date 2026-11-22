import {
  AlertTriangle,
  Brush,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  MousePointerClick,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Table2,
  ThumbsUp,
  Trash2,
  UploadCloud,
  User,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiConsentError,
  apiRequest,
  downloadExportFile,
  formatBytes,
  getErrorMessage,
  isAIUnavailableError,
  isQuotaExceededError,
  uploadFilesWithProgress,
} from '../../lib/api';
import type {
  AIMode,
  ChatMessage,
  Conversation,
  DocumentDetail,
  DocumentItem,
} from '../../types';
import { PWAInstallButton } from '../PWAInstallButton';
import { useToast } from '../ToastProvider';
import { SpeakButton, VoiceInputButton } from '../VoiceControls';

const STUDIO_ACCEPT_EXTS =
  '.pdf,.docx,.doc,.odt,.rtf,.epub,.pptx,.xlsx,.xls,.ods,.csv,.tsv,.html,.htm,.txt,.md,.json,.xml,.yaml,.yml,.log,.ini,.toml,.sql,.jpg,.jpeg,.png,.webp,.gif,.bmp,.tiff,.tif,.svg';
const IMAGE_PREVIEW_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg']);

interface StudioViewProps {
  documents: DocumentItem[];
  activeDocumentId: string | null;
  aiMode: AIMode;
  cloudConsentDefault: boolean;
  onSelectDocument: (docId: string | null) => void;
  onChangeAIMode: (mode: AIMode) => Promise<void>;
  onOpenDocumentsLibrary: () => void;
  onOpenSettings: () => void;
  onRefreshWorkspace: () => Promise<void>;
  onRequireConsent: (docIds: string[], message: string, retryCallback: () => void) => void;
}

function groupConversationsByDate(conversations: Conversation[]) {
  const todayStr = new Date().toDateString();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toDateString();

  const today: Conversation[] = [];
  const yest: Conversation[] = [];
  const earlier: Conversation[] = [];

  for (const c of conversations) {
    const dStr = new Date(c.updated_at || c.created_at).toDateString();
    if (dStr === todayStr) today.push(c);
    else if (dStr === yesterdayStr) yest.push(c);
    else earlier.push(c);
  }
  return { today, yest, earlier };
}

export const StudioView: React.FC<StudioViewProps> = ({
  documents,
  activeDocumentId,
  aiMode,
  cloudConsentDefault,
  onSelectDocument,
  onChangeAIMode,
  onOpenDocumentsLibrary,
  onOpenSettings,
  onRefreshWorkspace,
  onRequireConsent,
}) => {
  const { showToast } = useToast();
  const readyDocs = documents.filter((d) => d.status === 'ready');
  const activeDocMeta = documents.find((d) => d.id === activeDocumentId) || null;

  const chatImageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docViewerRef = useRef<HTMLDivElement>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const hasAutoSelectedRef = useRef(false);

  // Conversation sidebar state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convSearch, setConvSearch] = useState('');
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  // Document viewer state
  const [docDetail, setDocDetail] = useState<DocumentDetail | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [docSubTab, setDocSubTab] = useState<'reader' | 'tables' | 'insights'>('reader');
  const [readerMode, setReaderMode] = useState<'text' | 'original'>('text');
  const [currentPage, setCurrentPage] = useState(1);
  const [zoomPct, setZoomPct] = useState(100);
  const [showDocSearch, setShowDocSearch] = useState(false);
  const [docSearchText, setDocSearchText] = useState('');
  const [selectMode, setSelectMode] = useState(true);
  const [highlightExcerpt, setHighlightExcerpt] = useState<string | null>(null);
  const [analyzingDoc, setAnalyzingDoc] = useState(false);
  const [retryingDoc, setRetryingDoc] = useState(false);
  const [removingDoc, setRemovingDoc] = useState(false);
  const [confirmRemoveDoc, setConfirmRemoveDoc] = useState(false);

  // Floating text-selection popover
  const [selectionPopup, setSelectionPopup] = useState<{
    text: string;
    top: number;
    left: number;
  } | null>(null);

  // Chat composer state
  const [input, setInput] = useState('');
  const [chatImage, setChatImage] = useState<{
    filename: string;
    mimeType: string;
    dataUrl: string;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const notifyApiError = useCallback(
    (err: unknown, title: string) => {
      const msg = getErrorMessage(err);
      if (isQuotaExceededError(err)) {
        showToast({
          type: 'warning',
          title: 'Gemini Quota Limit Reached',
          message: msg,
          dedupeKey: 'studio-gemini-quota',
          action: {
            label: 'AI Settings',
            onClick: onOpenSettings,
          },
        });
      } else if (isAIUnavailableError(err)) {
        showToast({
          type: 'error',
          title: 'AI Provider Unavailable',
          message: msg,
          dedupeKey: 'studio-ai-unavailable',
          action: {
            label: 'AI Settings',
            onClick: onOpenSettings,
          },
        });
      } else {
        showToast({
          type: 'error',
          title,
          message: msg,
        });
      }
      setErrorMsg(msg);
    },
    [onOpenSettings, showToast]
  );

  // Auto-select first ready document ONCE on initial load (without overriding intentional "General AI" selection)
  useEffect(() => {
    if (!hasAutoSelectedRef.current && !activeDocumentId && readyDocs.length > 0) {
      hasAutoSelectedRef.current = true;
      onSelectDocument(readyDocs[0].id);
    }
  }, [activeDocumentId, readyDocs, onSelectDocument]);

  const loadConversations = useCallback(async () => {
    try {
      const res = await apiRequest<{ conversations: Conversation[] }>('/api/chat/conversations');
      setConversations(res.conversations);
      setActiveConvId((prev) => {
        if (prev && res.conversations.some((c) => c.id === prev)) return prev;
        return res.conversations[0]?.id || null;
      });
    } catch (err) {
      showToast({
        type: 'error',
        title: 'Failed to Load Conversations',
        message: getErrorMessage(err),
        dedupeKey: 'load-conversations-err',
      });
    }
  }, [showToast]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (!activeConvId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoadingMessages(true);
    void apiRequest<{ messages: ChatMessage[] }>(`/api/chat/conversations/${activeConvId}/messages`)
      .then((res) => {
        if (!cancelled) setMessages(res.messages);
      })
      .catch((err) => {
        if (!cancelled) {
          setMessages([]);
          showToast({
            type: 'error',
            title: 'Failed to Load Messages',
            message: getErrorMessage(err),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeConvId, showToast]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const fetchDocDetail = useCallback(
    async (docId: string) => {
      setLoadingDoc(true);
      setHighlightExcerpt(null);
      setSelectionPopup(null);
      try {
        const res = await apiRequest<{ document: DocumentDetail }>(`/api/documents/${docId}`);
        setDocDetail(res.document);
        setCurrentPage(1);
        setReaderMode(IMAGE_PREVIEW_EXTS.has(res.document.file_ext.toLowerCase()) ? 'original' : 'text');
      } catch (err) {
        setDocDetail(null);
        showToast({
          type: 'error',
          title: 'Failed to Load Document',
          message: getErrorMessage(err),
        });
      } finally {
        setLoadingDoc(false);
      }
    },
    [showToast]
  );

  // Load document details when activeDocumentId changes or when its status transitions to ready
  const activeStatus = activeDocMeta?.status;
  useEffect(() => {
    if (!activeDocumentId) {
      setDocDetail(null);
      return;
    }
    void fetchDocDetail(activeDocumentId);
  }, [activeDocumentId, activeStatus, fetchDocDetail]);

  const handleSelectConversation = (conv: Conversation) => {
    setActiveConvId(conv.id);
    if (conv.documentIds?.length) {
      const targetDoc = documents.find((d) => d.id === conv.documentIds[0]);
      if (targetDoc) {
        onSelectDocument(targetDoc.id);
      }
    }
  };

  const handleNewConversation = async () => {
    try {
      const res = await apiRequest<{ conversation: Conversation }>('/api/chat/conversations', {
        method: 'POST',
        body: JSON.stringify({
          title: 'New Conversation',
          chatType: activeDocumentId ? 'document' : 'general',
          documentIds: activeDocumentId ? [activeDocumentId] : [],
          language: 'en',
        }),
      });
      setConversations((prev) => [res.conversation, ...prev]);
      setActiveConvId(res.conversation.id);
      setMessages([]);
      setErrorMsg(null);
    } catch (err) {
      notifyApiError(err, 'Could Not Create Conversation');
    }
  };

  const handleDeleteConversation = async (convId: string) => {
    try {
      await apiRequest(`/api/chat/conversations/${convId}`, { method: 'DELETE' });
      setConversations((prev) => prev.filter((c) => c.id !== convId));
      if (activeConvId === convId) {
        setActiveConvId(null);
        setMessages([]);
      }
    } catch (err) {
      notifyApiError(err, 'Could Not Delete Conversation');
    }
  };

  const handleSelectChatImage = (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (chatImageInputRef.current) chatImageInputRef.current.value = '';
    if (!file) return;
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    if (!allowed.has(file.type.toLowerCase())) {
      showToast({
        type: 'error',
        title: 'Unsupported Image',
        message: 'Chat image attachments support PNG, JPEG, WebP, or GIF.',
      });
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      showToast({
        type: 'error',
        title: 'Image Too Large',
        message: 'Chat image attachments must be 4 MB or smaller.',
      });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setChatImage({
          filename: file.name,
          mimeType: file.type || 'image/png',
          dataUrl: reader.result,
        });
      }
    };
    reader.readAsDataURL(file);
  };

  const sendPrompt = async (promptText: string, regenerate = false) => {
    const trimmed = promptText.trim();
    const attached = chatImage;
    if (!regenerate && !trimmed && !attached) return;
    if (sending) return;

    const effectiveChatType = activeDocumentId ? 'document' : 'general';
    setSending(true);
    setErrorMsg(null);
    try {
      let convId = activeConvId;
      if (!convId) {
        const res = await apiRequest<{ conversation: Conversation }>('/api/chat/conversations', {
          method: 'POST',
          body: JSON.stringify({
            title: (trimmed || attached?.filename || 'Image Analysis').slice(0, 48),
            chatType: effectiveChatType,
            documentIds: activeDocumentId ? [activeDocumentId] : [],
            language: 'en',
          }),
        });
        convId = res.conversation.id;
        setConversations((prev) => [res.conversation, ...prev]);
        setActiveConvId(convId);
      }

      if (!regenerate) {
        setInput('');
        setChatImage(null);
      }

      const res = await apiRequest<{ messages: ChatMessage[] }>(`/api/chat/conversations/${convId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: trimmed,
          regenerate,
          chatType: effectiveChatType,
          documentIds: activeDocumentId ? [activeDocumentId] : [],
          language: 'en',
          ...(attached && !regenerate
            ? {
                imageAttachment: {
                  mimeType: attached.mimeType,
                  dataUrlOrBase64: attached.dataUrl,
                  filename: attached.filename,
                },
              }
            : {}),
        }),
      });
      setMessages(res.messages);
      await loadConversations();
    } catch (err) {
      if (err instanceof ApiConsentError) {
        onRequireConsent(err.documentIds, err.message, () => {
          void sendPrompt(trimmed, regenerate);
        });
      } else {
        notifyApiError(err, 'AI Chat Error');
      }
    } finally {
      setSending(false);
    }
  };

  const handleQuickUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setErrorMsg(null);
    try {
      const res = await uploadFilesWithProgress(
        Array.from(fileList),
        { cloudConsented: cloudConsentDefault },
        () => {}
      );

      for (const item of res.results) {
        if (item.status === 'rejected') {
          showToast({
            type: 'error',
            title: 'File Rejected',
            message: `${item.filename}: ${item.reason || 'Unsupported file.'}`,
          });
        } else if (item.status === 'duplicate') {
          showToast({
            type: 'warning',
            title: 'Duplicate Document',
            message: `${item.filename}: ${item.reason || 'Already uploaded.'}`,
          });
        } else {
          showToast({
            type: 'info',
            title: 'Processing Document',
            message: `Uploaded "${item.filename}". Extracting text and indexing...`,
          });
        }
      }

      const accepted = res.results.find((r) => r.status === 'accepted' && r.documentId);
      const duplicate = res.results.find((r) => r.status === 'duplicate' && r.documentId);
      await onRefreshWorkspace();
      if (accepted?.documentId) {
        hasAutoSelectedRef.current = true;
        onSelectDocument(accepted.documentId);
      } else if (duplicate?.documentId) {
        hasAutoSelectedRef.current = true;
        onSelectDocument(duplicate.documentId);
      }
    } catch (err) {
      notifyApiError(err, 'Upload Failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRetryDoc = async (grantCloud: boolean) => {
    if (!activeDocumentId) return;
    setRetryingDoc(true);
    setErrorMsg(null);
    try {
      const res = await apiRequest<{ document: DocumentItem }>(`/api/documents/${activeDocumentId}/retry`, {
        method: 'POST',
        body: JSON.stringify({ cloudConsented: grantCloud }),
      });
      await onRefreshWorkspace();
      if (res.document.status === 'ready') {
        showToast({
          type: 'success',
          title: 'Document Ready',
          message: `"${res.document.title}" processed successfully.`,
        });
      } else {
        showToast({
          type: 'error',
          title: res.document.status === 'ocr_failed' ? 'OCR Failed' : 'Processing Failed',
          message: res.document.ocr_error || res.document.error_message || 'Document could not be processed.',
        });
      }
    } catch (err) {
      notifyApiError(err, 'Retry Failed');
    } finally {
      setRetryingDoc(false);
    }
  };

  const handleRemoveActiveDoc = async () => {
    if (!activeDocMeta) return;
    const targetId = activeDocMeta.id;
    const targetTitle = activeDocMeta.original_filename || activeDocMeta.title;
    setRemovingDoc(true);
    setErrorMsg(null);
    try {
      await apiRequest(`/api/documents/${targetId}`, { method: 'DELETE' });
      setConfirmRemoveDoc(false);
      setDocDetail(null);
      setHighlightExcerpt(null);
      const nextReady = documents.find((d) => d.id !== targetId && d.status === 'ready');
      onSelectDocument(nextReady ? nextReady.id : null);
      await onRefreshWorkspace();
      showToast({
        type: 'info',
        title: 'File Removed',
        message: `Removed "${targetTitle}" from your workspace.`,
      });
    } catch (err) {
      notifyApiError(err, 'Remove File Failed');
    } finally {
      setRemovingDoc(false);
    }
  };

  const handleDocumentTextSelection = () => {
    if (!selectMode) {
      setSelectionPopup(null);
      return;
    }
    const sel = window.getSelection();
    const selectedText = sel?.toString().trim() || '';
    if (selectedText.length < 6 || !docViewerRef.current) {
      setSelectionPopup(null);
      return;
    }
    const range = sel?.getRangeAt(0);
    if (!range) return;
    const rect = range.getBoundingClientRect();
    const containerRect = docViewerRef.current.getBoundingClientRect();
    setSelectionPopup({
      text: selectedText.slice(0, 1200),
      top: Math.max(8, rect.top - containerRect.top - 44),
      left: Math.min(Math.max(12, rect.left - containerRect.left), Math.max(12, containerRect.width - 250)),
    });
  };

  const runSelectionAction = (action: 'Explain' | 'Summarise' | 'Rewrite') => {
    if (!selectionPopup) return;
    const snippet = selectionPopup.text;
    setSelectionPopup(null);
    window.getSelection()?.removeAllRanges();
    const prompt = `${action} this passage from page ${currentPage}:\n"${snippet}"`;
    void sendPrompt(prompt);
  };

  const runFullInsights = async () => {
    if (!docDetail) return;
    setAnalyzingDoc(true);
    setErrorMsg(null);
    try {
      const res = await apiRequest<{ analysis: DocumentDetail['analysis'] }>(
        `/api/documents/${docDetail.id}/analyze`,
        {
          method: 'POST',
          body: JSON.stringify({ action: 'full_analysis', language: 'en' }),
        }
      );
      setDocDetail((prev) => (prev ? { ...prev, analysis: res.analysis } : prev));
      showToast({
        type: 'success',
        title: 'Summary Ready',
        message: `Generated summary and outline for "${docDetail.title}".`,
      });
    } catch (err) {
      if (err instanceof ApiConsentError) {
        onRequireConsent(err.documentIds, err.message, () => void runFullInsights());
      } else {
        notifyApiError(err, 'Document Analysis Failed');
      }
    } finally {
      setAnalyzingDoc(false);
    }
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      showToast({
        type: 'warning',
        title: 'Copy Unavailable',
        message: 'Clipboard access was blocked by the browser.',
      });
    }
  };

  const handleExportActiveDoc = async (fmt: 'pdf' | 'docx' | 'md') => {
    if (!docDetail) return;
    try {
      const summaryText = docDetail.analysis?.summary
        ? `## Executive Summary\n${docDetail.analysis.summary}\n\n`
        : '';
      await downloadExportFile({
        title: docDetail.title,
        content: `${summaryText}## Extracted Content\n${docDetail.extracted_text}`,
        format: fmt,
        sourceType: 'studio',
      });
      showToast({
        type: 'success',
        title: 'Export Started',
        message: `Downloaded "${docDetail.title}.${fmt}".`,
      });
    } catch (err) {
      notifyApiError(err, 'Export Failed');
    }
  };

  const filteredConversations = conversations.filter((c) =>
    c.title.toLowerCase().includes(convSearch.toLowerCase())
  );
  const grouped = groupConversationsByDate(filteredConversations);

  const pages = docDetail?.pages?.length
    ? docDetail.pages
    : docDetail?.extracted_text
    ? [{ pageNumber: 1, text: docDetail.extracted_text }]
    : [];
  const activePage = pages.find((p) => p.pageNumber === currentPage) || pages[0];

  const matchingPages = docSearchText.trim()
    ? pages.filter((p) => p.text.toLowerCase().includes(docSearchText.toLowerCase()))
    : [];

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      {/* Column 2: Conversation History Sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white md:flex dark:border-slate-800 dark:bg-slate-900">
        <div className="flex h-14 items-center border-b border-slate-200 px-4 dark:border-slate-800">
          <span className="font-display text-sm font-bold tracking-wide text-slate-900 dark:text-slate-100">
            DOCUMIND AI
          </span>
        </div>

        <div className="space-y-3 p-3.5">
          <div className="relative">
            <input
              type="text"
              value={convSearch}
              onChange={(e) => setConvSearch(e.target.value)}
              placeholder="Search for conversation"
              className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-3 pr-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
            <Search className="pointer-events-none absolute right-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
          </div>

          <button
            type="button"
            onClick={() => void handleNewConversation()}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-slate-950 py-2.5 text-xs font-medium text-white hover:bg-slate-800 transition-colors dark:bg-blue-600 dark:hover:bg-blue-500"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New Conversation</span>
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
          {[
            { label: 'TODAY', items: grouped.today },
            { label: 'YESTERDAY', items: grouped.yest },
            { label: 'EARLIER', items: grouped.earlier },
          ].map(
            (group) =>
              group.items.length > 0 && (
                <div key={group.label}>
                  <div className="px-2 pb-1.5 text-[10px] font-semibold tracking-wider text-slate-400">
                    {group.label}
                  </div>
                  <div className="space-y-0.5">
                    {group.items.map((c) => (
                      <div
                        key={c.id}
                        className={`group flex items-center justify-between rounded-lg px-2.5 py-2 text-xs transition-colors ${
                          activeConvId === c.id
                            ? 'bg-slate-100 font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                            : 'text-slate-600 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/50'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => handleSelectConversation(c)}
                          className="min-w-0 flex-1 truncate text-left"
                        >
                          {c.title}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteConversation(c.id)}
                          className="ml-1 opacity-0 transition-opacity group-hover:opacity-100 text-slate-400 hover:text-red-600"
                          title="Delete conversation"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )
          )}

          {filteredConversations.length === 0 && (
            <p className="px-2 py-4 text-xs text-slate-400">
              Start a conversation about your uploaded document.
            </p>
          )}
        </div>
      </aside>

      {/* Main Studio Area (Top Strip + Split Document Viewer & AI Chat) */}
      <div className="flex min-w-0 flex-1 flex-col bg-white dark:bg-slate-950">
        {/* Top Studio Sub-Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-400 text-slate-950 font-bold text-xs">
              DM
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">DocuMind AI</div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Document Assistant</div>
            </div>
          </div>

          {/* Model / AI Mode Selector Tabs */}
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
            {(
              [
                ['automatic', 'Automatic'],
                ['online', 'Gemini 4'],
                ['offline', 'Ollama Local'],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => void onChangeAIMode(val)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                  aiMode === val
                    ? 'bg-white text-slate-950 shadow-xs dark:bg-slate-900 dark:text-slate-100'
                    : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden md:block">
              <PWAInstallButton />
            </div>
            <button
              type="button"
              onClick={onOpenDocumentsLibrary}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              <span>Documents ({readyDocs.length})</span>
            </button>
          </div>
        </div>

        {/* Mobile Conversation Switcher Strip */}
        <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 md:hidden dark:border-slate-800 dark:bg-slate-900">
          <select
            value={activeConvId || ''}
            onChange={(e) => {
              const found = conversations.find((c) => c.id === e.target.value);
              if (found) handleSelectConversation(found);
              else setActiveConvId(null);
            }}
            className="min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          >
            <option value="">Select conversation...</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleNewConversation()}
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-slate-950 px-2.5 py-1 text-xs font-medium text-white dark:bg-blue-600"
          >
            <Plus className="h-3 w-3" />
            <span>New</span>
          </button>
        </div>

        {/* Active Document Banner Strip */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/80 px-4 py-2 text-xs dark:border-slate-800 dark:bg-slate-900/60">
          <div className="flex items-center gap-2">
            <span className="text-slate-500 dark:text-slate-400">Ask me about</span>
            <select
              value={activeDocumentId || ''}
              onChange={(e) => {
                hasAutoSelectedRef.current = true;
                onSelectDocument(e.target.value || null);
              }}
              className="max-w-[260px] truncate rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            >
              <option value="">General AI (No document filter)</option>
              {documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.original_filename}
                  {d.status === 'processing' || d.status === 'pending'
                    ? ' (Processing...)'
                    : d.status === 'ocr_failed' || d.status === 'error'
                    ? ' (Failed)'
                    : ''}
                </option>
              ))}
            </select>
            {docDetail && docDetail.status === 'ready' && (
              <div className="hidden items-center gap-1 sm:flex">
                <button
                  type="button"
                  onClick={() => setDocSubTab(docSubTab === 'reader' ? 'insights' : 'reader')}
                  className="font-medium text-slate-800 underline hover:text-blue-700 dark:text-slate-200"
                >
                  {docSubTab === 'insights' ? 'View Document' : 'View Summary & Outline'}
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={STUDIO_ACCEPT_EXTS}
              onChange={(e) => void handleQuickUpload(e.target.files)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
            >
              <UploadCloud className="h-3.5 w-3.5" />
              <span>{uploading ? 'Uploading...' : 'Upload File'}</span>
            </button>
            {activeDocMeta && (
              <button
                type="button"
                onClick={() => setConfirmRemoveDoc(true)}
                disabled={removingDoc}
                title={`Remove ${activeDocMeta.original_filename}`}
                className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900/60 dark:bg-slate-950 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>{removingDoc ? 'Removing...' : 'Remove'}</span>
              </button>
            )}
            {docDetail && docDetail.status === 'ready' && (
              <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-950">
                <Download className="h-3 w-3 text-slate-400" />
                {(['pdf', 'docx', 'md'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    onClick={() => void handleExportActiveDoc(fmt)}
                    className="px-1 font-mono text-[10px] uppercase text-slate-600 hover:text-slate-950 dark:text-slate-300"
                  >
                    {fmt}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Split Center Panes: Document Viewer (Left) + AI Chat (Right) */}
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-12">
          {/* Center-Left: Document Viewer */}
          <div className="relative flex min-h-[380px] flex-col border-b border-slate-200 bg-slate-50/40 lg:col-span-6 lg:border-b-0 lg:border-r dark:border-slate-800 dark:bg-slate-950">
            {docDetail && docDetail.status === 'ready' && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2 text-xs dark:border-slate-800 dark:bg-slate-900">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setDocSubTab('reader')}
                    className={`rounded-md px-2.5 py-1 font-medium ${
                      docSubTab === 'reader'
                        ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                        : 'text-slate-500'
                    }`}
                  >
                    Reader
                  </button>
                  <button
                    type="button"
                    onClick={() => setDocSubTab('tables')}
                    className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium ${
                      docSubTab === 'tables'
                        ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                        : 'text-slate-500'
                    }`}
                  >
                    <Table2 className="h-3 w-3" /> Tables ({docDetail.tables.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setDocSubTab('insights')}
                    className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium ${
                      docSubTab === 'insights'
                        ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                        : 'text-slate-500'
                    }`}
                  >
                    <Sparkles className="h-3 w-3" /> Summary
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {docSubTab === 'reader' &&
                    (IMAGE_PREVIEW_EXTS.has(docDetail.file_ext.toLowerCase()) ||
                      docDetail.file_ext.toLowerCase() === 'pdf') && (
                      <div className="flex items-center gap-0.5 rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-950">
                        <button
                          type="button"
                          onClick={() => setReaderMode('text')}
                          className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                            readerMode === 'text'
                              ? 'bg-white text-slate-900 shadow-2xs dark:bg-slate-800 dark:text-slate-100'
                              : 'text-slate-500'
                          }`}
                        >
                          Text
                        </button>
                        <button
                          type="button"
                          onClick={() => setReaderMode('original')}
                          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${
                            readerMode === 'original'
                              ? 'bg-white text-slate-900 shadow-2xs dark:bg-slate-800 dark:text-slate-100'
                              : 'text-slate-500'
                          }`}
                        >
                          {IMAGE_PREVIEW_EXTS.has(docDetail.file_ext.toLowerCase()) ? (
                            <>
                              <ImageIcon className="h-3 w-3" /> Image
                            </>
                          ) : (
                            <>
                              <Eye className="h-3 w-3" /> PDF View
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  <span className="font-mono text-[11px] text-slate-400">
                    {formatBytes(docDetail.file_size)}
                  </span>
                </div>
              </div>
            )}

            <div
              ref={docViewerRef}
              onMouseUp={handleDocumentTextSelection}
              className="relative flex-1 overflow-y-auto p-5"
            >
              {/* Floating Explain / Summarise / Rewrite Popover on Text Selection */}
              {selectionPopup && (
                <div
                  style={{ top: selectionPopup.top, left: selectionPopup.left }}
                  className="absolute z-30 flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
                >
                  {(['Explain', 'Summarise', 'Rewrite'] as const).map((act) => (
                    <button
                      key={act}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        runSelectionAction(act);
                      }}
                      className="rounded-md px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      {act}
                    </button>
                  ))}
                </div>
              )}

              {loadingDoc ? (
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
                </div>
              ) : docDetail && (docDetail.status === 'pending' || docDetail.status === 'processing') ? (
                <div className="flex h-full flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900">
                  <Loader2 className="h-7 w-7 animate-spin text-amber-500" />
                  <h3 className="mt-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Processing "{docDetail.title}"
                  </h3>
                  <p className="mt-1 max-w-sm text-xs text-slate-500 dark:text-slate-400">
                    Extracting pages, tables, and search index. The document reader will appear automatically once ready.
                  </p>
                </div>
              ) : docDetail && (docDetail.status === 'ocr_failed' || docDetail.status === 'error') ? (
                <div className="flex h-full flex-col items-center justify-center rounded-xl border border-red-200 bg-white p-8 text-center dark:border-red-900/60 dark:bg-slate-900">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400">
                    <AlertTriangle className="h-5 w-5" />
                  </div>
                  <h3 className="mt-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {docDetail.status === 'ocr_failed' ? 'Document OCR Failed' : 'Document Processing Failed'}
                  </h3>
                  <p className="mt-1.5 max-w-md text-xs leading-relaxed text-red-700 dark:text-red-300">
                    {docDetail.ocr_error || docDetail.error_message || 'Unable to extract text from this document.'}
                  </p>
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      disabled={retryingDoc}
                      onClick={() => void handleRetryDoc(false)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${retryingDoc ? 'animate-spin' : ''}`} />
                      Retry
                    </button>
                    <button
                      type="button"
                      disabled={retryingDoc}
                      onClick={() => void handleRetryDoc(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-950 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      Retry with Cloud OCR
                    </button>
                    <button
                      type="button"
                      disabled={removingDoc}
                      onClick={() => setConfirmRemoveDoc(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3.5 py-2 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:bg-slate-950 dark:text-red-400 dark:hover:bg-red-950/40"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove File
                    </button>
                  </div>
                </div>
              ) : !docDetail ? (
                <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center dark:border-slate-700 dark:bg-slate-900">
                  <FileText className="h-10 w-10 text-slate-300 dark:text-slate-600" />
                  <h3 className="mt-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Upload a document to start reading & chatting
                  </h3>
                  <p className="mt-1 max-w-sm text-xs text-slate-500 dark:text-slate-400">
                    Supports PDF, DOCX, ODT, RTF, EPUB, XLSX, CSV, PPTX, HTML, JSON, TXT, Markdown, JPG, PNG, WebP, GIF, and SVG.
                  </p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-4 inline-flex items-center gap-2 rounded-lg bg-slate-950 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 dark:bg-blue-600"
                  >
                    <UploadCloud className="h-4 w-4" />
                    Select Document or Image
                  </button>
                </div>
              ) : docSubTab === 'reader' ? (
                <div className="mx-auto max-w-2xl space-y-3">
                  {showDocSearch && (
                    <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
                      <input
                        type="text"
                        value={docSearchText}
                        onChange={(e) => setDocSearchText(e.target.value)}
                        placeholder="Search inside this document..."
                        className="flex-1 bg-transparent text-xs focus:outline-none"
                      />
                      {matchingPages.length > 0 && (
                        <div className="flex gap-1 font-mono text-[11px]">
                          {matchingPages.slice(0, 5).map((mp) => (
                            <button
                              key={mp.pageNumber}
                              type="button"
                              onClick={() => {
                                setReaderMode('text');
                                setCurrentPage(mp.pageNumber);
                              }}
                              className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200"
                            >
                              p.{mp.pageNumber}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {highlightExcerpt && (
                    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                      <div className="flex items-center justify-between font-semibold">
                        <span>Cited Passage (Page {currentPage})</span>
                        <button
                          type="button"
                          onClick={() => setHighlightExcerpt(null)}
                          className="underline"
                        >
                          Clear
                        </button>
                      </div>
                      <p className="mt-1 leading-relaxed">{highlightExcerpt}</p>
                    </div>
                  )}

                  {readerMode === 'original' &&
                  IMAGE_PREVIEW_EXTS.has(docDetail.file_ext.toLowerCase()) ? (
                    <div className="space-y-4">
                      <div className="overflow-auto rounded-xl border border-slate-200 bg-white p-4 text-center shadow-2xs dark:border-slate-800 dark:bg-slate-900">
                        <img
                          src={`/api/documents/${docDetail.id}/raw`}
                          alt={docDetail.title}
                          style={{ width: `${zoomPct}%`, maxWidth: '100%' }}
                          className="mx-auto rounded-lg object-contain"
                        />
                      </div>
                      <div className="rounded-xl border border-slate-200 bg-white p-5 text-xs leading-relaxed text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
                        <div className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                          Extracted OCR &amp; Visual Text (Highlight to Explain / Summarise)
                        </div>
                        <div className="whitespace-pre-wrap">
                          {activePage?.text || 'No readable text extracted.'}
                        </div>
                      </div>
                    </div>
                  ) : readerMode === 'original' && docDetail.file_ext.toLowerCase() === 'pdf' ? (
                    <div className="space-y-2">
                      <iframe
                        src={`/api/documents/${docDetail.id}/raw#page=${currentPage}`}
                        title={docDetail.title}
                        className="h-[540px] w-full rounded-xl border border-slate-200 bg-white dark:border-slate-800"
                      />
                      <div className="flex items-center justify-between text-[11px] text-slate-500">
                        <span>Viewing original PDF (Page {currentPage})</span>
                        <a
                          href={`/api/documents/${docDetail.id}/download`}
                          className="font-medium text-blue-700 hover:underline dark:text-blue-400"
                        >
                          Download PDF
                        </a>
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{ fontSize: `${Math.round(14 * (zoomPct / 100))}px` }}
                      className="min-h-[420px] rounded-xl border border-slate-200 bg-white p-7 leading-relaxed text-slate-800 shadow-2xs dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
                    >
                      <div className="mb-4 border-b border-slate-100 pb-2 font-mono text-[11px] text-slate-400 dark:border-slate-800">
                        {docDetail.title} · Page {currentPage} of {pages.length}
                      </div>
                      <div className="whitespace-pre-wrap">{activePage?.text || 'No text extracted on this page.'}</div>
                    </div>
                  )}
                </div>
              ) : docSubTab === 'tables' ? (
                <div className="space-y-4">
                  {docDetail.tables.length === 0 ? (
                    <p className="py-12 text-center text-xs text-slate-500">No tables extracted from this file.</p>
                  ) : (
                    docDetail.tables.map((tbl, idx) => (
                      <div key={idx} className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                        <div className="border-b border-slate-200 px-3 py-2 text-xs font-semibold dark:border-slate-800">
                          {tbl.title} (Page {tbl.pageNumber})
                        </div>
                        <table className="w-full text-left text-xs">
                          <thead className="bg-slate-50 dark:bg-slate-950">
                            <tr>
                              {tbl.headers.map((h, i) => (
                                <th key={i} className="border-b border-slate-200 px-3 py-2 font-medium dark:border-slate-800">
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {tbl.rows.slice(0, 40).map((row, rIdx) => (
                              <tr key={rIdx}>
                                {row.map((cell, cIdx) => (
                                  <td key={cIdx} className="px-3 py-1.5">{cell}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="mx-auto max-w-2xl space-y-4 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
                  {!docDetail.analysis?.summary ? (
                    <div className="py-8 text-center">
                      <p className="text-xs text-slate-500">Generate summary, key points, entities, and outline.</p>
                      <button
                        type="button"
                        onClick={() => void runFullInsights()}
                        disabled={analyzingDoc}
                        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-slate-950 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600"
                      >
                        {analyzingDoc ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                        {analyzingDoc ? 'Analyzing...' : 'Generate Summary & Insights'}
                      </button>
                    </div>
                  ) : (
                    <>
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Summary</h4>
                        <p className="mt-1.5 text-sm leading-relaxed text-slate-800 dark:text-slate-200">
                          {docDetail.analysis.summary}
                        </p>
                      </div>
                      {docDetail.analysis.keyPoints?.length ? (
                        <div>
                          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Key Points</h4>
                          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-slate-700 dark:text-slate-300">
                            {docDetail.analysis.keyPoints.map((k, i) => (
                              <li key={i}>{k}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {docDetail.analysis.outline?.length ? (
                        <div>
                          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Outline</h4>
                          <div className="mt-1.5 space-y-1.5 text-xs">
                            {docDetail.analysis.outline.map((o, i) => (
                              <div key={i}>
                                <strong className="text-slate-900 dark:text-slate-100">{o.heading}:</strong>{' '}
                                <span className="text-slate-600 dark:text-slate-400">{o.summary}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Bottom Document Toolbar (Zoom, Search, Select Text, Page X of Y) */}
            {docDetail && docDetail.status === 'ready' && docSubTab === 'reader' && (
              <div className="flex items-center justify-between border-t border-slate-200 bg-white px-4 py-2 text-xs dark:border-slate-800 dark:bg-slate-900">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setZoomPct((z) => Math.max(80, z - 10))}
                    title="Zoom Out"
                    className="rounded p-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    <ZoomOut className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setZoomPct((z) => Math.min(150, z + 10))}
                    title="Zoom In"
                    className="rounded p-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    <ZoomIn className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDocSearch((s) => !s)}
                    title="Search Document"
                    className={`rounded p-1.5 ${
                      showDocSearch
                        ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                        : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                    }`}
                  >
                    <Search className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectMode((m) => !m)}
                    title="Select text for Explain / Summarise / Rewrite"
                    className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium ${
                      selectMode
                        ? 'bg-slate-900 text-white dark:bg-blue-600'
                        : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300'
                    }`}
                  >
                    <MousePointerClick className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Select text</span>
                  </button>
                </div>

                <div className="flex items-center gap-2 font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300">
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    className="rounded p-1 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span>
                    Page {currentPage} of {pages.length}
                  </span>
                  <button
                    type="button"
                    disabled={currentPage >= pages.length}
                    onClick={() => setCurrentPage((p) => Math.min(pages.length, p + 1))}
                    className="rounded p-1 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Center-Right: Clean AI Chat Stream */}
          <div className="flex min-h-[420px] flex-col bg-white lg:col-span-6 dark:bg-slate-900">
            <div className="flex-1 space-y-5 overflow-y-auto p-5">
              {loadingMessages ? (
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-400 text-xs font-bold text-slate-950">
                    DM
                  </div>
                  <div className="max-w-lg rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-800 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200">
                    Hello, I am your document assistant. Upload or select any file on the left, highlight any paragraph to Explain/Summarise/Rewrite, or ask any question below with verified page citations.
                  </div>
                </div>
              ) : (
                messages.map((msg, idx) =>
                  msg.role === 'user' ? (
                    <div key={msg.id} className="flex flex-col items-end">
                      <div className="flex max-w-[85%] items-end gap-2">
                        <div className="rounded-2xl bg-slate-950 px-4 py-2.5 text-sm leading-relaxed text-white dark:bg-blue-600">
                          {msg.content}
                        </div>
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-500 dark:border-slate-700">
                          <User className="h-3.5 w-3.5" />
                        </div>
                      </div>
                      <span className="mt-1 pr-9 font-mono text-[10px] text-slate-400">
                        {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  ) : (
                    <div key={msg.id} className="flex items-start gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-400 text-xs font-bold text-slate-950">
                        DM
                      </div>
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-800 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200">
                          <div className="whitespace-pre-wrap">{msg.content}</div>
                          {msg.mode_notice && (
                            <p className="mt-2 border-t border-amber-200 pt-1.5 text-[11px] text-amber-700 dark:border-amber-800 dark:text-amber-400">
                              {msg.mode_notice}
                            </p>
                          )}
                          {msg.citations && msg.citations.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-200 pt-2.5 dark:border-slate-800">
                              {msg.citations.map((cit, cIdx) => (
                                <button
                                  key={cit.chunkId}
                                  type="button"
                                  onClick={() => {
                                    hasAutoSelectedRef.current = true;
                                    onSelectDocument(cit.documentId);
                                    setDocSubTab('reader');
                                    setCurrentPage(cit.pageNumber);
                                    setHighlightExcerpt(cit.excerpt);
                                  }}
                                  className="rounded-md border border-slate-200 bg-white px-2 py-0.5 font-mono text-[11px] text-slate-700 hover:border-blue-600 hover:text-blue-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                                >
                                  [Source {cIdx + 1}] p.{cit.pageNumber} · {cit.similarityScore}%
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="flex items-center justify-between px-1 text-[11px] text-slate-400">
                          <span className="font-mono">
                            {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            {msg.provider_used ? ` · ${msg.provider_used}` : ''}
                          </span>
                          <div className="flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() => void handleCopy(msg.id, msg.content)}
                              className="inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200"
                            >
                              {copiedId === msg.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                              <span>{copiedId === msg.id ? 'Copied' : 'Copy'}</span>
                            </button>
                            <SpeakButton text={msg.content} />
                            {idx === messages.length - 1 && (
                              <button
                                type="button"
                                onClick={() => void sendPrompt('', true)}
                                disabled={sending}
                                className="inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200"
                                title="Regenerate response"
                              >
                                <RefreshCw className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <ThumbsUp className="h-3.5 w-3.5 text-slate-300" />
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                )
              )}
              {sending && (
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Analyzing document & generating answer...</span>
                </div>
              )}
              <div ref={chatBottomRef} />
            </div>

            {errorMsg && (
              <div className="mx-5 mb-2 flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
                <span>{errorMsg}</span>
                <button
                  type="button"
                  onClick={() => setErrorMsg(null)}
                  className="shrink-0 font-medium underline"
                >
                  Dismiss
                </button>
              </div>
            )}

            {chatImage && (
              <div className="mx-4 mt-2 flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-950">
                <div className="flex items-center gap-2.5 min-w-0">
                  <img
                    src={chatImage.dataUrl}
                    alt={chatImage.filename}
                    className="h-10 w-10 rounded object-cover border border-slate-200 dark:border-slate-700"
                  />
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-slate-800 dark:text-slate-200">
                      {chatImage.filename}
                    </div>
                    <div className="text-[10px] text-slate-500">Image attached for multimodal AI Q&amp;A</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setChatImage(null)}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                  aria-label="Remove attached image"
                >
                  <X className="h-3.5 w-3.5" />
                  <span>Remove</span>
                </button>
              </div>
            )}

            {/* Bottom Composer matching AskYourPDF bar */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendPrompt(input, false);
              }}
              className="flex items-center gap-2 border-t border-slate-200 p-4 dark:border-slate-800"
            >
              <button
                type="button"
                onClick={() => void handleNewConversation()}
                title="Start fresh conversation"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-400 text-slate-950 hover:bg-amber-300 transition-colors"
              >
                <Brush className="h-4 w-4" />
              </button>

              <input
                ref={chatImageInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.gif"
                onChange={(e) => handleSelectChatImage(e.target.files)}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => chatImageInputRef.current?.click()}
                title="Attach image to chat (PNG, JPG, WebP, GIF)"
                className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <ImagePlus className="h-4 w-4" />
                <span className="hidden sm:inline">Image</span>
              </button>

              <VoiceInputButton
                language="en"
                onTranscript={(txt) => setInput((prev) => (prev ? `${prev} ${txt}` : txt))}
                onError={(msg) => {
                  setErrorMsg(msg);
                  showToast({ type: 'error', title: 'Voice Input Error', message: msg });
                }}
              />

              <div className="flex flex-1 items-center rounded-full border border-slate-200 bg-slate-50 px-4 py-1.5 focus-within:border-slate-400 dark:border-slate-700 dark:bg-slate-950">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={
                    chatImage
                      ? 'Ask a question about this attached image...'
                      : 'Ask any question about your document or attach an image'
                  }
                  className="min-w-0 flex-1 bg-transparent py-1 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
                />
                <button
                  type="submit"
                  disabled={sending || (!input.trim() && !chatImage)}
                  className="ml-2 flex h-7 w-7 items-center justify-center rounded-full bg-slate-950 text-white hover:bg-slate-800 disabled:opacity-30 dark:bg-blue-600"
                  aria-label="Send message"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>

      {confirmRemoveDoc && activeDocMeta && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">Remove Uploaded File</h3>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              Permanently remove <strong>{activeDocMeta.original_filename}</strong>, its extracted text, chunks, and embeddings?
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmRemoveDoc(false)}
                disabled={removingDoc}
                className="rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleRemoveActiveDoc()}
                disabled={removingDoc}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {removingDoc ? 'Removing...' : 'Remove File'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
