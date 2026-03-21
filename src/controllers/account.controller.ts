import { Response } from 'express';
import { supabase } from '../config/db.js';
import { AuthRequest } from '../middleware/auth.middleware.js';

/** DELETE /api/account — delete the currently authenticated user account */
export async function deleteMyAccount(req: AuthRequest, res: Response) {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  const { error } = await supabase.auth.admin.deleteUser(userId, true);
  if (error) {
    res.status(500).json({ error: `Failed to delete account: ${error.message}` });
    return;
  }

  res.json({ success: true });
}
