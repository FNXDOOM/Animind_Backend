import { Request, Response, NextFunction } from 'express';
import { createClerkClient } from '@clerk/backend';
import { env } from '../config/env.js';

// Clerk backend client — verifies tokens using Clerk's own JWKS endpoint
// No custom signing key needed. Clerk handles key rotation automatically.
const clerk = createClerkClient({
  secretKey: env.CLERK_SECRET_KEY,
});

export interface AuthRequest extends Request {
  userId?: string;
  isAdmin?: boolean;
}

/**
 * Verifies the Authorization: Bearer <token> header using Clerk's backend SDK.
 * Clerk automatically fetches and caches the JWKS from its own endpoint —
 * no manual key configuration required.
 *
 * Attaches req.userId (Clerk user ID) and req.isAdmin.
 */
export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined;

  if (!token) {
    res.status(401).json({ error: 'Missing or invalid authorization token.' });
    return;
  }

  try {
    // verifyToken uses Clerk's JWKS endpoint automatically via the secret key
    const payload = await clerk.verifyToken(token);
    if (!payload?.sub) {
      res.status(401).json({ error: 'Invalid or expired token.' });
      return;
    }

    req.userId = payload.sub;

    // Read isAdmin from Clerk publicMetadata
    const user = await clerk.users.getUser(payload.sub);
    req.isAdmin = (user.publicMetadata as { isAdmin?: boolean })?.isAdmin === true;

    next();
  } catch (err) {
    console.error('[requireAuth] Token verification failed:', err);
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.isAdmin) {
    res.status(403).json({ error: 'Admin access required.' });
    return;
  }
  next();
}
