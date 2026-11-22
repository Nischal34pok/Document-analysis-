import fs from 'node:fs';
import type { UserRecord } from './auth.ts';
import { generateEmbedding, generateWithAIRouter, type InlineImagePart } from './ai.ts';
import { db } from './db.ts';

export interface RetrievedPassage {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  pageNumber: number;
  chunkIndex: number;
  excerpt: string;
  similarityScore: number; // 0..100
  matchType: 'hybrid' | 'semantic' | 'keyword';
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function sanitizeFtsTerms(query: string): string {
  const tokens = query
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 12);

  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

export async function retrieveHybridPassages(params: {
  user: UserRecord;
  query: string;
  documentIds?: string[];
  topK?: number;
  allowCloudEmbedding?: boolean;
}): Promise<RetrievedPassage[]> {
  const topK = Math.min(Math.max(params.topK ?? 6, 1), 20);

  // Resolve allowed documents strictly scoped to user_id
  let docRows: Array<{ id: string; title: string }> = [];
  if (params.documentIds && params.documentIds.length > 0) {
    const placeholders = params.documentIds.map(() => '?').join(',');
    docRows = db
      .prepare(
        `SELECT id, title FROM documents WHERE user_id = ? AND status = 'ready' AND id IN (${placeholders})`
      )
      .all(params.user.id, ...params.documentIds) as Array<{ id: string; title: string }>;
  } else {
    docRows = db
      .prepare(`SELECT id, title FROM documents WHERE user_id = ? AND status = 'ready'`)
      .all(params.user.id) as Array<{ id: string; title: string }>;
  }

  if (docRows.length === 0) return [];
  const docMap = new Map(docRows.map((d) => [d.id, d.title]));
  const allowedIds = docRows.map((d) => d.id);
  const docPlaceholders = allowedIds.map(() => '?').join(',');

  // 1. Keyword Search via SQLite FTS5
  const keywordRanks = new Map<string, number>();
  const ftsQuery = sanitizeFtsTerms(params.query);
  if (ftsQuery) {
    try {
      const ftsRows = db
        .prepare(
          `SELECT chunk_id, bm25(chunks_fts) AS rank
           FROM chunks_fts
           WHERE chunks_fts MATCH ? AND user_id = ? AND document_id IN (${docPlaceholders})
           ORDER BY rank ASC
           LIMIT 30`
        )
        .all(ftsQuery, params.user.id, ...allowedIds) as Array<{ chunk_id: string; rank: number }>;

      ftsRows.forEach((row, index) => {
        keywordRanks.set(row.chunk_id, index + 1);
      });
    } catch {
      // Ignore malformed FTS edge cases and fall back to LIKE / semantic
    }
  }

  // Fallback lexical scan if FTS returned 0 (e.g., substring Nepali/English terms)
  if (keywordRanks.size === 0) {
    const terms = params.query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .slice(0, 6);
    if (terms.length > 0) {
      const allChunks = db
        .prepare(
          `SELECT id, content FROM chunks WHERE user_id = ? AND document_id IN (${docPlaceholders}) LIMIT 400`
        )
        .all(params.user.id, ...allowedIds) as Array<{ id: string; content: string }>;

      const scored = allChunks
        .map((c) => {
          const lower = c.content.toLowerCase();
          let hits = 0;
          for (const t of terms) {
            if (lower.includes(t)) hits++;
          }
          return { id: c.id, hits };
        })
        .filter((s) => s.hits > 0)
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 20);

      scored.forEach((row, idx) => keywordRanks.set(row.id, idx + 1));
    }
  }

  // 2. Semantic Vector Search (if embeddings exist & query embedding succeeds)
  const semanticScores = new Map<string, number>();
  const semanticRanks = new Map<string, number>();

  const embedRows = db
    .prepare(
      `SELECT chunk_id, provider, dimensions, vector_json
       FROM chunk_embeddings
       WHERE document_id IN (${docPlaceholders})`
    )
    .all(...allowedIds) as Array<{
    chunk_id: string;
    provider: string;
    dimensions: number;
    vector_json: string;
  }>;

