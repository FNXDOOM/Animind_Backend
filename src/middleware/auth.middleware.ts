import { Request, Response, NextFunction } from 'express';
import { supabase } from '../config/db.js';

export interface AuthRequest extends Request {
  userId?: string;
  isAdmin?: boolean;
}

/**
 * Verifies the Authorization: Bearer <token> header using Supabase.
 * Attaches req.userId and req.isAdmin.
 */
export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined;

  if (!token) {
    res.status(401).json({ error: 'Missing or invalid authorization token.' });
    return;
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: 'Invalid or expired token.' });
    return;
  }

  req.userId = data.user.id;

  // Check admin status from the profiles table
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', data.user.id)
    .maybeSingle();

  req.isAdmin = profile?.is_admin ?? false;
  next();
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.isAdmin) {
    res.status(403).json({ error: 'Admin access required.' });
    return;
  }
  next();
}
