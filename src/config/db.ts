import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

// Service-role client: bypasses RLS — only use server-side, never expose to frontend
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
