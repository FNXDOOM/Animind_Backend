import type { Request, Response } from 'express';
import { verifyToken } from '@clerk/backend';
import { env } from '../config/env.js';
import {
  createDesktopSessionTokens,
  refreshDesktopSessionTokens,
  revokeDesktopSessionByRefreshToken,
  revokeDesktopSessionByAccessToken,
} from '../services/desktopAuth.service.js';

function bearerTokenFromHeader(authHeader?: string): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice('Bearer '.length).trim() || null;
}

export async function exchangeClerkForDesktopSession(req: Request, res: Response) {
  try {
    const clerkToken = bearerTokenFromHeader(req.headers.authorization);
    if (!clerkToken) {
      res.status(401).json({ error: 'Missing Clerk bearer token.' });
      return;
    }

    const payload = await verifyToken(clerkToken, { secretKey: env.CLERK_SECRET_KEY });
    const userId = payload?.sub;
    if (!userId) {
      res.status(401).json({ error: 'Invalid Clerk token.' });
      return;
    }

    const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.trim().slice(0, 128) : null;
    const deviceName = typeof req.body?.deviceName === 'string' ? req.body.deviceName.trim().slice(0, 128) : null;

    const session = await createDesktopSessionTokens({
      userId,
      deviceId,
      deviceName,
    });

    res.status(200).json({
      token_type: 'Bearer',
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
      session_id: session.sessionId,
      expires_in: session.expiresIn,
      access_token_expires_at: session.accessTokenExpiresAt,
      refresh_token_expires_at: session.refreshTokenExpiresAt,
    });
  } catch (error: any) {
    console.error('[desktop-auth.exchange] failed:', error);
    res.status(500).json({ error: error?.message ?? 'Failed to exchange Clerk token.' });
  }
}

export async function refreshDesktopSession(req: Request, res: Response) {
  try {
    const refreshToken = typeof req.body?.refresh_token === 'string' ? req.body.refresh_token.trim() : '';
    if (!refreshToken) {
      res.status(400).json({ error: 'refresh_token is required.' });
      return;
    }

    const nextSession = await refreshDesktopSessionTokens(refreshToken);
    if (!nextSession) {
      res.status(401).json({ error: 'Invalid or expired refresh token.' });
      return;
    }

    res.status(200).json({
      token_type: 'Bearer',
      access_token: nextSession.accessToken,
      refresh_token: nextSession.refreshToken,
      session_id: nextSession.sessionId,
      expires_in: nextSession.expiresIn,
      access_token_expires_at: nextSession.accessTokenExpiresAt,
      refresh_token_expires_at: nextSession.refreshTokenExpiresAt,
    });
  } catch (error: any) {
    console.error('[desktop-auth.refresh] failed:', error);
    res.status(500).json({ error: error?.message ?? 'Failed to refresh desktop session.' });
  }
}

export async function revokeDesktopSession(req: Request, res: Response) {
  try {
    const refreshToken = typeof req.body?.refresh_token === 'string' ? req.body.refresh_token.trim() : '';
    const accessToken = bearerTokenFromHeader(req.headers.authorization);

    if (!refreshToken && !accessToken) {
      res.status(400).json({ error: 'Provide refresh_token or Authorization bearer token.' });
      return;
    }

    let revoked = false;
    if (refreshToken) revoked = (await revokeDesktopSessionByRefreshToken(refreshToken)) || revoked;
    if (accessToken) revoked = (await revokeDesktopSessionByAccessToken(accessToken)) || revoked;

    if (!revoked) {
      res.status(404).json({ error: 'Desktop session not found.' });
      return;
    }

    res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('[desktop-auth.revoke] failed:', error);
    res.status(500).json({ error: error?.message ?? 'Failed to revoke desktop session.' });
  }
}