  if (embedRows.length > 0) {
    const queryEmbedding = await generateEmbedding(
      params.query,
      params.user,
      Boolean(params.allowCloudEmbedding)
    );
    if (queryEmbedding) {
      const scoredVecs: Array<{ chunkId: string; sim: number }> = [];
      for (const row of embedRows) {
        if (row.dimensions !== queryEmbedding.vector.length) continue;
        try {
          const vec = JSON.parse(row.vector_json) as number[];
          const sim = cosineSimilarity(queryEmbedding.vector, vec);
          if (sim > 0.15) {
            scoredVecs.push({ chunkId: row.chunk_id, sim });
          }
        } catch {
          // skip corrupted vector
        }
      }
      scoredVecs.sort((a, b) => b.sim - a.sim);
      scoredVecs.slice(0, 30).forEach((item, idx) => {
        semanticScores.set(item.chunkId, item.sim);
        semanticRanks.set(item.chunkId, idx + 1);
      });
    }
  }

  // 3. Reciprocal Rank Fusion (RRF) + Re-ranking
  const candidateIds = new Set<string>([...keywordRanks.keys(), ...semanticRanks.keys()]);
  if (candidateIds.size === 0) {
    // If query is broad (e.g. "summarize everything"), pull leading chunks from selected docs
    const fallbackChunks = db
      .prepare(
        `SELECT id, document_id, page_number, chunk_index, content
         FROM chunks
         WHERE user_id = ? AND document_id IN (${docPlaceholders})
         ORDER BY chunk_index ASC
         LIMIT ?`
      )
      .all(params.user.id, ...allowedIds, topK) as Array<{
      id: string;
      document_id: string;
      page_number: number;
      chunk_index: number;
      content: string;
    }>;

    return fallbackChunks.map((c) => ({
      chunkId: c.id,
      documentId: c.document_id,
      documentTitle: docMap.get(c.document_id) || 'Document',
      pageNumber: c.page_number,
      chunkIndex: c.chunk_index,
      excerpt: c.content,
      similarityScore: 45,
      matchType: 'keyword',
    }));
  }

  const RRF_K = 60;
  const fused = Array.from(candidateIds).map((chunkId) => {
    const kRank = keywordRanks.get(chunkId);
    const sRank = semanticRanks.get(chunkId);
    const rrf =
      (kRank ? 1 / (RRF_K + kRank) : 0) +
      (sRank ? 1.25 / (RRF_K + sRank) : 0);
    const cos = semanticScores.get(chunkId) ?? 0;
    const matchType: 'hybrid' | 'semantic' | 'keyword' =
      kRank && sRank ? 'hybrid' : sRank ? 'semantic' : 'keyword';

    // Calibrated display score (0-99)
    const displayScore = Math.min(
      99,
      Math.max(
        25,
        Math.round(
          sRank
            ? cos * 100
            : Math.max(35, 88 - ((kRank ?? 10) - 1) * 5)
        )
      )
    );

    return { chunkId, rrf, displayScore, matchType };
  });

  fused.sort((a, b) => b.rrf - a.rrf);
  const topIds = fused.slice(0, topK);

  const chunkPlaceholders = topIds.map(() => '?').join(',');
  const chunkRows = db
    .prepare(
      `SELECT id, document_id, page_number, chunk_index, content
       FROM chunks
       WHERE id IN (${chunkPlaceholders})`
    )
    .all(...topIds.map((t) => t.chunkId)) as Array<{
    id: string;
    document_id: string;
    page_number: number;
    chunk_index: number;
    content: string;
  }>;

  const chunkMap = new Map(chunkRows.map((c) => [c.id, c]));
  const results: RetrievedPassage[] = [];

  for (const item of topIds) {
    const c = chunkMap.get(item.chunkId);
    if (!c) continue;
    results.push({
      chunkId: c.id,
      documentId: c.document_id,
      documentTitle: docMap.get(c.document_id) || 'Document',
      pageNumber: c.page_number,
      chunkIndex: c.chunk_index,
      excerpt: c.content,
      similarityScore: item.displayScore,
      matchType: item.matchType,
    });
  }

  return results;
}

export function buildUntrustedContextBlock(passages: RetrievedPassage[]): string {
  if (passages.length === 0) return 'No document passages retrieved.';
  return passages
    .map(
      (p, i) =>
        `[Source ${i + 1} | Document: "${p.documentTitle}" | Page ${p.pageNumber} | Relevance ${p.similarityScore}%]\n<untrusted_document_content>\n${p.excerpt}\n</untrusted_document_content>`
    )
    .join('\n\n');
}

