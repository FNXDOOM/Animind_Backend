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

  const payload = JSON.stringify({ query, variables: variables ?? {} });

  try {
    // AniList may reject requests that don't look like they come from a
    // browser. Include Origin / Referer so Cloudflare's bot-protection
    // (which sits in front of graphql.anilist.co) lets us through.
    const upstream = await fetch(ANILIST_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://anilist.co',
        'Referer': 'https://anilist.co/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      body: payload,
    });

    const contentType = upstream.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json')
      ? await upstream.json()
      : await upstream.text();

    if (!upstream.ok) {
      console.warn(
        `[anilist-proxy] AniList returned ${upstream.status}:`,
        JSON.stringify(body).slice(0, 500),
      );
    }

    res.status(upstream.status).json(body);
  } catch (error: unknown) {
    console.error('[anilist-proxy] Upstream request failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(502).json({ error: `AniList proxy error: ${message}` });
  }
}
