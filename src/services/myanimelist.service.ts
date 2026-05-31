import axios from 'axios';
import { env } from '../config/env.js';

const MYANIMELIST_API = 'https://api.myanimelist.net/v2';
const MYANIMELIST_REQUEST_TIMEOUT_MS = 8000;
const MYANIMELIST_MAX_ATTEMPTS = 2;
const MYANIMELIST_FIELDS = [
  'id',
  'title',
  'main_picture',
  'alternative_titles',
  'synopsis',
  'mean',
  'num_episodes',
  'status',
  'start_season',
  'genres',
  'studios',
].join(',');
let hasWarnedMissingClientId = false;

export interface MyAnimeListAnime {
  id: number;
  title: string;
  main_picture?: { medium?: string; large?: string };
  alternative_titles?: {
    synonyms?: string[];
    en?: string;
    ja?: string;
  };
  synopsis?: string;
  mean?: number;
  num_episodes?: number;
  status?: string;
  start_season?: { year?: number; season?: string };
  genres?: Array<{ id: number; name: string }>;
  studios?: Array<{ id: number; name: string }>;
}

type MyAnimeListSearchResponse = {
  data?: Array<{ node?: MyAnimeListAnime }>;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientMyAnimeListError(err: any): boolean {
  const status = err?.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;

  const code = String(err?.code ?? '').toUpperCase();
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET';
}

function getMyAnimeListErrorSummary(err: any): string {
  const status = err?.response?.status;
  const apiMessage = err?.response?.data?.message ?? err?.response?.data?.error;
  if (status && apiMessage) return `HTTP ${status} (${apiMessage})`;
  if (status) return `HTTP ${status}`;
  return err?.message ?? 'unknown error';
}

/** Fetch MyAnimeList metadata for an anime title. Requires MYANIMELIST_CLIENT_ID. */
export async function fetchMyAnimeListMeta(title: string): Promise<MyAnimeListAnime | null> {
  if (!env.MYANIMELIST_ENABLED) return null;

  if (!env.MYANIMELIST_CLIENT_ID) {
    if (!hasWarnedMissingClientId) {
      hasWarnedMissingClientId = true;
      console.warn('[MyAnimeList] MYANIMELIST_CLIENT_ID is not set; skipping MAL metadata fallback.');
    }
    return null;
  }

  for (let attempt = 1; attempt <= MYANIMELIST_MAX_ATTEMPTS; attempt++) {
    try {
      const { data } = await axios.get<MyAnimeListSearchResponse>(`${MYANIMELIST_API}/anime`, {
        headers: {
          Accept: 'application/json',
          'X-MAL-CLIENT-ID': env.MYANIMELIST_CLIENT_ID,
        },
        params: {
          q: title,
          limit: 1,
          nsfw: true,
          fields: MYANIMELIST_FIELDS,
        },
        timeout: MYANIMELIST_REQUEST_TIMEOUT_MS,
      });

      return data?.data?.[0]?.node ?? null;
    } catch (err: any) {
      const transient = isTransientMyAnimeListError(err);
      const shouldRetry = transient && attempt < MYANIMELIST_MAX_ATTEMPTS;

      if (shouldRetry) {
        const backoffMs = 500 * Math.pow(2, attempt - 1);
        await sleep(backoffMs);
        continue;
      }

      console.warn(
        `[MyAnimeList] Failed to fetch metadata for "${title}" after ${attempt} attempt(s): ${getMyAnimeListErrorSummary(err)}`
      );
      return null;
    }
  }

  return null;
}
