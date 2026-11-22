import {
  AlertTriangle,
  BookOpen,
  FileSearch,
  Files,
  FolderUp,
  Loader2,
  LogIn,
  Menu,
  MessageSquare,
  Moon,
  RefreshCw,
  Settings,
  Sun,
  User,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AuthModal } from './components/AuthModal';
import { CloudConsentModal } from './components/CloudConsentModal';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PWAInstallButton } from './components/PWAInstallButton';
import { useToast } from './components/ToastProvider';
import { DocumentsView } from './components/Views/DocumentsView';
import { ResearchView } from './components/Views/ResearchView';
import { SettingsProfileView } from './components/Views/SettingsProfileView';
import { StudioView } from './components/Views/StudioView';
import { StudyView } from './components/Views/StudyView';
import { apiRequest, getErrorMessage } from './lib/api';
import type {
  AIMode,
  AIStatus,
  DocumentItem,
  FolderItem,
  NavSection,
  PublicUser,
} from './types';

export default function App() {
  const { showToast } = useToast();

  const [user, setUser] = useState<PublicUser | null>(null);
  const [aiStatus, setAiStatus] = useState<AIStatus | null>(null);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeNav, setActiveNav] = useState<NavSection>('studio');
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('documind_theme') === 'dark';
  });

  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<'login' | 'register'>('register');

  const [consentState, setConsentState] = useState<{
    open: boolean;
    docIds: string[];
    message: string;
    retry: (() => void) | null;
  }>({ open: false, docIds: [], message: '', retry: null });

  const prevDocStatusRef = useRef<Map<string, string>>(new Map());
  const initializedDocsRef = useRef(false);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    localStorage.setItem('documind_theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  const checkProviderAvailabilityToast = useCallback(
    (u: PublicUser, status: AIStatus) => {
      if (u.aiMode === 'online' && !status.online.configured) {
        showToast({
          type: 'warning',
          title: 'Gemini AI Provider Unavailable',
          message: 'Online Gemini requires GEMINI_API_KEY in Settings > Secrets, or switch to Ollama Local.',
          dedupeKey: 'ai-provider-unavailable',
          action: {
            label: 'AI Settings',
            onClick: () => setActiveNav('settings'),
          },
        });
      } else if (u.aiMode === 'offline' && !status.offline.available) {
        showToast({
          type: 'warning',
          title: 'Local Ollama Unavailable',
          message: `Could not reach Ollama at ${status.offline.url}. Start Ollama locally or switch AI mode.`,
          dedupeKey: 'ai-provider-unavailable',
          action: {
            label: 'AI Settings',
            onClick: () => setActiveNav('settings'),
          },
        });
      } else if (u.aiMode === 'automatic' && !status.online.configured && !status.offline.available) {
        showToast({
          type: 'warning',
          title: 'No AI Provider Available',
          message: 'Neither Online Gemini nor Local Ollama is currently reachable.',
          dedupeKey: 'ai-provider-unavailable',
          action: {
            label: 'AI Settings',
            onClick: () => setActiveNav('settings'),
          },
        });
      }
    },
    [showToast]
  );

  const syncDocumentTransitions = useCallback(
    (nextDocs: DocumentItem[]) => {
      const prevMap = prevDocStatusRef.current;

      if (initializedDocsRef.current) {
        for (const doc of nextDocs) {
          const prevStatus = prevMap.get(doc.id);
          const wasInFlight = prevStatus === 'pending' || prevStatus === 'processing';

          if (wasInFlight && doc.status === 'ready') {
            showToast({
              type: 'success',
              title: 'Document Ready',
              message: `"${doc.title}" processed (${doc.page_count} page${doc.page_count === 1 ? '' : 's'}).`,
              dedupeKey: `doc-ready-${doc.id}`,
            });
          } else if (
            (wasInFlight || prevStatus === undefined) &&
            (doc.status === 'error' || doc.status === 'ocr_failed')
          ) {
            showToast({
              type: 'error',
              title: doc.status === 'ocr_failed' ? 'Document OCR Failed' : 'Document Processing Failed',
              message: `${doc.original_filename}: ${doc.ocr_error || doc.error_message || 'Extraction failed.'}`,
              dedupeKey: `doc-fail-${doc.id}-${doc.updated_at}`,
              action: {
                label: 'Open Documents',
                onClick: () => setActiveNav('documents'),
              },
            });
          }
        }
      }

      const nextMap = new Map<string, string>();
      for (const d of nextDocs) {
        nextMap.set(d.id, d.status);
      }
      prevDocStatusRef.current = nextMap;
      initializedDocsRef.current = true;
    },
    [showToast]
  );

  const refreshDocumentsOnly = useCallback(async () => {
    try {
      const [docsRes, foldersRes] = await Promise.all([
        apiRequest<{ documents: DocumentItem[] }>('/api/documents'),
        apiRequest<{ folders: FolderItem[] }>('/api/folders'),
      ]);
      syncDocumentTransitions(docsRes.documents);
      setDocuments(docsRes.documents);
      setFolders(foldersRes.folders);
    } catch (err) {
      showToast({
        type: 'error',
        title: 'Failed to Refresh Documents',
        message: getErrorMessage(err),
        dedupeKey: 'refresh-docs-error',
      });
    }
  }, [showToast, syncDocumentTransitions]);

  const refreshWorkspace = useCallback(async () => {
    setLoadError(null);
    try {
      const [meRes, statusRes, docsRes, foldersRes] = await Promise.all([
        apiRequest<{ user: PublicUser }>('/api/auth/me'),
        apiRequest<AIStatus>('/api/ai/status'),
        apiRequest<{ documents: DocumentItem[] }>('/api/documents'),
        apiRequest<{ folders: FolderItem[] }>('/api/folders'),
      ]);
      setUser(meRes.user);
      setAiStatus(statusRes);
      syncDocumentTransitions(docsRes.documents);
      setDocuments(docsRes.documents);
      setFolders(foldersRes.folders);
      checkProviderAvailabilityToast(meRes.user, statusRes);
    } catch (err) {
      const msg = getErrorMessage(err, 'Unable to load DocuMind AI workspace.');
      setLoadError(msg);
      showToast({
        type: 'error',
        title: 'Workspace Load Error',
        message: msg,
        dedupeKey: 'workspace-load-error',
      });
    } finally {
      setLoading(false);
    }
  }, [checkProviderAvailabilityToast, showToast, syncDocumentTransitions]);

  useEffect(() => {
    void refreshWorkspace();
  }, [refreshWorkspace]);

  // Poll document processing status automatically while any document is pending/processing
  const hasProcessingDocs = documents.some((d) => d.status === 'pending' || d.status === 'processing');
  useEffect(() => {
    if (!hasProcessingDocs) return;
    const timer = setInterval(() => {
      void refreshDocumentsOnly();
    }, 1500);
    return () => clearInterval(timer);
  }, [hasProcessingDocs, refreshDocumentsOnly]);

  const handleOpenDocument = useCallback((docId: string) => {
    setActiveDocumentId(docId);
    setActiveNav('studio');
    setMobileMenuOpen(false);
  }, []);

  const handleChangeAIMode = async (mode: AIMode) => {
    if (!user) return;
    const previousMode = user.aiMode;
    setUser({ ...user, aiMode: mode });
    try {
      const [res, statusRes] = await Promise.all([
        apiRequest<{ user: PublicUser }>('/api/auth/settings', {
          method: 'PATCH',
          body: JSON.stringify({ aiMode: mode }),
        }),
        apiRequest<AIStatus>('/api/ai/status'),
      ]);
      setUser(res.user);
      setAiStatus(statusRes);
      checkProviderAvailabilityToast(res.user, statusRes);
    } catch (err) {
      setUser({ ...user, aiMode: previousMode });
      showToast({
        type: 'error',
        title: 'Failed to Switch AI Mode',
        message: getErrorMessage(err),
        dedupeKey: 'ai-mode-switch-err',
      });
    }
  };

  const handleRequireConsent = useCallback((docIds: string[], message: string, retryCallback: () => void) => {
    setConsentState({
      open: true,
      docIds,
      message,
      retry: retryCallback,
    });
  }, []);

  const handleConsentAllow = async (rememberDefault: boolean) => {
    const retry = consentState.retry;
    const docIds = consentState.docIds;
    setConsentState({ open: false, docIds: [], message: '', retry: null });
    try {
      await apiRequest('/api/documents/consent', {
        method: 'POST',
        body: JSON.stringify({ documentIds: docIds, rememberDefault }),
      });
      await refreshWorkspace();
      retry?.();
    } catch (err) {
      showToast({
        type: 'error',
        title: 'Consent Update Failed',
        message: getErrorMessage(err),
      });
    }
  };

  const handleConsentSwitchOffline = async () => {
    const retry = consentState.retry;
    setConsentState({ open: false, docIds: [], message: '', retry: null });
    try {
      const res = await apiRequest<{ user: PublicUser }>('/api/auth/settings', {
        method: 'PATCH',
        body: JSON.stringify({ aiMode: 'offline' }),
      });
      setUser(res.user);
      await refreshWorkspace();
      retry?.();
    } catch (err) {
      showToast({
        type: 'error',
        title: 'Failed to Switch to Offline Mode',
        message: getErrorMessage(err),
      });
    }
  };

  const readyCount = documents.filter((d) => d.status === 'ready').length;
  const failedCount = documents.filter((d) => d.status === 'error' || d.status === 'ocr_failed').length;
  const isProviderDegraded =
    user && aiStatus
      ? (user.aiMode === 'online' && !aiStatus.online.configured) ||
        (user.aiMode === 'offline' && !aiStatus.offline.available) ||
        (user.aiMode === 'automatic' && !aiStatus.online.configured && !aiStatus.offline.available)
      : false;

  const navItems: Array<{ id: NavSection; label: string; icon: React.ReactNode }> = [
    { id: 'studio', label: 'Studio & Chat', icon: <MessageSquare className="h-4 w-4" /> },
    { id: 'documents', label: 'Documents', icon: <Files className="h-4 w-4" /> },
    { id: 'upload', label: 'Upload', icon: <FolderUp className="h-4 w-4" /> },
    { id: 'research', label: 'Research', icon: <FileSearch className="h-4 w-4" /> },
    { id: 'study', label: 'Study', icon: <BookOpen className="h-4 w-4" /> },
  ];

  if (loading && !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white dark:bg-slate-950">
        <Loader2 className="h-6 w-6 animate-spin text-slate-900 dark:text-slate-100" />
      </div>
    );
  }

  if (!user && loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 dark:bg-slate-950">
        <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <h1 className="mt-4 text-base font-semibold text-slate-900 dark:text-slate-100">
            Unable to Connect to DocuMind AI
          </h1>
          <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-400">{loadError}</p>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void refreshWorkspace();
            }}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-slate-950 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 dark:bg-blue-600"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-white text-slate-900 md:flex-row dark:bg-slate-950 dark:text-slate-100">
      {/* Far-Left Dark Charcoal Icon Rail (Desktop) */}
      <aside className="hidden w-14 shrink-0 flex-col items-center justify-between bg-[#0B0D11] py-3.5 text-slate-400 md:flex">
        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => setActiveNav('studio')}
            title="DocuMind AI Studio"
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-400 font-display text-xs font-bold text-slate-950 transition-transform hover:scale-105"
          >
            DM
          </button>

          <div className="my-1 h-px w-6 bg-slate-800" />

          <nav className="flex flex-col items-center gap-2">
            {navItems.map((item) => {
              const isActive = activeNav === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveNav(item.id)}
                  title={item.label}
                  aria-label={item.label}
                  className={`relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
                    isActive
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                  }`}
                >
                  {item.icon}
                  {item.id === 'studio' && readyCount > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-white px-1 font-mono text-[9px] font-bold text-slate-950">
                      {readyCount}
                    </span>
                  )}
                  {item.id === 'documents' && failedCount > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 font-mono text-[9px] font-bold text-white">
                      {failedCount}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => setDarkMode((d) => !d)}
            title={darkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            aria-label="Toggle dark mode"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
          >
            {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>

          <button
            type="button"
            onClick={() => setActiveNav('settings')}
            title={isProviderDegraded ? 'AI Provider Warning — Open Settings' : 'AI Modes & Settings'}
            aria-label="Settings"
            className={`relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
              activeNav === 'settings'
                ? 'bg-slate-800 text-white'
                : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
            }`}
          >
            <Settings className="h-4 w-4" />
            {isProviderDegraded && (
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-400" />
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              if (user?.isGuest) {
                setAuthModalMode('login');
                setAuthModalOpen(true);
              } else {
                setActiveNav('settings');
              }
            }}
            title={user?.isGuest ? 'Sign In or Create Account' : user?.displayName || 'Account'}
            aria-label="Account"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
          >
            {user?.isGuest ? <LogIn className="h-4 w-4" /> : <User className="h-4 w-4" />}
          </button>
        </div>
      </aside>

      {/* Mobile Compact Header */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200 bg-[#0B0D11] px-3 text-white md:hidden">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="rounded-md p-1.5 text-slate-300 hover:bg-slate-800"
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-amber-400 text-[10px] font-bold text-slate-950">
              DM
            </span>
            <span className="font-display text-sm font-bold tracking-tight">DocuMind AI</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <PWAInstallButton />
          <button
            type="button"
            onClick={() => setDarkMode((d) => !d)}
            className="rounded-md p-1.5 text-slate-300 hover:bg-slate-800"
            aria-label="Toggle dark mode"
          >
            {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          {user?.isGuest && (
            <button
              type="button"
              onClick={() => {
                setAuthModalMode('login');
                setAuthModalOpen(true);
              }}
              className="rounded-md bg-white px-2.5 py-1 text-xs font-medium text-slate-950"
            >
              Sign In
            </button>
          )}
        </div>
      </header>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div className="fixed inset-0 bg-slate-950/60" onClick={() => setMobileMenuOpen(false)} />
          <div className="relative flex w-64 flex-col bg-[#0B0D11] p-4 text-slate-200">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded bg-amber-400 text-xs font-bold text-slate-950">
                  DM
                </span>
                <span className="font-display text-base font-bold text-white">DocuMind AI</span>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-md p-1 text-slate-400 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <nav className="mt-4 flex-1 space-y-1">
              {[...navItems, { id: 'settings' as NavSection, label: 'Settings', icon: <Settings className="h-4 w-4" /> }].map(
                (item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveNav(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium ${
                      activeNav === item.id
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                    }`}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                )
              )}
            </nav>

            {user && (
              <div className="border-t border-slate-800 pt-3 text-xs text-slate-400">
                <p className="font-medium text-white">{user.displayName}</p>
                <p className="truncate font-mono text-[11px]">
                  {user.isGuest ? 'Guest Workspace' : user.email}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-slate-50/50 dark:bg-slate-950">
        {activeNav === 'studio' && user && (
          <StudioView
            documents={documents}
            activeDocumentId={activeDocumentId}
            aiMode={user.aiMode}
            cloudConsentDefault={user.cloudConsentDefault}
            onSelectDocument={(id) => setActiveDocumentId(id)}
            onChangeAIMode={handleChangeAIMode}
            onOpenDocumentsLibrary={() => setActiveNav('documents')}
            onOpenSettings={() => setActiveNav('settings')}
            onRefreshWorkspace={refreshWorkspace}
            onRequireConsent={handleRequireConsent}
          />
        )}

        {(activeNav === 'upload' || activeNav === 'documents') && user && (
          <div className="flex-1 overflow-y-auto">
            <DocumentsView
              mode={activeNav}
              documents={documents}
              folders={folders}
              cloudConsentDefault={user.cloudConsentDefault}
              onRefresh={refreshDocumentsOnly}
              onOpenDocument={handleOpenDocument}
            />
          </div>
        )}

        {activeNav === 'research' && (
          <div className="flex-1 overflow-y-auto">
            <ResearchView
              documents={documents}
              onRequireConsent={handleRequireConsent}
              onOpenDocument={handleOpenDocument}
              onOpenSettings={() => setActiveNav('settings')}
            />
          </div>
        )}

        {activeNav === 'study' && (
          <div className="flex-1 overflow-y-auto">
            <StudyView
              documents={documents}
              onRequireConsent={handleRequireConsent}
              onOpenSettings={() => setActiveNav('settings')}
            />
          </div>
        )}

        {activeNav === 'settings' && user && (
          <div className="flex-1 overflow-y-auto">
            <SettingsProfileView
              user={user}
              aiStatus={aiStatus}
              onUserUpdated={(u) => {
                setUser(u);
                void refreshWorkspace();
              }}
              onRefreshStatus={async () => {
                try {
                  const s = await apiRequest<AIStatus>('/api/ai/status');
                  setAiStatus(s);
                  checkProviderAvailabilityToast(user, s);
                } catch (err) {
                  showToast({
                    type: 'error',
                    title: 'Status Check Failed',
                    message: getErrorMessage(err),
                  });
                }
              }}
              onOpenAuth={(m) => {
                setAuthModalMode(m);
                setAuthModalOpen(true);
              }}
            />
          </div>
        )}
      </main>

      {/* Global Modals & Offline Indicator */}
      <CloudConsentModal
        open={consentState.open}
        documentCount={consentState.docIds.length}
        message={consentState.message}
        onAllow={(remember) => void handleConsentAllow(remember)}
        onSwitchOffline={() => void handleConsentSwitchOffline()}
        onClose={() => setConsentState({ open: false, docIds: [], message: '', retry: null })}
      />

      {user && (
        <AuthModal
          open={authModalOpen}
          initialMode={authModalMode}
          isGuest={user.isGuest}
          onClose={() => setAuthModalOpen(false)}
          onSuccess={(newUser) => {
            setUser(newUser);
            void refreshWorkspace();
          }}
        />
      )}

      <OfflineIndicator />
    </div>
  );
}