export async function answerDocumentQuestion(params: {
  user: UserRecord;
  question: string;
  documentIds?: string[];
  outputLanguage: 'auto' | 'en' | 'ne' | 'bilingual';
  history?: Array<{ role: 'user' | 'model'; text: string }>;
  inlineImages?: InlineImagePart[];
}): Promise<{
  answer: string;
  citations: RetrievedPassage[];
  providerUsed: 'gemini' | 'ollama' | 'lexical';
  modelUsed: string;
  modeNotice?: string;
}> {
  const docRows =
    params.documentIds && params.documentIds.length > 0
      ? (db
          .prepare(
            `SELECT id, cloud_consented, file_ext, file_size, storage_path FROM documents WHERE user_id = ? AND id IN (${params.documentIds.map(() => '?').join(',')})`
          )
          .all(params.user.id, ...params.documentIds) as Array<{
          id: string;
          cloud_consented: number;
          file_ext: string;
          file_size: number;
          storage_path: string;
        }>)
      : (db
          .prepare(`SELECT id, cloud_consented, file_ext, file_size, storage_path FROM documents WHERE user_id = ? AND status = 'ready'`)
          .all(params.user.id) as Array<{
          id: string;
          cloud_consented: number;
          file_ext: string;
          file_size: number;
          storage_path: string;
        }>);

  const unconsentedDocIds =
    params.user.cloud_consent_default === 1
      ? []
      : docRows.filter((d) => d.cloud_consented !== 1).map((d) => d.id);
  const documentsConsented = docRows.length === 0 || unconsentedDocIds.length === 0;

  const passages = await retrieveHybridPassages({
    user: params.user,
    query: params.question,
    documentIds: params.documentIds,
    topK: 6,
    allowCloudEmbedding: documentsConsented,
  });

  const combinedImages: InlineImagePart[] = [...(params.inlineImages || [])];
  if (params.documentIds && params.documentIds.length > 0 && documentsConsented) {
    const visionMimeMap: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
    };
    for (const d of docRows) {
      const mime = visionMimeMap[d.file_ext.toLowerCase()];
      if (mime && d.file_size <= 4 * 1024 * 1024 && combinedImages.length < 3) {
        try {
          if (fs.existsSync(d.storage_path)) {
            combinedImages.push({
              mimeType: mime,
              base64Data: fs.readFileSync(d.storage_path).toString('base64'),
            });
          }
        } catch {
          // Ignore file read fallback if OCR text is already indexed
        }
      }
    }
  }

  if (passages.length === 0 && combinedImages.length === 0) {
    const emptyMsg =
      params.outputLanguage === 'ne'
        ? 'अपलोड गरिएका कागजातहरूमा यो प्रश्नसँग मिल्ने जानकारी फेला परेन। कृपया पहिले कागजात अपलोड गर्नुहोस् वा फरक प्रश्न सोध्नुहोस्।'
        : 'I could not find relevant passages in your uploaded documents. Please upload a ready document or refine your question.';
    return {
      answer: emptyMsg,
      citations: [],
      providerUsed: 'lexical',
      modelUsed: 'sqlite-fts5',
    };
  }

  const langInstruction =
    params.outputLanguage === 'ne'
      ? 'Respond clearly in Nepali (Devanagari Unicode).'
      : params.outputLanguage === 'en'
      ? 'Respond clearly in English.'
      : params.outputLanguage === 'bilingual'
      ? 'Respond bilingually: provide the answer in English followed by a clear Nepali (Devanagari Unicode) translation.'
      : 'Respond in the same language as the user question (English or Nepali Devanagari Unicode).';

  const contextBlock = buildUntrustedContextBlock(passages);
  const prompt = [
    passages.length > 0 ? `Retrieved Document Passages:\n${contextBlock}` : '',
    `User Question: ${params.question}`,
    passages.length > 0
      ? `Cite sources inline using [Source N] matching ONLY the source numbers above. If the answer is not present in the retrieved passages or attached images, explicitly state that it could not be found in the provided documents.`
      : `Answer strictly based on the attached image(s) without inventing outside facts.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const aiRes = await generateWithAIRouter({
    user: params.user,
    prompt,
    systemInstruction: `You are DocuMind AI, an accurate multimodal document research assistant. ${langInstruction}`,
    requiresDocumentConsent: docRows.length > 0,
    documentsConsented,
    unconsentedDocIds,
    history: params.history,
    inlineImages: combinedImages,
  });

  return {
    answer: aiRes.text,
    citations: passages,
    providerUsed: aiRes.providerUsed,
    modelUsed: aiRes.modelUsed,
    modeNotice: aiRes.modeNotice,
  };
}
