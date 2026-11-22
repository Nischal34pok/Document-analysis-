import { ShieldAlert, X } from 'lucide-react';
import React, { useState } from 'react';

interface CloudConsentModalProps {
  open: boolean;
  documentCount: number;
  message: string;
  onAllow: (rememberDefault: boolean) => void;
  onSwitchOffline: () => void;
  onClose: () => void;
}

export const CloudConsentModal: React.FC<CloudConsentModalProps> = ({
  open,
  documentCount,
  message,
  onAllow,
  onSwitchOffline,
  onClose,
}) => {
  const [remember, setRemember] = useState(false);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Cloud AI Privacy Consent
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          {message ||
            'DocuMind AI requires your explicit permission before sending private document content to Online Gemini AI. Your documents remain isolated to your workspace.'}
        </p>

        {documentCount > 0 && (
          <p className="mt-2 font-mono text-xs text-slate-500 dark:text-slate-400">
            Scope: {documentCount} private document{documentCount === 1 ? '' : 's'}
          </p>
        )}

        <label className="mt-4 flex cursor-pointer items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
          />
          <span>Remember this preference for future documents</span>
        </label>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onSwitchOffline}
            className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            Keep Local Only
          </button>
          <button
            type="button"
            onClick={() => onAllow(remember)}
            className="rounded-lg bg-slate-950 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 whitespace-nowrap dark:bg-blue-600 dark:hover:bg-blue-500"
          >
            Allow Cloud AI
          </button>
        </div>
      </div>
    </div>
  );
};
