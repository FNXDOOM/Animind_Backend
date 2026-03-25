import { supabase } from '../config/db.js';

export interface SyncPlayCleanupResult {
  expiredRooms: number;
  deletedRooms: number;
  deletedParticipantRows: number;
}

let hasWarnedMissingEndedAtColumn = false;

function isMissingEndedAtColumnError(message: string): boolean {
  return /ended_at/i.test(message) && /(column|schema cache|does not exist)/i.test(message);
}

export async function cleanupEndedWatchParties(ttlMinutes: number): Promise<SyncPlayCleanupResult> {
  const ttl = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? Math.floor(ttlMinutes) : 60;
  const cutoffIso = new Date(Date.now() - ttl * 60_000).toISOString();

  const { data: expiredParties, error: selectError } = await supabase
    .from('watch_parties')
    .select('id')
    .eq('status', 'ended')
    .lte('ended_at', cutoffIso);

  if (selectError) {
    if (isMissingEndedAtColumnError(selectError.message)) {
      if (!hasWarnedMissingEndedAtColumn) {
        hasWarnedMissingEndedAtColumn = true;
        console.warn('[SyncPlay] watch_parties.ended_at is missing. Run SyncPlay TTL migration before auto cleanup can run.');
      }
      return { expiredRooms: 0, deletedRooms: 0, deletedParticipantRows: 0 };
    }

    throw new Error(`Failed to find expired ended watch parties: ${selectError.message}`);
  }

  const partyIds = (expiredParties ?? []).map(row => row.id).filter(Boolean);
  if (!partyIds.length) {
    return { expiredRooms: 0, deletedRooms: 0, deletedParticipantRows: 0 };
  }

  const { data: deletedParticipants, error: participantDeleteError } = await supabase
    .from('watch_party_participants')
    .delete()
    .in('party_id', partyIds)
    .select('party_id');

  if (participantDeleteError) {
    throw new Error(`Failed to delete expired watch party participants: ${participantDeleteError.message}`);
  }

  const { data: deletedParties, error: partyDeleteError } = await supabase
    .from('watch_parties')
    .delete()
    .in('id', partyIds)
    .select('id');

  if (partyDeleteError) {
    throw new Error(`Failed to delete expired watch parties: ${partyDeleteError.message}`);
  }

  return {
    expiredRooms: partyIds.length,
    deletedRooms: deletedParties?.length ?? 0,
    deletedParticipantRows: deletedParticipants?.length ?? 0,
  };
}
