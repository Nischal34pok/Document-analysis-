import { AlertTriangle, CheckCircle2, Cloud, Cpu, History, LogIn, LogOut, RefreshCw, Shield, Trash2, UserCheck, Zap } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { apiRequest, getErrorMessage } from '../../lib/api';
import type { AIMode, AIStatus, AuditLogItem, ExportHistoryItem, PublicUser } from '../../types';
import { useToast } from '../ToastProvider';

interface SettingsProfileViewProps {
  user: PublicUser;
  aiStatus: AIStatus | null;
  onUserUpdated: (u: PublicUser) => void;
  onRefreshStatus: () => Promise<void>;
  onOpenAuth: (mode: 'login' | 'register') => void;
}

export const SettingsProfileView: React.FC<SettingsProfileViewProps> = ({
  user,
  aiStatus,
  onUserUpdated,
  onRefreshStatus,
  onOpenAuth,
}) => {
  const { showToast } = useToast();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [aiMode, setAiMode] = useState<AIMode>(user.aiMode);
  const [ollamaUrl, setOllamaUrl] = useState(user.ollamaUrl);
  const [ollamaModel, setOllamaModel] = useState(user.ollamaModel);
  const [cloudConsentDefault, setCloudConsentDefault] = useState(user.cloudConsentDefault);
  const [chunkSize, setChunkSize] = useState(user.chunkSize);
  const [chunkOverlap, setChunkOverlap] = useState(user.chunkOverlap);

  const [saving, setSaving] = useState(false);
  const [testingAI, setTestingAI] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [exportHistory, setExportHistory] = useState<ExportHistoryItem[]>([]);
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);

  useEffect(() => {
    setDisplayName(user.displayName);
    setAiMode(user.aiMode);
    setOllamaUrl(user.ollamaUrl);
    setOllamaModel(user.ollamaModel);
    setCloudConsentDefault(user.cloudConsentDefault);
    setChunkSize(user.chunkSize);
    setChunkOverlap(user.chunkOverlap);
  }, [user]);

  useEffect(() => {
    void apiRequest<{ logs: AuditLogItem[] }>('/api/audit-logs')
      .then((res) => setAuditLogs(res.logs))
      .catch((err) => {
        showToast({
          type: 'error',
          title: 'Failed to Load Audit Logs',
          message: getErrorMessage(err),
          dedupeKey: 'audit-logs-err',
        });
      });
    void apiRequest<{ history: ExportHistoryItem[] }>('/api/exports/history')
      .then((res) => setExportHistory(res.history))
      .catch((err) => {
        showToast({
          type: 'error',
          title: 'Failed to Load Export History',
          message: getErrorMessage(err),
          dedupeKey: 'export-history-err',
        });
      });
  }, [user.id, showToast]);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveFeedback(null);
    try {
      const res = await apiRequest<{ user: PublicUser }>('/api/auth/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          displayName,
          aiMode,
          ollamaUrl,
          ollamaModel,
          cloudConsentDefault,
          chunkSize: Number(chunkSize),
          chunkOverlap: Number(chunkOverlap),
        }),
      });
      onUserUpdated(res.user);
      await onRefreshStatus();
      setSaveFeedback({ type: 'success', text: 'Settings saved.' });
      showToast({ type: 'success', title: 'Settings Saved', message: 'Your AI & workspace preferences were updated.' });
    } catch (err) {
      const msg = getErrorMessage(err, 'Failed to save settings');
      setSaveFeedback({ type: 'error', text: msg });
      showToast({ type: 'error', title: 'Save Failed', message: msg });
    } finally {
      setSaving(false);
    }
  };

  const handleTestAIConnection = async () => {
    setTestingAI(true);
    try {
      const res = await apiRequest<{ ok: boolean; providerUsed: string; modelUsed: string; modeNotice?: string }>(
        '/api/ai/test',
        { method: 'POST' }
      );
      showToast({
        type: 'success',
        title: 'AI Provider Connected',
        message: res.modeNotice || `Responded via ${res.providerUsed} (${res.modelUsed}).`,
      });
    } catch (err) {
      showToast({
        type: 'error',
        title: 'AI Connection Test Failed',
        message: getErrorMessage(err),
      });
    } finally {
      setTestingAI(false);
    }
  };

  const handleLogout = async () => {
    try {
      const res = await apiRequest<{ user: PublicUser }>('/api/auth/logout', { method: 'POST' });
      onUserUpdated(res.user);
      showToast({ type: 'info', title: 'Signed Out', message: 'Switched to a clean Guest Workspace.' });
    } catch (err) {
      showToast({ type: 'error', title: 'Sign Out Failed', message: getErrorMessage(err) });
    }
  };

  const handleDeleteAccount = async () => {
    try {
      const res = await apiRequest<{ user: PublicUser }>('/api/auth/account', { method: 'DELETE' });
      setConfirmDeleteAccount(false);
      onUserUpdated(res.user);
      showToast({ type: 'info', title: 'Account Deleted', message: 'All account data was permanently erased.' });
    } catch (err) {
      showToast({ type: 'error', title: 'Account Deletion Failed', message: getErrorMessage(err) });
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="border-b border-slate-200 pb-4 dark:border-slate-800">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Settings & Account
        </h1>
      </div>

      {/* Profile & Account Isolation */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 overflow-hidden rounded-full border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800">
              {!avatarFailed ? (
                <img
                  src="/src/assets/images/documind_user_avatar_1795083608476.jpg"
                  alt="User profile avatar"
                  referrerPolicy="no-referrer"
                  onError={() => setAvatarFailed(true)}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-slate-500">
                  <UserCheck className="h-6 w-6" />
                </div>
              )}
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{user.displayName}</h2>
              <p className="font-mono text-xs text-slate-500 dark:text-slate-400">
                {user.isGuest ? 'Isolated Guest Workspace' : user.email}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {user.isGuest ? (
              <>
                <button
                  type="button"
                  onClick={() => onOpenAuth('register')}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-950 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800 dark:bg-blue-600"
                >
                  <UserCheck className="h-3.5 w-3.5" /> Create Account
                </button>
                <button
                  type="button"
                  onClick={() => onOpenAuth('login')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200"
                >
                  <LogIn className="h-3.5 w-3.5" /> Sign In
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200"
              >
                <LogOut className="h-3.5 w-3.5" /> Sign Out
              </button>
            )}
            <button
              type="button"
              onClick={() => setConfirmDeleteAccount(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete Account
            </button>
          </div>
        </div>
      </div>

      {/* AI Mode & RAG Configuration */}
      <form
        onSubmit={handleSaveSettings}
        className="space-y-6 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"
      >
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">AI Processing & Privacy Mode</h3>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {(
              [
                ['automatic', 'Automatic Mode', 'Prefers Online Gemini when consented; falls back to Local Ollama.'],
                ['online', 'Online Mode (Gemini)', 'Uses Cloud Gemini 4 & Embedding-2 with explicit consent.'],
                ['offline', 'Offline Mode (Ollama)', 'Processes strictly on your configured local Ollama server.'],
              ] as const
            ).map(([val, label, desc]) => (
              <button
                key={val}
                type="button"
                onClick={() => setAiMode(val)}
                className={`rounded-xl border p-4 text-left transition-colors ${
                  aiMode === val
                    ? 'border-slate-950 bg-slate-50 dark:border-blue-500 dark:bg-blue-950/30'
                    : 'border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40'
                }`}
              >
                <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">{label}</div>
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{desc}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex items-start gap-2.5 text-xs">
              <Cloud className="mt-0.5 h-4 w-4 text-blue-700 dark:text-blue-400" />
              <div>
                <div className="font-semibold text-slate-900 dark:text-slate-100">
                  Online Gemini:{' '}
                  {aiStatus?.online.configured
                    ? 'Connected (Direct Gemini Billing via Settings > Secrets)'
                    : 'Configure GEMINI_API_KEY in Settings > Secrets'}
                </div>
                <div className="font-mono text-[11px] text-slate-500">
                  {aiStatus?.online.textModel} · {aiStatus?.online.embeddingModel}
                </div>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  Free-tier quota is used first; attach a billing-enabled key in{' '}
                  <span className="font-semibold text-slate-700 dark:text-slate-300">Settings &gt; Secrets</span> to pay
                  Google Gemini directly beyond free limits.
                </p>
              </div>
            </div>

            <div className="flex items-start justify-between gap-2 text-xs">
              <div className="flex items-start gap-2.5">
                <Cpu className="mt-0.5 h-4 w-4 text-amber-600 dark:text-amber-400" />
                <div>
                  <div className="font-semibold text-slate-900 dark:text-slate-100">
                    Local Ollama:{' '}
                    {aiStatus?.offline.available
                      ? `Online (${aiStatus.offline.models.length} models)`
                      : 'Offline / Unreachable'}
                  </div>
                  <div className="font-mono text-[11px] text-slate-500">
                    {aiStatus?.offline.models.slice(0, 3).join(', ') || aiStatus?.offline.error || ollamaUrl}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleTestAIConnection()}
                  disabled={testingAI}
                  title="Test live AI inference"
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                >
                  <Zap className="h-3 w-3" />
                  {testingAI ? 'Testing...' : 'Test AI'}
                </button>
                <button
                  type="button"
                  onClick={() => void onRefreshStatus()}
                  title="Re-check AI & Ollama status"
                  className="rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-white dark:border-slate-700 dark:text-slate-300"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          {aiStatus?.usageSummary && (
            <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <span className="font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Direct Gemini API Usage (Workspace Metering)
                </span>
                <a
                  href="https://aistudio.google.com/usage"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-blue-700 hover:underline dark:text-blue-400"
                >
                  Open Google AI Studio Billing &amp; Usage ↗
                </a>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
                  <div className="text-[10px] uppercase text-slate-400">API Calls</div>
                  <div className="mt-0.5 font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {aiStatus.usageSummary.totalRequests.toLocaleString()}
                  </div>
                </div>
                <div className="rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
                  <div className="text-[10px] uppercase text-slate-400">Input Tokens</div>
                  <div className="mt-0.5 font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {aiStatus.usageSummary.promptTokens.toLocaleString()}
                  </div>
                </div>
                <div className="rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
                  <div className="text-[10px] uppercase text-slate-400">Output Tokens</div>
                  <div className="mt-0.5 font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {aiStatus.usageSummary.outputTokens.toLocaleString()}
                  </div>
                </div>
                <div className="rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
                  <div className="text-[10px] uppercase text-slate-400">Quota Hits (429)</div>
                  <div
                    className={`mt-0.5 font-mono text-sm font-semibold ${
                      aiStatus.usageSummary.quotaHits > 0
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-slate-900 dark:text-slate-100'
                    }`}
                  >
                    {aiStatus.usageSummary.quotaHits.toLocaleString()}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">Display Name</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">Local Ollama URL</label>
            <input
              type="url"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              placeholder="http://127.0.0.1:11434"
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">Ollama Model Name</label>
            <input
              type="text"
              value={ollamaModel}
              onChange={(e) => setOllamaModel(e.target.value)}
              placeholder="llama3.2"
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              RAG Chunk Size (characters)
            </label>
            <input
              type="number"
              min={300}
              max={2500}
              value={chunkSize}
              onChange={(e) => setChunkSize(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              RAG Chunk Overlap (characters)
            </label>
            <input
              type="number"
              min={0}
              max={1000}
              value={chunkOverlap}
              onChange={(e) => setChunkOverlap(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
            />
          </div>
        </div>

        <label className="flex cursor-pointer items-center gap-2.5 text-xs text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={cloudConsentDefault}
            onChange={(e) => setCloudConsentDefault(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-slate-900"
          />
          <span>Automatically permit Cloud AI (Gemini) for newly uploaded documents without asking each time</span>
        </label>

        <div className="flex items-center justify-between border-t border-slate-100 pt-4 dark:border-slate-800">
          {saveFeedback ? (
            <span
              className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                saveFeedback.type === 'error'
                  ? 'text-red-700 dark:text-red-400'
                  : 'text-emerald-700 dark:text-emerald-400'
              }`}
            >
              {saveFeedback.type === 'error' ? (
                <AlertTriangle className="h-4 w-4" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}{' '}
              {saveFeedback.text}
            </span>
          ) : (
            <span />
          )}
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-slate-950 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </form>

      {/* Audit Logs & Export History */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-slate-500" />
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Security & Activity Audit Log</h3>
          </div>
          <div className="mt-3 max-h-60 space-y-2 overflow-y-auto">
            {auditLogs.length === 0 ? (
              <p className="text-xs text-slate-400">No audit events recorded yet.</p>
            ) : (
              auditLogs.map((log) => (
                <div key={log.id} className="border-b border-slate-100 pb-2 text-xs dark:border-slate-800">
                  <div className="flex justify-between font-mono text-[11px]">
                    <span className="font-medium text-slate-800 dark:text-slate-200">{log.action}</span>
                    <span className="text-slate-400">{new Date(log.created_at).toLocaleString()}</span>
                  </div>
                  {log.details && <p className="mt-0.5 text-slate-500 dark:text-slate-400">{log.details}</p>}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-slate-500" />
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Export History</h3>
          </div>
          <div className="mt-3 max-h-60 space-y-2 overflow-y-auto">
            {exportHistory.length === 0 ? (
              <p className="text-xs text-slate-400">No exports generated yet.</p>
            ) : (
              exportHistory.map((ex) => (
                <div key={ex.id} className="flex items-center justify-between border-b border-slate-100 pb-2 text-xs dark:border-slate-800">
                  <span className="truncate font-medium text-slate-800 dark:text-slate-200">{ex.title}</span>
                  <span className="font-mono text-[11px] uppercase text-slate-500">
                    {ex.format} · {new Date(ex.created_at).toLocaleDateString()}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {confirmDeleteAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">Delete Account & Data</h3>
            <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
              This permanently erases your account, uploaded files, vector embeddings, chats, study sets, and research reports.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteAccount(false)}
                className="rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-700 dark:border-slate-700 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteAccount()}
                className="rounded-lg bg-red-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-red-700"
              >
                Delete Everything
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
