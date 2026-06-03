import type { Request, Response } from 'express';

const ANILIST_API_URL = 'https://graphql.anilist.co';
const MAX_GRAPHQL_QUERY_LENGTH = 10_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeGraphqlQuery(query: string): string | null {
  const normalized = query.trim();
  if (!normalized || normalized.length > MAX_GRAPHQL_QUERY_LENGTH) {
    return null;
  }

  const withoutComments = normalized
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n')
    .trimStart();

  if (/^(mutation|subscription)\b/i.test(withoutComments)) {
    return null;
  }

  if (/\b(mutation|subscription)\b/i.test(withoutComments)) {
    return null;
  }

  return normalized;
}

/**
 * POST /api/anilist
 * Proxies GraphQL requests to AniList to avoid browser CORS restrictions.
 * Expects { query: string, variables?: object } in the request body.
 */
export async function proxyAnilist(req: Request, res: Response): Promise<void> {
  const { query, variables } = req.body;

  if (!query || typeof query !== 'string') {
    res.status(400).json({ error: 'Missing or invalid "query" field.' });
    return;
  }

  const safeQuery = normalizeGraphqlQuery(query);
  if (!safeQuery) {
    res.status(400).json({ error: 'Only read-only AniList GraphQL queries are allowed.' });
    return;
  }

  if (variables !== undefined && !isPlainRecord(variables)) {
    res.status(400).json({ error: 'Invalid "variables" field.' });
    return;
  }

  try {
    const upstream = await fetch(ANILIST_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'AniMind/1.0 (https://fnxdoom.in)',
      },
      body: JSON.stringify({ query: safeQuery, variables: variables ?? {} }),
    });

    const contentType = upstream.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json')
      ? await upstream.json()
      : await upstream.text();

    if (!upstream.ok) {
      console.warn(`[anilist-proxy] AniList returned ${upstream.status}:`, JSON.stringify(body).slice(0, 300));
    }

    res.status(upstream.status).json(body);
  } catch (error: unknown) {
    console.error('[anilist-proxy] Upstream request failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(502).json({ error: `AniList proxy error: ${message}` });
  }
}
