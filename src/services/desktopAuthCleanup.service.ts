import { supabase } from '../config/db.js';

export interface DesktopAuthCleanupResult {
  deletedRows: number;
}

export async function cleanupDesktopAuthSessions(retentionDays: number): Promise<DesktopAuthCleanupResult> {
  const safeDays = Number.isFinite(retentionDays) && retentionDays >= 0 ? Math.floor(retentionDays) : 7;
  const cutoffIso = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: revokedRows, error: revokedError } = await supabase
    .from('desktop_auth_sessions')
    .delete()
    .not('revoked_at', 'is', null)
    .select('id');

  if (revokedError) {
    throw new Error(`Desktop auth cleanup failed: ${revokedError.message}`);
  }

  const { data: expiredRows, error: expiredError } = await supabase
    .from('desktop_auth_sessions')
    .delete()
    .lt('refresh_token_expires_at', cutoffIso)
    .select('id');

  if (expiredError) {
    throw new Error(`Desktop auth cleanup failed: ${expiredError.message}`);
  }

  const revokedCount = Array.isArray(revokedRows) ? revokedRows.length : 0;
  const expiredCount = Array.isArray(expiredRows) ? expiredRows.length : 0;
  return { deletedRows: revokedCount + expiredCount };
}
