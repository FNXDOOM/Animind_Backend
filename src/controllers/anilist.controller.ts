import type { Request, Response } from 'express';

const ANILIST_API_URL = 'https://graphql.anilist.co';

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

  try {
    const upstream = await fetch(ANILIST_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });

    const contentType = upstream.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json')
      ? await upstream.json()
      : await upstream.text();

    res.status(upstream.status).json(body);
  } catch (error: unknown) {
    console.error('[anilist-proxy] Upstream request failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(502).json({ error: `AniList proxy error: ${message}` });
  }
}
