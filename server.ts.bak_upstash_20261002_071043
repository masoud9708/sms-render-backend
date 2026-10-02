import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const app = new Hono();

// ═══════════════════════════════════════════════════
// In-memory store (روی Render free tier کافیه)
// برای persistence بیشتر، KV_URL و KV_TOKEN ست کن
// ═══════════════════════════════════════════════════
const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';

const memStore = new Map<string, string>();

async function kvGet(key: string): Promise<string | null> {
  if (KV_URL) {
    try {
      const res = await fetch(`${KV_URL}/get/${key}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      const j = await res.json();
      return j.result ?? null;
    } catch { /* fallback */ }
  }
  return memStore.get(key) ?? null;
}

async function kvSet(key: string, value: string) {
  if (KV_URL) {
    try {
      await fetch(`${KV_URL}/set/${key}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${KV_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(value),
      });
      return;
    } catch { /* fallback */ }
  }
  memStore.set(key, value);
}

async function kvKeys(pattern: string): Promise<string[]> {
  const prefix = pattern.replace('*', '');
  if (KV_URL) {
    try {
      const res = await fetch(`${KV_URL}/keys/${pattern}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      const j = await res.json();
      return j.result ?? [];
    } catch { /* fallback */ }
  }
  return Array.from(memStore.keys()).filter(k => k.startsWith(prefix));
}

// ═══════════════════════════════════════════════════
// Health check
// ═══════════════════════════════════════════════════
app.get('/', (c) => c.json({
  ok: true,
  service: 'sms-relay-render',
  version: '1.0.0',
  ts: Date.now(),
}));

// ═══════════════════════════════════════════════════
// Register device
// ═══════════════════════════════════════════════════
app.post('/register', async (c) => {
  try {
    const body = await c.req.json();
    const { id, name } = body;
    if (!id) return c.json({ ok: false, error: 'no id' }, 400);

    const data = {
      id,
      name: name || 'unknown',
      last_seen: Date.now(),
    };
    await kvSet(`device:${id}`, JSON.stringify(data));

    return c.json({ ok: true, device: data });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ═══════════════════════════════════════════════════
// List devices
// ═══════════════════════════════════════════════════
app.get('/devices', async (c) => {
  try {
    const keys = await kvKeys('device:*');
    const devices: any[] = [];

    for (const key of keys) {
      const d = await kvGet(key);
      if (d) devices.push(JSON.parse(d));
    }

    devices.sort((a, b) => b.last_seen - a.last_seen);
    const active = await kvGet('active');
    const now = Date.now();

    const result = devices.slice(0, 10).map((d) => ({
      ...d,
      active: d.id === active,
      online: (now - d.last_seen) < 180000,
    }));

    return c.json({ ok: true, devices: result, active });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ═══════════════════════════════════════════════════
// Get active device
// ═══════════════════════════════════════════════════
app.get('/active', async (c) => {
  try {
    const active = await kvGet('active');
    return c.json({ ok: true, active });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ═══════════════════════════════════════════════════
// Set active device
// ═══════════════════════════════════════════════════
app.post('/set-active', async (c) => {
  try {
    const body = await c.req.json();
    if (!body.id) return c.json({ ok: false, error: 'no id' }, 400);
    await kvSet('active', body.id);
    return c.json({ ok: true, active: body.id });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ═══════════════════════════════════════════════════
// Telegram Proxy
// GET /proxy?path=bot<TOKEN>/getMe
// ═══════════════════════════════════════════════════
app.all('/proxy', async (c) => {
  try {
    const path = c.req.query('path') || '';
    if (!path) return c.json({ ok: false, error: 'missing path' }, 400);

    // Build query (excluding path param)
    const url = new URL(c.req.url);
    const params = new URLSearchParams(url.search);
    params.delete('path');
    const query = params.toString();

    const targetUrl = `https://api.telegram.org/${path}${query ? '?' + query : ''}`;

    // Get body if POST
    let bodyBuf: ArrayBuffer | undefined;
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      bodyBuf = await c.req.arrayBuffer();
    }

    const headers: Record<string, string> = {
      'Content-Type': c.req.header('content-type') || 'application/json',
    };
    const ua = c.req.header('user-agent');
    if (ua) headers['User-Agent'] = ua;

    const resp = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: bodyBuf,
    });

    const data = await resp.arrayBuffer();
    return new Response(data, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('content-type') || 'application/json',
      },
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ═══════════════════════════════════════════════════
// Start server
// ═══════════════════════════════════════════════════
const port = parseInt(process.env.PORT || '10000');
serve({ fetch: app.fetch, port }, () => {
  console.log(`🚀 Server running on port ${port}`);
});
