import crypto from 'crypto';
import { env } from '../config/env.js';
import { supabase } from '../config/db.js';

const ACCESS_PREFIX = 'adk_';
const REFRESH_PREFIX = 'adr_';
const ACCESS_VERSION = 'v1';

type DesktopSessionRow = {
  id: string;
  user_id: string;
  session_id: string;
  device_id: string | null;
  device_name: string | null;
  refresh_token_hash: string;
  refresh_token_expires_at: string;
  access_token_hash: string;
  access_token_expires_at: string;
  revoked_at: string | null;
};

function toBase64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function signAccessToken(userId: string, sessionId: string, exp: number): string {
  const payload = `${ACCESS_VERSION}.${userId}.${sessionId}.${exp}`;
  const sig = crypto
    .createHmac('sha256', env.DESKTOP_TOKEN_SIGNING_KEY)
    .update(payload)
    .digest('base64url');
  return `${ACCESS_PREFIX}${toBase64Url(payload)}.${sig}`;
}

function parseAndVerifyAccessToken(token: string): { userId: string; sessionId: string; exp: number } | null {
  if (!token.startsWith(ACCESS_PREFIX)) return null;
  const raw = token.slice(ACCESS_PREFIX.length);
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;

  const payloadB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const payload = Buffer.from(payloadB64, 'base64url').toString('utf-8');
  const expectedSig = crypto
    .createHmac('sha256', env.DESKTOP_TOKEN_SIGNING_KEY)
    .update(payload)
    .digest('base64url');

  if (sig !== expectedSig) return null;

  const parts = payload.split('.');
  if (parts.length !== 4) return null;
  if (parts[0] !== ACCESS_VERSION) return null;
  const userId = parts[1];
  const sessionId = parts[2];
  const exp = Number(parts[3]);
  if (!userId || !sessionId || !Number.isFinite(exp) || exp <= nowSeconds()) return null;

  return { userId, sessionId, exp };
}

function newRefreshToken(): string {
  return `${REFRESH_PREFIX}${crypto.randomBytes(48).toString('base64url')}`;
}

function plusSecondsDate(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function plusDaysDate(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export async function createDesktopSessionTokens(params: {
  userId: string;
  deviceId?: string | null;
  deviceName?: string | null;
}) {
  const sessionId = crypto.randomUUID();
  const refreshToken = newRefreshToken();
  const refreshHash = sha256Hex(refreshToken);
  const refreshExp = plusDaysDate(env.DESKTOP_REFRESH_TOKEN_TTL_DAYS);

  const accessExpSec = nowSeconds() + env.DESKTOP_ACCESS_TOKEN_TTL_SECONDS;
  const accessToken = signAccessToken(params.userId, sessionId, accessExpSec);
  const accessHash = sha256Hex(accessToken);
  const accessExp = plusSecondsDate(env.DESKTOP_ACCESS_TOKEN_TTL_SECONDS);

  const { error } = await supabase.from('desktop_auth_sessions').insert({
    user_id: params.userId,
    session_id: sessionId,
    device_id: params.deviceId ?? null,
    device_name: params.deviceName ?? null,
    refresh_token_hash: refreshHash,
    refresh_token_expires_at: refreshExp,
    access_token_hash: accessHash,
    access_token_expires_at: accessExp,
    revoked_at: null,
  });

  if (error) throw new Error(`Failed to create desktop auth session: ${error.message}`);

  return {
    accessToken,
    refreshToken,
    sessionId,
    accessTokenExpiresAt: accessExp,
    refreshTokenExpiresAt: refreshExp,
    expiresIn: env.DESKTOP_ACCESS_TOKEN_TTL_SECONDS,
  };
}

export async function refreshDesktopSessionTokens(refreshToken: string) {
  const refreshHash = sha256Hex(refreshToken);
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from('desktop_auth_sessions')
    .select('*')
    .eq('refresh_token_hash', refreshHash)
    .is('revoked_at', null)
    .gt('refresh_token_expires_at', nowIso)
    .single<DesktopSessionRow>();

  if (error || !data) {
    return null;
  }

  const newRefresh = newRefreshToken();
  const newRefreshHash = sha256Hex(newRefresh);
  const newRefreshExp = plusDaysDate(env.DESKTOP_REFRESH_TOKEN_TTL_DAYS);

  const accessExpSec = nowSeconds() + env.DESKTOP_ACCESS_TOKEN_TTL_SECONDS;
  const newAccess = signAccessToken(data.user_id, data.session_id, accessExpSec);
  const newAccessHash = sha256Hex(newAccess);
  const newAccessExp = plusSecondsDate(env.DESKTOP_ACCESS_TOKEN_TTL_SECONDS);

  const { error: updateError } = await supabase
    .from('desktop_auth_sessions')
    .update({
      refresh_token_hash: newRefreshHash,
      refresh_token_expires_at: newRefreshExp,
      access_token_hash: newAccessHash,
      access_token_expires_at: newAccessExp,
      updated_at: new Date().toISOString(),
    })
    .eq('id', data.id);

  if (updateError) {
    throw new Error(`Failed to refresh desktop auth session: ${updateError.message}`);
  }

  return {
    userId: data.user_id,
    sessionId: data.session_id,
    accessToken: newAccess,
    refreshToken: newRefresh,
    accessTokenExpiresAt: newAccessExp,
    refreshTokenExpiresAt: newRefreshExp,
    expiresIn: env.DESKTOP_ACCESS_TOKEN_TTL_SECONDS,
  };
}

export async function revokeDesktopSessionByRefreshToken(refreshToken: string): Promise<boolean> {
  const refreshHash = sha256Hex(refreshToken);
  const { error } = await supabase
    .from('desktop_auth_sessions')
    .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('refresh_token_hash', refreshHash)
    .is('revoked_at', null);
  return !error;
}

export async function revokeDesktopSessionByAccessToken(accessToken: string): Promise<boolean> {
  const accessHash = sha256Hex(accessToken);
  const { error } = await supabase
    .from('desktop_auth_sessions')
    .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('access_token_hash', accessHash)
    .is('revoked_at', null);
  return !error;
}

export async function verifyDesktopAccessToken(accessToken: string): Promise<{ userId: string; sessionId: string } | null> {
  const parsed = parseAndVerifyAccessToken(accessToken);
  if (!parsed) return null;

  const accessHash = sha256Hex(accessToken);
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('desktop_auth_sessions')
    .select('id,user_id,session_id')
    .eq('access_token_hash', accessHash)
    .eq('user_id', parsed.userId)
    .eq('session_id', parsed.sessionId)
    .is('revoked_at', null)
    .gt('access_token_expires_at', nowIso)
    .single<{ id: string; user_id: string; session_id: string }>();

  if (error || !data) return null;
  return { userId: data.user_id, sessionId: data.session_id };
}

export function isDesktopAccessToken(token: string): boolean {
  return token.startsWith(ACCESS_PREFIX);
}
