import axios from 'axios';
import { env } from '../config/env.js';

const ANILIST_API = 'https://graphql.anilist.co';

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

/** Fetch AniList metadata for an anime title. Returns null if not found or AniList disabled. */
export async function fetchAniListMeta(title: string): Promise<AniListMedia | null> {
  if (!env.ANILIST_ENABLED) return null;

  try {
    const { data } = await axios.post(
      ANILIST_API,
      { query: MEDIA_QUERY, variables: { search: title } },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 8000 }
    );

    return data?.data?.Media ?? null;
  } catch (err: any) {
    console.warn(`[AniList] Failed to fetch metadata for "${title}":`, err.message);
    return null;
  }
}
