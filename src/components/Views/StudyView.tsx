import { Award, BookOpen, CheckCircle2, Download, GraduationCap, Loader2, RotateCw, Trash2, XCircle } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { ApiConsentError, apiRequest, downloadExportFile, getErrorMessage, isAIUnavailableError, isQuotaExceededError } from '../../lib/api';
import type { DocumentItem, QuizAttempt, StudySet } from '../../types';
import { useToast } from '../ToastProvider';

interface StudyViewProps {
  documents: DocumentItem[];
  onRequireConsent: (docIds: string[], message: string, retryCallback: () => void) => void;
  onOpenSettings: () => void;
}

export const StudyView: React.FC<StudyViewProps> = ({
  documents,
  onRequireConsent,
  onOpenSettings,
}) => {
  const { showToast } = useToast();
  const readyDocs = documents.filter((d) => d.status === 'ready');

  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [kind, setKind] = useState<
    'mcq' | 'flashcards' | 'short_answer' | 'long_answer' | 'revision_notes' | 'chapter_notes' | 'study_plan'
  >('mcq');
  const [difficulty, setDifficulty] = useState<'beginner' | 'intermediate' | 'advanced' | 'exam'>('intermediate');
  const [topic, setTopic] = useState('');
  const [generating, setGenerating] = useState(false);

  const [studySets, setStudySets] = useState<StudySet[]>([]);
  const [attempts, setAttempts] = useState<QuizAttempt[]>([]);
  const [activeSet, setActiveSet] = useState<StudySet | null>(null);

  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [quizSubmitted, setQuizSubmitted] = useState(false);
  const [flippedCards, setFlippedCards] = useState<Record<number, boolean>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadStudyData = useCallback(async () => {
    try {
      const res = await apiRequest<{ studySets: StudySet[]; attempts: QuizAttempt[] }>('/api/study/sets');
      setStudySets(res.studySets);
      setAttempts(res.attempts);
      setActiveSet((prev) => prev || res.studySets[0] || null);
    } catch (err) {
      showToast({
        type: 'error',
        title: 'Failed to Load Study Library',
        message: getErrorMessage(err),
        dedupeKey: 'study-load-err',
      });
    }
  }, [showToast]);

  useEffect(() => {
    void loadStudyData();
  }, [loadStudyData]);

  const toggleDoc = (id: string) => {
    setSelectedDocIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleGenerate = async () => {
    const targetIds = selectedDocIds.length > 0 ? selectedDocIds : readyDocs.slice(0, 3).map((d) => d.id);
    if (targetIds.length === 0) {
      const msg = 'Please upload at least one ready document first.';
      setErrorMsg(msg);
      showToast({ type: 'warning', title: 'No Ready Documents', message: msg });
      return;
    }
    setGenerating(true);
    setErrorMsg(null);
    try {
      const res = await apiRequest<{ studySet: StudySet }>('/api/study/generate', {
        method: 'POST',
        body: JSON.stringify({
          documentIds: targetIds,
          kind,
          difficulty,
          language: 'en',
          topic: topic.trim(),
          count: 6,
        }),
      });
      setStudySets((prev) => [res.studySet, ...prev]);
      setActiveSet(res.studySet);
      setAnswers({});
      setQuizSubmitted(false);
      setFlippedCards({});
      showToast({
        type: 'success',
        title: 'Study Material Ready',
        message: `Created "${res.studySet.title}".`,
      });
    } catch (err) {
      if (err instanceof ApiConsentError) {
        onRequireConsent(err.documentIds, err.message, () => void handleGenerate());
      } else {
        const msg = getErrorMessage(err, 'Failed to generate study set');
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
          showToast({ type: 'error', title: 'Study Generation Failed', message: msg });
        }
      }
    } finally {
      setGenerating(false);
    }
  };

  const submitQuiz = async () => {
    if (!activeSet?.content.questions) return;
    const qs = activeSet.content.questions;
    let score = 0;
    const weakTopics = new Set<string>();
    qs.forEach((q, idx) => {
      if (answers[idx] === q.correctIndex) {
        score++;
      } else if (q.topic) {
        weakTopics.add(q.topic);
      }
    });
    setQuizSubmitted(true);
    try {
      await apiRequest('/api/study/attempts', {
        method: 'POST',
        body: JSON.stringify({
          studySetId: activeSet.id,
          score,
          total: qs.length,
          weakTopics: Array.from(weakTopics),
          answers: qs.map((_, idx) => answers[idx] ?? -1),
        }),
      });
      await loadStudyData();
      showToast({
        type: 'success',
        title: 'Quiz Graded',
        message: `Score: ${score}/${qs.length} (${Math.round((score / Math.max(1, qs.length)) * 100)}%).`,
      });
    } catch (err) {
      showToast({
        type: 'error',
        title: 'Could Not Save Quiz Attempt',
        message: getErrorMessage(err),
      });
    }
  };

  const handleDeleteSet = async (id: string) => {
    try {
      await apiRequest(`/api/study/sets/${id}`, { method: 'DELETE' });
      setStudySets((prev) => prev.filter((s) => s.id !== id));
      if (activeSet?.id === id) setActiveSet(null);
      showToast({ type: 'info', title: 'Study Set Deleted', message: 'Removed study set from library.' });
    } catch (err) {
      showToast({ type: 'error', title: 'Delete Failed', message: getErrorMessage(err) });
    }
  };

  const exportStudySet = async (format: 'pdf' | 'docx' | 'md' | 'txt') => {
    if (!activeSet) return;
    const c = activeSet.content;
    let body = '';
    if (c.questions) {
      body = c.questions
        .map(
          (q, i) =>
            `${i + 1}. ${q.question}\n${q.options.map((o, oi) => `   ${String.fromCharCode(65 + oi)}) ${o}`).join('\n')}\nAnswer: ${q.options[q.correctIndex]}\nExplanation: ${q.explanation}`
        )
        .join('\n\n');
    } else if (c.cards) {
      body = c.cards.map((card, i) => `${i + 1}. [${card.topic}]\nFront: ${card.front}\nBack: ${card.back}`).join('\n\n');
    } else if (c.items) {
      body = c.items
        .map((it, i) => `${i + 1}. ${it.question}\nModel Answer: ${it.modelAnswer}\nKey Points: ${it.keyPoints.join('; ')}`)
        .join('\n\n');
    } else {
      body =
        c.markdownNotes ||
        (c.sections || []).map((s) => `## ${s.heading}\n${s.summary}\n${s.bulletPoints.map((b) => `- ${b}`).join('\n')}`).join('\n\n');
    }
    try {
      await downloadExportFile({
        title: activeSet.title,
        content: body || activeSet.title,
        format,
        sourceType: 'study_set',
      });
      showToast({
        type: 'success',
        title: 'Export Ready',
        message: `Exported study set as ${format.toUpperCase()}.`,
      });
    } catch (err) {
      showToast({ type: 'error', title: 'Export Failed', message: getErrorMessage(err) });
    }
  };

  const weakTopicCounts = new Map<string, number>();
  for (const att of attempts) {
    for (const wt of att.weakTopics || []) {
      weakTopicCounts.set(wt, (weakTopicCounts.get(wt) || 0) + 1);
    }
  }
  const topWeakTopics = Array.from(weakTopicCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="border-b border-slate-200 pb-4 dark:border-slate-800">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          AI Study Assistant
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Generate practice quizzes, flashcards, revision notes, and track weak topics.
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-4">
          <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            Source Documents ({selectedDocIds.length === 0 ? `Auto (${Math.min(3, readyDocs.length)} ready)` : `${selectedDocIds.length} selected`})
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {readyDocs.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => toggleDoc(d.id)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                  selectedDocIds.includes(d.id)
                    ? 'border-slate-900 bg-slate-900 text-white dark:border-blue-500 dark:bg-blue-600'
                    : 'border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300'
                }`}
              >
                {d.title}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">Material Type</label>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950"
            >
              <option value="mcq">Multiple-Choice Quiz</option>
              <option value="flashcards">Flashcards</option>
              <option value="short_answer">Short-Answer Questions</option>
              <option value="long_answer">Long-Answer Questions</option>
              <option value="revision_notes">Revision Notes</option>
              <option value="chapter_notes">Chapter-Wise Notes</option>
              <option value="study_plan">Personalized Study Plan</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">Difficulty</label>
            <select
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value as typeof difficulty)}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950"
            >
              <option value="beginner">Beginner</option>
              <option value="intermediate">Intermediate</option>
              <option value="advanced">Advanced</option>
              <option value="exam">Exam Level</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">Focus Topic (Optional)</label>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g., Chapter 2, Key Findings"
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950"
            />
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={generating}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-950 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600"
          >
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GraduationCap className="h-4 w-4" />}
            {generating ? 'Generating...' : 'Generate Study Material'}
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
          {errorMsg}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Study Library</h2>
            <div className="mt-3 max-h-72 space-y-1.5 overflow-y-auto">
              {studySets.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-400">No study sets generated yet.</p>
              ) : (
                studySets.map((s) => (
                  <div
                    key={s.id}
                    className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs ${
                      activeSet?.id === s.id
                        ? 'bg-slate-100 font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                        : 'text-slate-600 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setActiveSet(s);
                        setAnswers({});
                        setQuizSubmitted(false);
                        setFlippedCards({});
                      }}
                      className="min-w-0 flex-1 truncate text-left"
                    >
                      <div>{s.title}</div>
                      <div className="font-mono text-[11px] text-slate-400">
                        {s.kind} · {s.difficulty}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteSet(s.id)}
                      className="p-1 text-slate-400 hover:text-red-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center gap-2">
              <Award className="h-4 w-4 text-slate-700 dark:text-blue-400" />
              <h2 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Performance & Weak Topics</h2>
            </div>
            {attempts.length === 0 ? (
              <p className="mt-2 text-xs text-slate-400">Complete a practice quiz to track scores and weak topics.</p>
            ) : (
              <div className="mt-3 space-y-3">
                <div className="space-y-1">
                  {attempts.slice(0, 4).map((a) => (
                    <div key={a.id} className="flex justify-between font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300">
                      <span>{new Date(a.created_at).toLocaleDateString()}</span>
                      <span>
                        {a.score}/{a.total} ({Math.round((a.score / Math.max(1, a.total)) * 100)}%)
                      </span>
                    </div>
                  ))}
                </div>
                {topWeakTopics.length > 0 && (
                  <div className="border-t border-slate-100 pt-2.5 dark:border-slate-800">
                    <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">Focus Areas to Review</p>
                    <ul className="mt-1 space-y-1 text-xs text-slate-600 dark:text-slate-400">
                      {topWeakTopics.map(([wt, count]) => (
                        <li key={wt} className="flex justify-between">
                          <span className="truncate">{wt}</span>
                          <span className="font-mono text-[11px]">{count} miss{count > 1 ? 'es' : ''}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-8 dark:border-slate-800 dark:bg-slate-900">
          {!activeSet ? (
            <div className="flex h-72 flex-col items-center justify-center text-center">
              <BookOpen className="h-8 w-8 text-slate-300 dark:text-slate-600" />
              <p className="mt-3 text-xs text-slate-500">Generate or select a study set to begin practicing.</p>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4 dark:border-slate-800">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{activeSet.title}</h3>
                  <p className="font-mono text-xs text-slate-500">
                    {activeSet.kind} · {activeSet.difficulty}
                  </p>
                </div>
                <div className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 dark:border-slate-700">
                  <Download className="h-3.5 w-3.5 text-slate-500" />
                  {(['pdf', 'docx', 'md', 'txt'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => void exportStudySet(fmt)}
                      className="rounded px-1.5 py-0.5 font-mono text-[11px] uppercase text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                      {fmt}
                    </button>
                  ))}
                </div>
              </div>

              {activeSet.content.questions && (
                <div className="space-y-5">
                  {activeSet.content.questions.map((q, qIdx) => {
                    const selected = answers[qIdx];
                    const isCorrect = selected === q.correctIndex;
                    return (
                      <div key={qIdx} className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                          {qIdx + 1}. {q.question}
                        </p>
                        <div className="mt-3 space-y-2">
                          {q.options.map((opt, oIdx) => {
                            const picked = selected === oIdx;
                            let borderClass = 'border-slate-200 dark:border-slate-700';
                            if (quizSubmitted) {
                              if (oIdx === q.correctIndex) {
                                borderClass = 'border-emerald-500 bg-emerald-50/70 dark:bg-emerald-950/30';
                              } else if (picked) {
                                borderClass = 'border-red-500 bg-red-50/70 dark:bg-red-950/30';
                              }
                            } else if (picked) {
                              borderClass = 'border-slate-900 bg-slate-50 dark:border-blue-500 dark:bg-blue-950/40';
                            }
                            return (
                              <button
                                key={oIdx}
                                type="button"
                                disabled={quizSubmitted}
                                onClick={() => setAnswers((prev) => ({ ...prev, [qIdx]: oIdx }))}
                                className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs ${borderClass}`}
                              >
                                <span className="text-slate-800 dark:text-slate-200">{opt}</span>
                                {quizSubmitted && oIdx === q.correctIndex && (
                                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                )}
                                {quizSubmitted && picked && oIdx !== q.correctIndex && (
                                  <XCircle className="h-4 w-4 text-red-600" />
                                )}
                              </button>
                            );
                          })}
                        </div>
                        {quizSubmitted && (
                          <div className="mt-3 rounded-md bg-slate-50 p-2.5 text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-300">
                            <span className={isCorrect ? 'font-semibold text-emerald-700' : 'font-semibold text-red-700'}>
                              {isCorrect ? 'Correct' : 'Review'} ({q.topic}):{' '}
                            </span>
                            {q.explanation}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <div className="flex items-center justify-between pt-2">
                    {quizSubmitted ? (
                      <div className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                        Score:{' '}
                        {activeSet.content.questions.filter((q, i) => answers[i] === q.correctIndex).length} /{' '}
                        {activeSet.content.questions.length}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-500">Select answers and submit to grade.</span>
                    )}
                    <button
                      type="button"
                      onClick={() => void submitQuiz()}
                      disabled={quizSubmitted}
                      className="rounded-lg bg-slate-950 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600"
                    >
                      {quizSubmitted ? 'Submitted' : 'Submit Quiz'}
                    </button>
                  </div>
                </div>
              )}

              {activeSet.content.cards && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {activeSet.content.cards.map((card, idx) => {
                    const flipped = Boolean(flippedCards[idx]);
                    return (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setFlippedCards((prev) => ({ ...prev, [idx]: !flipped }))}
                        className="flex min-h-[160px] flex-col justify-between rounded-xl border border-slate-200 bg-slate-50 p-4 text-left transition-colors hover:border-slate-900 dark:border-slate-700 dark:bg-slate-950"
                      >
                        <div className="flex items-center justify-between font-mono text-[11px] text-slate-400">
                          <span>{flipped ? 'ANSWER' : 'PROMPT'} · {card.topic}</span>
                          <RotateCw className="h-3.5 w-3.5" />
                        </div>
                        <p className="my-3 text-sm font-medium leading-relaxed text-slate-900 dark:text-slate-100">
                          {flipped ? card.back : card.front}
                        </p>
                        <span className="text-[11px] text-slate-500">Click to flip</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {activeSet.content.items && (
                <div className="space-y-4">
                  {activeSet.content.items.map((item, idx) => (
                    <details key={idx} className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                      <summary className="cursor-pointer text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {idx + 1}. {item.question}
                      </summary>
                      <div className="mt-3 space-y-2 border-t border-slate-100 pt-3 text-xs leading-relaxed text-slate-700 dark:border-slate-800 dark:text-slate-300">
                        <p className="whitespace-pre-wrap">{item.modelAnswer}</p>
                        {item.keyPoints?.length > 0 && (
                          <ul className="list-disc pl-5 text-slate-600 dark:text-slate-400">
                            {item.keyPoints.map((kp, kIdx) => (
                              <li key={kIdx}>{kp}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              )}

              {(activeSet.content.markdownNotes || activeSet.content.sections) && (
                <div className="space-y-4">
                  {activeSet.content.markdownNotes && (
                    <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                      {activeSet.content.markdownNotes}
                    </div>
                  )}
                  {activeSet.content.sections?.map((sec, idx) => (
                    <div key={idx} className="border-b border-slate-100 pb-4 dark:border-slate-800">
                      <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{sec.heading}</h4>
                      <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-400">{sec.summary}</p>
                      {sec.bulletPoints?.length > 0 && (
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-700 dark:text-slate-300">
                          {sec.bulletPoints.map((bp, bIdx) => (
                            <li key={bIdx}>{bp}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
