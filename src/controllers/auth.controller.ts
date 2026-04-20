import { Request, Response } from 'express';
import { supabase } from '../config/db.js';
import { env } from '../config/env.js';

function defaultAvatarFor(username: string): string {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=8b5cf6&color=fff&bold=true`;
}

function normalizeUsername(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

function normalizeAuthMode(raw: unknown): 'signin' | 'signup' {
  return raw === 'signup' ? 'signup' : 'signin';
}

export async function loginWithPassword(req: Request, res: Response) {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session?.access_token) {
      res.status(401).json({ error: error?.message ?? 'Invalid email or password.' });
      return;
    }

    res.status(200).json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      user: {
        id: data.user?.id,
        email: data.user?.email,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? 'Login failed.' });
  }
}

export async function getGoogleAuthUrl(req: Request, res: Response) {
  try {
    const mode = normalizeAuthMode(req.query?.mode);
    const supabaseBase = env.SUPABASE_URL.replace(/\/+$/, '');
    const redirectUrl = `animind://auth-callback?mode=${mode}`;
    const authorizeUrl =
      `${supabaseBase}/auth/v1/authorize` +
      `?provider=google` +
      `&redirect_to=${encodeURIComponent(redirectUrl)}` +
      `&response_type=token` +
      `&access_type=offline` +
      `&prompt=select_account`;

    res.status(200).json({ url: authorizeUrl, mode });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? 'Failed to build Google auth URL.' });
  }
}

export async function signUpWithServiceRole(req: Request, res: Response) {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const username = normalizeUsername(req.body?.username);

    if (!email || !password || !username) {
      res.status(400).json({ error: 'Email, password, and username are required.' });
      return;
    }

    const avatarUrl = defaultAvatarFor(username);

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        username,
        avatar_url: avatarUrl,
      },
    });

    if (authError || !authData?.user) {
      res.status(400).json({ error: authError?.message ?? 'Failed to create user.' });
      return;
    }

    const createdUser = authData.user;

    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({
        id: createdUser.id,
        username,
        avatar_url: avatarUrl,
        is_admin: false,
      }, {
        onConflict: 'id',
      });

    if (profileError) {
      await supabase.auth.admin.deleteUser(createdUser.id, true);
      res.status(500).json({ error: `Profile creation failed: ${profileError.message}` });
      return;
    }

    res.status(201).json({
      success: true,
      user: {
        id: createdUser.id,
        email: createdUser.email,
        username,
        avatar_url: avatarUrl,
        is_admin: false,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? 'Signup failed.' });
  }
}
