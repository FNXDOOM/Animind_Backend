import axios from 'axios';
import { env } from '../config/env.js';

const ANILIST_API = 'https://graphql.anilist.co';
const ANILIST_REQUEST_TIMEOUT_MS = 8000;
const ANILIST_MAX_ATTEMPTS = 3;

export interface AniListMedia {
  id: number;
  title: { romaji: string; english: string | null };
  description: string | null;
  coverImage: { large: string; medium: string };
  bannerImage: string | null;
  episodes: number | null;
  genres: string[];
  averageScore: number | null;
  status: string;
  season: string | null;
  seasonYear: number | null;
  studios: { nodes: Array<{ name: string }> };
  trailer: { id: string; site: string; thumbnail: string } | null;
}

const MEDIA_QUERY = `
query ($search: String) {
  Media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
    id
    title { romaji english }
    description(asHtml: false)
    coverImage { large medium }
    bannerImage
    episodes
    genres
    averageScore
    status
    season
    seasonYear
    studios(isMain: true) { nodes { name } }
    trailer { id site thumbnail }
  }
}
`;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientAniListError(err: any): boolean {
  const status = err?.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;

  const code = String(err?.code ?? '').toUpperCase();
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET';
}

function getAniListErrorSummary(err: any): string {
  const status = err?.response?.status;
  const apiMessage = err?.response?.data?.errors?.[0]?.message;
  if (status && apiMessage) return `HTTP ${status} (${apiMessage})`;
  if (status) return `HTTP ${status}`;
  return err?.message ?? 'unknown error';
}

/** Fetch AniList metadata for an anime title. Returns null if not found or AniList disabled. */
export async function fetchAniListMeta(title: string): Promise<AniListMedia | null> {
  if (!env.ANILIST_ENABLED) return null;

  for (let attempt = 1; attempt <= ANILIST_MAX_ATTEMPTS; attempt++) {
    try {
      const { data } = await axios.post(
        ANILIST_API,
        { query: MEDIA_QUERY, variables: { search: title } },
        {
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          timeout: ANILIST_REQUEST_TIMEOUT_MS,
        }
      );

      return data?.data?.Media ?? null;
    } catch (err: any) {
      const transient = isTransientAniListError(err);
      const shouldRetry = transient && attempt < ANILIST_MAX_ATTEMPTS;

      if (shouldRetry) {
        const backoffMs = 300 * Math.pow(2, attempt - 1);
        await sleep(backoffMs);
        continue;
      }

      console.warn(
        `[AniList] Failed to fetch metadata for "${title}" after ${attempt} attempt(s): ${getAniListErrorSummary(err)}`
      );
      return null;
    }
  }

  return null;
}
