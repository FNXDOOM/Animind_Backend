import { Request, Response } from 'express';
import { supabase } from '../config/db.js';
import { runScan } from '../services/scanner.service.js';

/** GET /api/admin/users — list all profiles (admin only) */
export async function listUsers(req: Request, res: Response) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, avatar_url, is_admin, updated_at, created_at')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    res.status(500).json({ error: 'Failed to fetch users.' });
    return;
  }

  res.json(data ?? []);
}

/** PATCH /api/admin/users/:id — toggle admin flag */
export async function setAdminStatus(req: Request, res: Response) {
  const { id } = req.params;
  const { is_admin } = req.body as { is_admin: boolean };

  const { error } = await supabase
    .from('profiles')
    .update({ is_admin })
    .eq('id', id);

  if (error) {
    res.status(500).json({ error: 'Failed to update user.' });
    return;
  }

  res.json({ success: true });
}

/** DELETE /api/admin/shows/:id — remove a show and its episodes */
export async function deleteShow(req: Request, res: Response) {
  const { id } = req.params;
  const { error } = await supabase.from('shows').delete().eq('id', id);
  if (error) {
    res.status(500).json({ error: 'Failed to delete show.' });
    return;
  }
  res.json({ success: true });
}

/** GET /api/admin/scan-status — run a scan and return the result */
export async function triggerAdminScan(req: Request, res: Response) {
  try {
    const result = await runScan();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
