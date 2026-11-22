import { BookMarked, Download, GitCompare, Loader2, Search, ShieldAlert, Trash2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { ApiConsentError, apiRequest, downloadExportFile, getErrorMessage, isAIUnavailableError, isQuotaExceededError } from '../../lib/api';
import type { DocumentItem, ResearchReportRecord, RetrievedPassage } from '../../types';
import { useToast } from '../ToastProvider';

interface ResearchViewProps {
  documents: DocumentItem[];
  onRequireConsent: (docIds: string[], message: string, retryCallback: () => void) => void;
  onOpenDocument: (docId: string) => void;
  onOpenSettings: () => void;
}

export const ResearchView: React.FC<ResearchViewProps> = ({
  documents,
  onRequireConsent,
  onOpenDocument,
  onOpenSettings,
}) => {
  const { showToast } = useToast();
  const readyDocs = documents.filter((d) => d.status === 'ready');

  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [passages, setPassages] = useState<RetrievedPassage[]>([]);

  const [researchMode, setResearchMode] = useState<'report' | 'compare' | 'contradictions' | 'references'>('report');
  const [generating, setGenerating] = useState(false);
  const [reports, setReports] = useState<ResearchReportRecord[]>([]);
  const [activeReport, setActiveReport] = useState<ResearchReportRecord | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    void apiRequest<{ reports: ResearchReportRecord[] }>('/api/research/reports')
      .then((res) => {
        setReports(res.reports);
        if (res.reports.length > 0) setActiveReport(res.reports[0]);
      })
      .catch((err) => {
        showToast({
          type: 'error',
          title: 'Failed to Load Research Reports',
          message: getErrorMessage(err),
          dedupeKey: 'research-load-err',
        });
      });
  }, [showToast]);

  const toggleDoc = (id: string) => {
    setSelectedDocIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setErrorMsg(null);
    try {
      const res = await apiRequest<{ results: RetrievedPassage[] }>('/api/search', {
        method: 'POST',
        body: JSON.stringify({
          query: query.trim(),
          documentIds: selectedDocIds.length > 0 ? selectedDocIds : undefined,
          topK: 12,
        }),
      });
      setPassages(res.results);
      if (res.results.length === 0) {
        showToast({
          type: 'info',
          title: 'No Matching Passages',
          message: 'Try broader keywords or upload more documents.',
        });
      }
    } catch (err) {
      const msg = getErrorMessage(err, 'Search failed');
      setErrorMsg(msg);
      showToast({ type: 'error', title: 'Search Failed', message: msg });
    } finally {
      setSearching(false);
    }
  };

  const runResearchAnalysis = async () => {
    const targetIds = selectedDocIds.length > 0 ? selectedDocIds : readyDocs.map((d) => d.id);
    if (targetIds.length === 0) {
      const msg = 'Upload and process at least one document first.';
      setErrorMsg(msg);
      showToast({ type: 'warning', title: 'No Ready Documents', message: msg });
      return;
    }
    setGenerating(true);
    setErrorMsg(null);
    try {
      const res = await apiRequest<{ reportRecord: ResearchReportRecord }>('/api/research/analyze', {
        method: 'POST',
        body: JSON.stringify({
          documentIds: targetIds,
          mode: researchMode,
          query: query.trim() || 'Cross-document synthesis, findings comparison, and reference extraction',
          language: 'en',
        }),
      });
      setReports((prev) => [res.reportRecord, ...prev]);
      setActiveReport(res.reportRecord);
      showToast({
        type: 'success',
        title: 'Research Report Ready',
        message: `Generated "${res.reportRecord.title}".`,
      });
    } catch (err) {
      if (err instanceof ApiConsentError) {
        onRequireConsent(err.documentIds, err.message, () => void runResearchAnalysis());
      } else {
        const msg = getErrorMessage(err, 'Research synthesis failed');
        setErrorMsg(msg);
        if (isQuotaExceededError(err)) {
          showToast({
            type: 'warning',
            title: 'Gemini Quota Limit Reached',
            message: msg,
            action: { label: 'AI Settings', onClick: onOpenSettings },
          });
        } else if (isAIUnavailableError(err)) {
          showToast({
            type: 'error',
            title: 'AI Provider Unavailable',
            message: msg,
            action: { label: 'AI Settings', onClick: onOpenSettings },
          });
        } else {
          showToast({ type: 'error', title: 'Research Synthesis Failed', message: msg });
        }
      }
    } finally {
      setGenerating(false);
    }
  };

  const handleDeleteReport = async (id: string) => {
    try {
      await apiRequest(`/api/research/reports/${id}`, { method: 'DELETE' });
      setReports((prev) => prev.filter((r) => r.id !== id));
      if (activeReport?.id === id) setActiveReport(null);
      showToast({ type: 'info', title: 'Report Deleted', message: 'Research report removed.' });
    } catch (err) {
      showToast({ type: 'error', title: 'Delete Failed', message: getErrorMessage(err) });
    }
  };

  const exportReport = async (format: 'pdf' | 'docx' | 'md' | 'txt') => {
    if (!activeReport) return;
    const r = activeReport.report;
    const sections = [
      r.executiveSummary ? `## Executive Summary\n${r.executiveSummary}` : '',
      r.comparisonMatrix?.length
        ? `## Document Comparison\n${r.comparisonMatrix.map((c) => `- **${c.dimension}**: ${c.findings}`).join('\n')}`
        : '',
      r.contradictions?.length
        ? `## Contradictions & Discrepancies\n${r.contradictions.map((c) => `- **${c.topic}**: ${c.detail}`).join('\n')}`
        : '',
      r.extractedReferences?.length
        ? `## Extracted References\n${r.extractedReferences.map((ref) => `- ${ref}`).join('\n')}`
        : '',
      r.structuredMarkdown ? `## Detailed Synthesis\n${r.structuredMarkdown}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      await downloadExportFile({
        title: activeReport.title,
        content: sections || activeReport.title,
        format,
        sourceType: 'research_report',
      });
      showToast({
        type: 'success',
        title: 'Export Ready',
        message: `Exported report as ${format.toUpperCase()}.`,
      });
    } catch (err) {
      showToast({ type: 'error', title: 'Export Failed', message: getErrorMessage(err) });
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="border-b border-slate-200 pb-4 dark:border-slate-800">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Document Research Assistant
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Run hybrid semantic and keyword search, compare multiple documents, and detect contradictions.
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-4">
          <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            Target Documents ({selectedDocIds.length === 0 ? `All ${readyDocs.length} ready` : `${selectedDocIds.length} selected`})
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {readyDocs.map((d) => {
              const active = selectedDocIds.includes(d.id);
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => toggleDoc(d.id)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? 'border-slate-900 bg-slate-900 text-white dark:border-blue-500 dark:bg-blue-600'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300'
                  }`}
                >
                  {d.title}
                </button>
              );
            })}
          </div>
        </div>

        <form onSubmit={handleSearch} className="flex flex-wrap gap-2">
          <div className="relative min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search passages across selected documents..."
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>
          <button
            type="submit"
            disabled={searching}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {searching ? 'Searching...' : 'Search Passages'}
          </button>
        </form>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
            {(
              [
                ['report', 'Research Report'],
                ['compare', 'Compare Documents'],
                ['contradictions', 'Find Contradictions'],
                ['references', 'Extract References'],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setResearchMode(val)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
                  researchMode === val
                    ? 'bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void runResearchAnalysis()}
            disabled={generating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-950 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600"
          >
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitCompare className="h-3.5 w-3.5" />}
            {generating ? 'Synthesizing...' : 'Run Research Analysis'}
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
          {errorMsg}
        </div>
      )}

      {passages.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Ranked Hybrid Search Passages ({passages.length})
            </h2>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {passages.map((p) => (
              <div key={p.chunkId} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenDocument(p.documentId)}
                    className="text-xs font-semibold text-blue-700 hover:underline dark:text-blue-400"
                  >
                    {p.documentTitle}
                  </button>
                  <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
                    Page {p.pageNumber} · Similarity {p.similarityScore}% · {p.matchType}
                  </span>
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">{p.excerpt}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="rounded-xl border border-slate-200 bg-white p-4 lg:col-span-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Saved Research Reports</h2>
          <div className="mt-3 space-y-1.5">
            {reports.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-400">
                Run a comparison, contradiction check, or synthesis report above.
              </p>
            ) : (
              reports.map((rep) => (
                <div
                  key={rep.id}
                  className={`group flex items-center justify-between gap-2 rounded-lg p-2.5 text-xs ${
                    activeReport?.id === rep.id
                      ? 'bg-slate-100 font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                      : 'text-slate-600 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActiveReport(rep)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate">{rep.title}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                      {new Date(rep.created_at).toLocaleDateString()}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteReport(rep.id)}
                    title="Delete report"
                    className="p-1 text-slate-400 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-8 dark:border-slate-800 dark:bg-slate-900">
          {!activeReport ? (
            <div className="flex h-64 flex-col items-center justify-center text-center">
              <BookMarked className="h-8 w-8 text-slate-300 dark:text-slate-600" />
              <p className="mt-3 text-xs text-slate-500">Select or generate a research report to view details.</p>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4 dark:border-slate-800">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{activeReport.title}</h3>
                  <p className="mt-0.5 text-xs text-slate-500">Query: {activeReport.query}</p>
                </div>
                <div className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 dark:border-slate-700">
                  <Download className="h-3.5 w-3.5 text-slate-500" />
                  {(['pdf', 'docx', 'md', 'txt'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => void exportReport(fmt)}
                      className="rounded px-1.5 py-0.5 font-mono text-[11px] uppercase text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      {fmt}
                    </button>
                  ))}
                </div>
              </div>

              {activeReport.report.executiveSummary && (
                <div>
                  <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Executive Summary</h4>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                    {activeReport.report.executiveSummary}
                  </p>
                </div>
              )}

              {activeReport.report.comparisonMatrix && activeReport.report.comparisonMatrix.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Comparison Matrix</h4>
                  <div className="mt-2 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 dark:bg-slate-950">
                        <tr>
                          <th className="border-b border-slate-200 px-3 py-2 font-medium dark:border-slate-800">Dimension</th>
                          <th className="border-b border-slate-200 px-3 py-2 font-medium dark:border-slate-800">Findings</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {activeReport.report.comparisonMatrix.map((row, idx) => (
                          <tr key={idx}>
                            <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">{row.dimension}</td>
                            <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{row.findings}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {activeReport.report.contradictions && activeReport.report.contradictions.length > 0 && (
                <div>
                  <h4 className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
                    <ShieldAlert className="h-4 w-4" /> Contradictions & Discrepancies
                  </h4>
                  <div className="mt-2 space-y-2">
                    {activeReport.report.contradictions.map((c, idx) => (
                      <div key={idx} className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs dark:border-amber-900 dark:bg-amber-950/30">
                        <p className="font-semibold text-slate-900 dark:text-slate-100">{c.topic}</p>
                        <p className="mt-1 text-slate-700 dark:text-slate-300">{c.detail}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeReport.report.extractedReferences && activeReport.report.extractedReferences.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Extracted References</h4>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-slate-700 dark:text-slate-300">
                    {activeReport.report.extractedReferences.map((ref, idx) => (
                      <li key={idx}>{ref}</li>
                    ))}
                  </ul>
                </div>
              )}

              {activeReport.report.structuredMarkdown && (
                <div>
                  <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Detailed Synthesis</h4>
                  <div className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                    {activeReport.report.structuredMarkdown}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
