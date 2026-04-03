import { GoogleGenAI } from "@google/genai";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const project = requiredEnv("GOOGLE_CLOUD_PROJECT");
const location = process.env.GOOGLE_CLOUD_LOCATION || "global";

export const genAI = new GoogleGenAI({
  vertexai: true,
  project,
  location,
});

const EMBEDDING_CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes
const EMBEDDING_CACHE_MAX = 500;

const embeddingCache = new Map<
  string,
  {
    values: number[];
    expiresAt: number;
    lastAccessedAt: number;
  }
>();

function normalizeQuery(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

function evictExpiredEmbeddingEntries(now: number) {
  for (const [key, value] of embeddingCache.entries()) {
    if (value.expiresAt <= now) {
      embeddingCache.delete(key);
    }
  }
}

function evictLeastRecentlyUsedEmbeddingEntry() {
  let oldestKey: string | null = null;
  let oldestAccess = Number.POSITIVE_INFINITY;

  for (const [key, value] of embeddingCache.entries()) {
    if (value.lastAccessedAt < oldestAccess) {
      oldestAccess = value.lastAccessedAt;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    embeddingCache.delete(oldestKey);
  }
}

export async function embedQuery(text: string): Promise<number[]> {
  const key = normalizeQuery(text);
  const now = Date.now();

  evictExpiredEmbeddingEntries(now);

  const cached = embeddingCache.get(key);
  if (cached && cached.expiresAt > now) {
    cached.lastAccessedAt = now;
    return cached.values;
  }

  const response = await genAI.models.embedContent({
    model: "gemini-embedding-001",
    contents: [key],
    config: {
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: 768,
    },
  });

  const values = response.embeddings?.[0]?.values;
  if (!values || !Array.isArray(values) || values.length === 0) {
    throw new Error("Failed to generate query embedding.");
  }

  embeddingCache.set(key, {
    values,
    expiresAt: now + EMBEDDING_CACHE_TTL_MS,
    lastAccessedAt: now,
  });

  if (embeddingCache.size > EMBEDDING_CACHE_MAX) {
    evictLeastRecentlyUsedEmbeddingEntry();
  }

  return values;
}
