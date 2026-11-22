export type NavSection =
  | 'studio'
  | 'upload'
  | 'documents'
  | 'research'
  | 'study'
  | 'settings';

export type UILanguage = 'en' | 'ne';
export type AIOutputLanguage = 'auto' | 'en' | 'ne' | 'bilingual';
export type AIMode = 'automatic' | 'online' | 'offline';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  isGuest: boolean;
  role: string;
  uiLanguage: UILanguage;
  aiOutputLanguage: AIOutputLanguage;
  aiMode: AIMode;
  ollamaUrl: string;
  ollamaModel: string;
  cloudConsentDefault: boolean;
  chunkSize: number;
  chunkOverlap: number;
  storageQuotaBytes: number;
  createdAt: string;
}

export interface AIStatus {
  aiMode: AIMode;
  cloudConsentDefault: boolean;
  billingMode?: 'direct_gemini_api';
  online: {
    provider: string;
    configured: boolean;
    textModel: string;
    embeddingModel: string;
  };
  offline: {
    available: boolean;
    url: string;
    models: string[];
    error?: string;
  };
  usageSummary?: {
    totalRequests: number;
    promptTokens: number;
    outputTokens: number;
    totalTokens: number;
    quotaHits: number;
  };
}

export interface FolderItem {
  id: string;
  name: string;
  color: string;
  document_count: number;
  created_at: string;
}

export interface DocumentItem {
  id: string;
  folder_id: string | null;
  title: string;
  original_filename: string;
  mime_type: string;
  file_ext: string;
  file_size: number;
  sha256: string;
  detected_language: 'en' | 'ne' | 'mixed';
  page_count: number;
  status: 'pending' | 'processing' | 'ready' | 'ocr_failed' | 'error';
  ocr_status: 'not_needed' | 'pending' | 'completed' | 'failed';
  ocr_error: string | null;
  cloud_consented: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExtractedPage {
  pageNumber: number;
  text: string;
}

export interface ExtractedTable {
  title: string;
  pageNumber: number;
  headers: string[];
  rows: string[][];
}

export interface DocumentAnalysis {
  summary?: string;
  classification?: string;
  keyPoints?: string[];
  topics?: string[];
  keywords?: string[];
  definitions?: Array<{ term: string; definition: string }>;
  namedEntities?: string[];
  datesAndNumbers?: string[];
  outline?: Array<{ heading: string; summary: string }>;
  chapterSummaries?: Array<{ section: string; summary: string }>;
}

export interface DocumentDetail extends DocumentItem {
  extracted_text: string;
  pages: ExtractedPage[];
  tables: ExtractedTable[];
  metadata: Record<string, unknown>;
  analysis: DocumentAnalysis;
}

export interface RetrievedPassage {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  pageNumber: number;
  chunkIndex: number;
  excerpt: string;
  similarityScore: number;
  matchType: 'hybrid' | 'semantic' | 'keyword';
}

export interface Conversation {
  id: string;
  title: string;
  chat_type: 'document' | 'general';
  documentIds: string[];
  language: AIOutputLanguage;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: RetrievedPassage[];
  provider_used?: string | null;
  mode_notice?: string | null;
  created_at: string;
}

export interface StudySet {
  id: string;
  title: string;
  documentIds: string[];
  kind: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced' | 'exam';
  language: string;
  content: {
    title?: string;
    questions?: Array<{
      question: string;
      options: string[];
      correctIndex: number;
      explanation: string;
      topic: string;
    }>;
    cards?: Array<{
      front: string;
      back: string;
      topic: string;
    }>;
    items?: Array<{
      question: string;
      modelAnswer: string;
      keyPoints: string[];
      topic: string;
    }>;
    markdownNotes?: string;
    sections?: Array<{
      heading: string;
      summary: string;
      bulletPoints: string[];
    }>;
  };
  created_at: string;
}

export interface QuizAttempt {
  id: string;
  study_set_id: string;
  score: number;
  total: number;
  weakTopics: string[];
  created_at: string;
}

export interface ResearchReportRecord {
  id: string;
  title: string;
  query: string;
  documentIds: string[];
  language: string;
  report: {
    title?: string;
    executiveSummary?: string;
    comparisonMatrix?: Array<{ dimension: string; findings: string }>;
    contradictions?: Array<{ topic: string; detail: string }>;
    extractedReferences?: string[];
    structuredMarkdown?: string;
    citations?: RetrievedPassage[];
  };
  created_at: string;
}

export interface DashboardSummary {
  totalDocuments: number;
  readyDocuments: number;
  processingDocuments: number;
  failedDocuments: number;
  storageUsedBytes: number;
  storageQuotaBytes: number;
  recentDocuments: DocumentItem[];
  recentQuestions: Array<{ id: string; conversation_id: string; content: string; created_at: string }>;
  recentSummaries: Array<{ documentId: string; title: string; summaryPreview: string; updatedAt: string }>;
  quizStats: { attempts: number; avgScore: number };
}

export interface AuditLogItem {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: string | null;
  created_at: string;
}

export interface ExportHistoryItem {
  id: string;
  title: string;
  format: string;
  source_type: string;
  created_at: string;
}
