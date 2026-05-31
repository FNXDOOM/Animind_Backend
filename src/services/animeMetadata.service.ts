import { fetchAniListMeta } from './anilist.service.js';
import { fetchMyAnimeListMeta } from './myanimelist.service.js';

export interface AnimeMetadata {
  source: 'anilist' | 'myanimelist';
  id: number;
  title: string;
  synopsis: string | null;
  coverImageUrl: string | null;
  genres: string[];
  rating: number | null;
  episodeCount: number | null;
  studio: string | null;
  status: string | null;
  year: string | null;
  anilistId: number | null;
  trailer: { id: string; site: string; thumbnail: string | null } | null;
}

const metadataCache = new Map<string, AnimeMetadata | null>();
const inFlightMetadata = new Map<string, Promise<AnimeMetadata | null>>();

function normalizeCacheKey(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(text: string | null | undefined): string | null {
  return text?.replace(/<[^>]+>/g, '') ?? null;
}

async function fetchAnimeMetaUncached(title: string): Promise<AnimeMetadata | null> {
  const aniListMeta = await fetchAniListMeta(title);

  if (aniListMeta) {
    return {
      source: 'anilist',
      id: aniListMeta.id,
      title: aniListMeta.title?.english ?? aniListMeta.title?.romaji ?? title,
      synopsis: stripHtml(aniListMeta.description),
      coverImageUrl: aniListMeta.coverImage?.large ?? aniListMeta.coverImage?.medium ?? null,
      anilistId: aniListMeta.id,
      genres: aniListMeta.genres ?? [],
      rating: aniListMeta.averageScore ? aniListMeta.averageScore / 10 : null,
      episodeCount: aniListMeta.episodes ?? null,
      studio: aniListMeta.studios?.nodes?.[0]?.name ?? null,
      status: aniListMeta.status ?? null,
      year: aniListMeta.seasonYear?.toString() ?? null,
      trailer: aniListMeta.trailer
        ? {
            id: aniListMeta.trailer.id,
            site: aniListMeta.trailer.site,
            thumbnail: aniListMeta.trailer.thumbnail ?? null,
          }
        : null,
    };
  }

  const myAnimeListMeta = await fetchMyAnimeListMeta(title);

  if (myAnimeListMeta) {
    return {
      source: 'myanimelist',
      id: myAnimeListMeta.id,
      title: myAnimeListMeta.alternative_titles?.en ?? myAnimeListMeta.title ?? title,
      synopsis: myAnimeListMeta.synopsis ?? null,
      coverImageUrl: myAnimeListMeta.main_picture?.large ?? myAnimeListMeta.main_picture?.medium ?? null,
      anilistId: null,
      genres: myAnimeListMeta.genres?.map(genre => genre.name).filter(Boolean) ?? [],
      rating: myAnimeListMeta.mean ?? null,
      episodeCount: myAnimeListMeta.num_episodes ?? null,
      studio: myAnimeListMeta.studios?.[0]?.name ?? null,
      status: myAnimeListMeta.status ?? null,
      year: myAnimeListMeta.start_season?.year?.toString() ?? null,
      trailer: null,
    };
  }

  return null;
}

export async function fetchAnimeMeta(title: string): Promise<AnimeMetadata | null> {
  const cacheKey = normalizeCacheKey(title);
  if (!cacheKey) return null;
  if (metadataCache.has(cacheKey)) return metadataCache.get(cacheKey) ?? null;

  const existingFetch = inFlightMetadata.get(cacheKey);
  if (existingFetch) return existingFetch;

  const fetchPromise = fetchAnimeMetaUncached(title)
    .then(meta => {
      metadataCache.set(cacheKey, meta);
      return meta;
    })
    .finally(() => {
      inFlightMetadata.delete(cacheKey);
    });

  inFlightMetadata.set(cacheKey, fetchPromise);
  return fetchPromise;
}
