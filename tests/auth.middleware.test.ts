import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const clerkMocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock('@clerk/backend', () => ({
  verifyToken: clerkMocks.verifyToken,
  createClerkClient: vi.fn(() => ({
    users: {
      getUser: clerkMocks.getUser,
    },
  })),
}));

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
  process.env.DESKTOP_TOKEN_SIGNING_KEY =
    process.env.DESKTOP_TOKEN_SIGNING_KEY || 'test-desktop-token-signing-key-at-least-32-chars';

  ({ requireAuth, requireAdmin } = await import('../src/middleware/auth.middleware'));
});

beforeEach(() => {
  vi.restoreAllMocks();
  clerkMocks.verifyToken.mockReset();
  clerkMocks.getUser.mockReset();
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
    clerkMocks.verifyToken.mockRejectedValue(new Error('invalid'));

    const req: AuthRequestLike = { headers: { authorization: 'Bearer invalid' }, query: {} };
    const res = createResponseMock();
    const next = vi.fn();

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts token from bearer header and attaches user + admin status', async () => {
    clerkMocks.verifyToken.mockResolvedValue({ sub: 'user-123' });
    clerkMocks.getUser.mockResolvedValue({
      publicMetadata: { isAdmin: true },
    });

    const req: AuthRequestLike = { headers: { authorization: 'Bearer header-token' }, query: {} };
    const res = createResponseMock();
    const next = vi.fn();

    await requireAuth(req, res, next);

    expect(clerkMocks.verifyToken).toHaveBeenCalledWith('header-token', {
      secretKey: expect.any(String),
    });
    expect(clerkMocks.getUser).toHaveBeenCalledWith('user-123');
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
