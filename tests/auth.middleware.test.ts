import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type AuthRequestLike = {
  headers: { authorization?: string };
  query: { token?: string };
  userId?: string;
  isAdmin?: boolean;
};

type ResponseLike = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
};

let requireAuth: any;
let requireAdmin: any;
let supabase: any;

function createResponseMock(): ResponseLike {
  const res: ResponseLike = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

beforeAll(async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service-role-key';
  process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-webhook-secret';

  ({ requireAuth, requireAdmin } = await import('../src/middleware/auth.middleware'));
  ({ supabase } = await import('../src/config/db'));
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('requireAuth middleware', () => {
  it('returns 401 when token is missing', async () => {
    const req: AuthRequestLike = { headers: {}, query: {} };
    const res = createResponseMock();
    const next = vi.fn();

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing or invalid authorization token.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is invalid', async () => {
    vi.spyOn(supabase.auth, 'getUser').mockResolvedValue({ data: { user: null }, error: new Error('invalid') });

    const req: AuthRequestLike = { headers: { authorization: 'Bearer invalid' }, query: {} };
    const res = createResponseMock();
    const next = vi.fn();

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts token from bearer header and attaches user + admin status', async () => {
    vi.spyOn(supabase.auth, 'getUser').mockResolvedValue({
      data: { user: { id: 'user-123' } },
      error: null,
    });

    const maybeSingle = vi.fn().mockResolvedValue({ data: { is_admin: true } });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    vi.spyOn(supabase, 'from').mockReturnValue({ select });

    const req: AuthRequestLike = { headers: { authorization: 'Bearer header-token' }, query: {} };
    const res = createResponseMock();
    const next = vi.fn();

    await requireAuth(req, res, next);

    expect(supabase.auth.getUser).toHaveBeenCalledWith('header-token');
    expect(supabase.from).toHaveBeenCalledWith('profiles');
    expect(req.userId).toBe('user-123');
    expect(req.isAdmin).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('requireAdmin middleware', () => {
  it('returns 403 for non-admin users', () => {
    const req: AuthRequestLike = { headers: {}, query: {}, isAdmin: false };
    const res = createResponseMock();
    const next = vi.fn();

    requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Admin access required.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows admin users', () => {
    const req: AuthRequestLike = { headers: {}, query: {}, isAdmin: true };
    const res = createResponseMock();
    const next = vi.fn();

    requireAdmin(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
