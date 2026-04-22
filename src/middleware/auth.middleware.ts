import { Request, Response, NextFunction } from 'express';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { env } from '../config/env.js';

// Clerk client — used to fetch user metadata (isAdmin) after token verification
const clerk = createClerkClient({
  secretKey: env.CLERK_SECRET_KEY,
});

export interface AuthRequest extends Request {
  userId?: string;
  isAdmin?: boolean;
}

/**
 * Verifies the Authorization: Bearer <token> header using Clerk.
 * Uses standalone verifyToken() which is the correct API in @clerk/backend v3+.
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
    // verifyToken is a standalone function in @clerk/backend v3+
    const payload = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
    });

    if (!payload?.sub) {
      res.status(401).json({ error: 'Invalid or expired token.' });
      return;
    }

    req.userId = payload.sub;

    // Fetch user to check isAdmin from publicMetadata
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
