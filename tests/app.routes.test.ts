import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const controllerMocks = vi.hoisted(() => ({
  getShows: vi.fn((_req, res) => {
    res.status(200).json({ data: [{ id: 'show-1', title: 'Frieren' }] });
  }),
  getShowById: vi.fn((req, res) => {
    res.status(200).json({ id: req.params.id, title: 'By Id' });
  }),
  rescanLibrary: vi.fn((_req, res) => {
    res.status(200).json([{ id: 'show-2', title: 'Naruto' }]);
  }),
  storageWebhook: vi.fn((_req, res) => {
    res.status(202).json({ ok: true });
  }),
  streamEpisode: vi.fn((req, res) => {
    res.status(200).json({ url: `https://stream.local/${req.params.id}` });
  }),
  getEpisodeSubtitles: vi.fn((_req, res) => {
    res.status(200).json({ tracks: [{ id: 'en' }] });
  }),
  deleteMyAccount: vi.fn((_req, res) => {
    res.status(204).send();
  }),
  listUsers: vi.fn((_req, res) => {
    res.status(200).json([]);
  }),
  setAdminStatus: vi.fn((_req, res) => {
    res.status(200).json({ ok: true });
  }),
  deleteShow: vi.fn((_req, res) => {
    res.status(204).send();
  }),
  triggerAdminScan: vi.fn((_req, res) => {
    res.status(202).json({ queued: true });
  }),
}));

vi.mock('../src/controllers/show.controller.js', () => ({
  getShows: controllerMocks.getShows,
  getShowById: controllerMocks.getShowById,
}));

vi.mock('../src/controllers/scanner.controller.js', () => ({
  rescanLibrary: controllerMocks.rescanLibrary,
  storageWebhook: controllerMocks.storageWebhook,
}));

vi.mock('../src/controllers/episode.controller.js', () => ({
  streamEpisode: controllerMocks.streamEpisode,
  getEpisodeSubtitles: controllerMocks.getEpisodeSubtitles,
}));

vi.mock('../src/controllers/account.controller.js', () => ({
  deleteMyAccount: controllerMocks.deleteMyAccount,
}));

vi.mock('../src/controllers/admin.controller.js', () => ({
  listUsers: controllerMocks.listUsers,
  setAdminStatus: controllerMocks.setAdminStatus,
  deleteShow: controllerMocks.deleteShow,
  triggerAdminScan: controllerMocks.triggerAdminScan,
}));

vi.mock('../src/middleware/auth.middleware.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!req.headers.authorization) {
      res.status(401).json({ error: 'Missing or invalid authorization token.' });
      return;
    }
    req.userId = 'user-1';
    req.isAdmin = req.headers.authorization === 'Bearer admin-token';
    next();
  },
  requireAdmin: (req: any, res: any, next: any) => {
    if (!req.isAdmin) {
      res.status(403).json({ error: 'Admin access required.' });
      return;
    }
    next();
  },
}));

let app: any;

beforeAll(async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service-role-key';
  process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

  ({ default: app } = await import('../src/app'));
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('app + api routes', () => {
  it('GET /health returns service health payload', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(typeof response.body.timestamp).toBe('string');
  });

  it('GET /api/shows returns shows list', async () => {
    const response = await request(app).get('/api/shows');

    expect(response.status).toBe(200);
    expect(controllerMocks.getShows).toHaveBeenCalledTimes(1);
    expect(response.body.data[0].title).toBe('Frieren');
  });

  it('POST /api/rescan returns scan payload', async () => {
    const response = await request(app).post('/api/rescan');

    expect(response.status).toBe(200);
    expect(controllerMocks.rescanLibrary).toHaveBeenCalledTimes(1);
    expect(response.body[0].id).toBe('show-2');
  });

  it('GET /api/episodes/:id/stream requires auth', async () => {
    const response = await request(app).get('/api/episodes/ep-1/stream');

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Missing or invalid authorization token.');
    expect(controllerMocks.streamEpisode).not.toHaveBeenCalled();
  });

  it('GET /api/episodes/:id/stream succeeds with auth', async () => {
    const response = await request(app)
      .get('/api/episodes/ep-1/stream')
      .set('Authorization', 'Bearer user-token');

    expect(response.status).toBe(200);
    expect(controllerMocks.streamEpisode).toHaveBeenCalledTimes(1);
    expect(response.body.url).toBe('https://stream.local/ep-1');
  });

  it('GET /api/admin/users denies non-admin token', async () => {
    const response = await request(app)
      .get('/api/admin/users')
      .set('Authorization', 'Bearer user-token');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Admin access required.');
    expect(controllerMocks.listUsers).not.toHaveBeenCalled();
  });

  it('GET /api/admin/users allows admin token', async () => {
    const response = await request(app)
      .get('/api/admin/users')
      .set('Authorization', 'Bearer admin-token');

    expect(response.status).toBe(200);
    expect(controllerMocks.listUsers).toHaveBeenCalledTimes(1);
  });

  it('returns 404 on unknown route', async () => {
    const response = await request(app).get('/not-found');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Not found.');
  });
});
