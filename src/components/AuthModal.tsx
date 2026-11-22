import { Lock, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { apiRequest, getErrorMessage } from '../lib/api';
import type { PublicUser } from '../types';
import { useToast } from './ToastProvider';

interface AuthModalProps {
  open: boolean;
  initialMode?: 'login' | 'register';
  isGuest: boolean;
  onClose: () => void;
  onSuccess: (user: PublicUser) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  open,
  initialMode = 'register',
  isGuest,
  onClose,
  onSuccess,
}) => {
  const { showToast } = useToast();
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [migrateGuest, setMigrateGuest] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setError(null);
    }
  }, [open, initialMode]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const data = await apiRequest<{ user: PublicUser }>(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          email,
          password,
          displayName,
          migrateGuest: isGuest && migrateGuest,
        }),
      });
      showToast({
        type: 'success',
        title: mode === 'register' ? 'Account Created' : 'Signed In',
        message: `Welcome, ${data.user.displayName}.`,
      });
      onSuccess(data.user);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, 'Authentication failed. Please check your credentials.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-blue-700 dark:text-blue-400" />
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {mode === 'register' ? 'Create DocuMind Account' : 'Sign In to DocuMind'}
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

        <div className="mt-4 flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
          <button
            type="button"
            onClick={() => {
              setMode('register');
              setError(null);
            }}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
              mode === 'register'
                ? 'bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            Create Account
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('login');
              setError(null);
            }}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
              mode === 'login'
                ? 'bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            Sign In
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3.5">
          {mode === 'register' && (
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Full Name
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Aarav Sharma"
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Email Address
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="researcher@example.com"
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Password (min 8 characters)
            </label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>

          {isGuest && (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              <input
                type="checkbox"
                checked={migrateGuest}
                onChange={(e) => setMigrateGuest(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-700"
              />
              <span>Keep documents and chats from my current Guest Workspace</span>
            </label>
          )}

          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-500"
            >
              {loading ? 'Please wait...' : mode === 'register' ? 'Create Account' : 'Sign In'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
