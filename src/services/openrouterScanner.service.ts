import axios from 'axios';
import { env } from '../config/env.js';

export type ScannerContentType = 'tv' | 'ova' | 'ona' | 'special' | 'movie' | 'unknown';

export interface OpenRouterScanGuess {
  title: string | null;
  season: number | null;
  episode: number | null;
  contentType: ScannerContentType;
  confidence: number;
  reason?: string;
}

export interface OpenRouterScanInput {
  relativePath: string;
  siblingFileNames: string[];
  deterministicGuess?: {
    title?: string;
    season?: number;
    episode?: number;
    contentType?: string;
  } | null;
}

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

let hasWarnedMissingOpenRouterKey = false;

const SCAN_GUESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: ['string', 'null'] },
    season: { type: ['integer', 'null'], minimum: 0 },
    episode: { type: ['integer', 'null'], minimum: 0 },
    contentType: { type: 'string', enum: ['tv', 'ova', 'ona', 'special', 'movie', 'unknown'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
  },
  required: ['title', 'season', 'episode', 'contentType', 'confidence', 'reason'],
};

function clampConfidence(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeContentType(value: unknown): ScannerContentType {
  const normalized = String(value ?? '').toLowerCase();
  if (['tv', 'ova', 'ona', 'special', 'movie'].includes(normalized)) {
    return normalized as ScannerContentType;
  }
  return 'unknown';
}

function toNullablePositiveInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function parseOpenRouterJson(content: string): any | null {
  try {
    return JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
}

function buildPrompt(input: OpenRouterScanInput): string {
  const siblings = input.siblingFileNames.slice(0, 40);
  return JSON.stringify({
    task: 'Identify anime library scan metadata from a noisy release path.',
    instructions: [
      'Return only the actual anime title, season number, episode number, and content type.',
      'Ignore release group, resolution, codec, audio, subtitles, bit depth, source, and hash tokens.',
      'Use folder context and sibling filenames when the current filename is ambiguous.',
      'Use season 0 for specials/OVA/ONA/movie only when the file is clearly outside the normal TV season.',
      'If the episode cannot be inferred, set episode to null and lower confidence.',
      'Do not invent a title if the path is too ambiguous.',
    ],
    relativePath: input.relativePath,
    siblingFileNames: siblings,
    deterministicGuess: input.deterministicGuess ?? null,
  });
}

export async function inferAnimeScanWithOpenRouter(input: OpenRouterScanInput): Promise<OpenRouterScanGuess | null> {
  if (!env.OPENROUTER_ENABLED) return null;

  if (!env.OPENROUTER_API_KEY) {
    if (!hasWarnedMissingOpenRouterKey) {
      hasWarnedMissingOpenRouterKey = true;
      console.warn('[OpenRouter] OPENROUTER_API_KEY is not set; skipping scanner LLM fallback.');
    }
    return null;
  }

  try {
    const { data } = await axios.post<OpenRouterResponse>(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: env.OPENROUTER_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a strict anime file scanner. You extract structured metadata from noisy anime release paths. Return JSON that matches the schema.',
          },
          { role: 'user', content: buildPrompt(input) },
        ],
        temperature: 0,
        max_tokens: 250,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'anime_scan_guess',
            strict: true,
            schema: SCAN_GUESS_SCHEMA,
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          ...(env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': env.OPENROUTER_SITE_URL } : {}),
          ...(env.OPENROUTER_APP_NAME ? { 'X-Title': env.OPENROUTER_APP_NAME } : {}),
        },
        timeout: env.OPENROUTER_TIMEOUT_MS,
      }
    );

    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = parseOpenRouterJson(content);
    if (!parsed) return null;

    return {
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null,
      season: toNullablePositiveInt(parsed.season),
      episode: toNullablePositiveInt(parsed.episode),
      contentType: normalizeContentType(parsed.contentType),
      confidence: clampConfidence(parsed.confidence),
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    };
  } catch (err: any) {
    const status = err?.response?.status;
    const message = err?.response?.data?.error?.message ?? err?.message ?? 'unknown error';
    console.warn(`[OpenRouter] Scanner inference failed${status ? ` (HTTP ${status})` : ''}: ${message}`);
    return null;
  }
}
