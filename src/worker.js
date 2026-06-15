// Find My Rizq — Cloudflare Worker (API + scheduled aggregation)
//
// Routes:
//   GET  /api/jobs        list + filter + paginate
//   GET  /api/job/:id     single job
//   GET  /api/meta        categories, types, counts, last run
//   GET  /job-go/:id      log click, redirect to source
//   POST /api/admin/fetch manual fetch (needs ADMIN_TOKEN)
//   GET  /api/admin/status run history (needs ADMIN_TOKEN)
//
// Cron (configured in wrangler.toml) runs runFetch + runExpiry.

import { runFetch, runExpiry } from './aggregator.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

function rowToJob(r) {
  return {
    id: r.id,
    title: r.title,
    company: r.company,
    description: r.description,
    location: r.location,
    country: r.country,
    salary: r.salary,
    salaryMin: r.salary_min,
    salaryMax: r.salary_max,
    currency: r.currency,
    type: r.job_type,
    category: r.category,
    tags: r.tags ? JSON.parse(r.tags) : [],
    remote: !!r.remote,
    lat: r.lat,
    lng: r.lng,
    via: r.source,
    posted: r.posted_at,
    status: r.status,
    applyPath: `/job-go/${r.id}`,
  };
}

async function handleJobs(url, env) {
  const p = url.searchParams;
  const limit = Math.min(50, parseInt(p.get('limit') || '15', 10));
  const offset = Math.max(0, parseInt(p.get('offset') || '0', 10));

  const where = ["status = 'live'"];
  const bind = [];

  const q = (p.get('q') || '').trim();
  if (q) { where.push('(title LIKE ? OR company LIKE ? OR description LIKE ?)'); const t = `%${q}%`; bind.push(t, t, t); }

  const cat = p.get('category');
  if (cat && cat !== 'All') { where.push('category = ?'); bind.push(cat); }

  const type = p.get('type');
  if (type) { where.push('job_type = ?'); bind.push(type); }

  const loc = (p.get('location') || '').trim();
  if (loc) { where.push('location LIKE ?'); bind.push(`%${loc}%`); }

  if (p.get('remote') === '1') where.push('remote = 1');

  const min = parseInt(p.get('salaryMin') || '', 10);
  if (!Number.isNaN(min)) { where.push('(salary_max >= ? OR salary_min >= ?)'); bind.push(min, min); }

  const whereSql = where.join(' AND ');

  const sort = p.get('sort') || 'newest';
  const orderBy = sort === 'salary-desc'
    ? 'COALESCE(salary_max, salary_min) DESC NULLS LAST, posted_at DESC'
    : sort === 'salary-asc'
    ? 'COALESCE(salary_min, salary_max) ASC NULLS LAST, posted_at DESC'
    : sort === 'az'
    ? 'title ASC'
    : 'posted_at DESC';

  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${whereSql}`).bind(...bind).first();
  const rows = await env.DB.prepare(
    `SELECT * FROM jobs WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
  ).bind(...bind, limit, offset).all();

  return json({ total: countRow.n, limit, offset, jobs: (rows.results || []).map(rowToJob) });
}

async function handleJob(id, env) {
  const r = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  if (!r) return json({ error: 'Not found' }, 404);
  return json(rowToJob(r));
}

async function handleMeta(env) {
  const cats = await env.DB.prepare("SELECT category, COUNT(*) n FROM jobs WHERE status='live' GROUP BY category ORDER BY n DESC").all();
  const types = await env.DB.prepare("SELECT job_type, COUNT(*) n FROM jobs WHERE status='live' GROUP BY job_type ORDER BY n DESC").all();
  const live = await env.DB.prepare("SELECT COUNT(*) n FROM jobs WHERE status='live'").first();
  const lastRun = await env.DB.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').first();
  return json({
    liveCount: live.n,
    categories: (cats.results || []).map(c => ({ name: c.category, count: c.n })),
    types: (types.results || []).map(t => ({ name: t.job_type, count: t.n })),
    lastRun,
  });
}

// ---- Prayer room signal (community-reported, honest data) ----
// We never claim certainty: we return the aggregated community signal.
async function handlePrayerRoom(url, env) {
  const company = (url.searchParams.get('company') || '').trim().toLowerCase();
  if (!company) return json({ company: '', signal: 'unknown', yes: 0, no: 0 });
  const r = await env.DB.prepare(
    "SELECT SUM(has_room) yes, COUNT(*) - SUM(has_room) no, COUNT(*) total FROM prayer_rooms WHERE company = ? AND status = 'approved'"
  ).bind(company).first();
  const yes = r?.yes || 0, no = r?.no || 0, total = r?.total || 0;
  let signal = 'unknown';
  if (total > 0) signal = yes > no ? 'reported_yes' : (no > yes ? 'reported_no' : 'mixed');
  let detail = null;
  if (yes > 0) {
    const d = await env.DB.prepare(
      "SELECT detail FROM prayer_rooms WHERE company = ? AND has_room = 1 AND detail IS NOT NULL AND detail != '' ORDER BY created_at DESC LIMIT 1"
    ).bind(company).first();
    detail = d?.detail || null;
  }
  return json({ company, signal, yes, no, total, detail });
}

async function handlePrayerReport(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (body.website) return json({ ok: true }); // honeypot
  const company = String(body.company || '').trim().toLowerCase().slice(0, 160);
  if (!company) return json({ error: 'Company required' }, 400);
  const hasRoom = body.has_room ? 1 : 0;
  const ip = request.headers.get('CF-Connecting-IP') || '';
  // Rate limit: one report per company per IP.
  const dup = await env.DB.prepare('SELECT id FROM prayer_rooms WHERE company = ? AND reporter_ip = ?').bind(company, ip).first();
  if (dup) return json({ ok: true, message: 'Thanks — you already reported this workplace.' });
  await env.DB.prepare(
    "INSERT INTO prayer_rooms (company, has_room, detail, reporter_ip, status, created_at) VALUES (?,?,?,?,'approved',?)"
  ).bind(company, hasRoom, String(body.detail || '').slice(0, 200), ip, Math.floor(Date.now() / 1000)).run();
  return json({ ok: true, message: 'Thanks — your report helps the community.' });
}

async function handleRedirect(id, request, env) {
  const r = await env.DB.prepare('SELECT apply_url, source FROM jobs WHERE id = ?').bind(id).first();
  if (!r || !r.apply_url) return Response.redirect(env.SITE_URL || '/', 302);

  const ua = (request.headers.get('user-agent') || '').toLowerCase();
  const isBot = !ua || ['bot', 'crawl', 'spider', 'slurp', 'facebookexternalhit'].some(b => ua.includes(b));

  if (!isBot) {
    const day = new Date().toISOString().slice(0, 10);
    // best-effort, non-blocking-ish
    await env.DB.batch([
      env.DB.prepare('UPDATE jobs SET clicks = clicks + 1 WHERE id = ?').bind(id),
      env.DB.prepare(
        'INSERT INTO click_stats (day, source, clicks) VALUES (?, ?, 1) ON CONFLICT(day, source) DO UPDATE SET clicks = clicks + 1'
      ).bind(day, r.source),
    ]);
  }

  let target = r.apply_url;
  const affParams = env[`${r.source.toUpperCase()}_AFFILIATE_PARAMS`];
  if (affParams) {
    const decorated = affParams.replace(/\{job_id\}/g, id).replace(/\{source\}/g, r.source);
    target += (target.includes('?') ? '&' : '?') + decorated.replace(/^[?&]/, '');
  }

  return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store' } });
}

function requireAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return env.ADMIN_TOKEN && auth === `Bearer ${env.ADMIN_TOKEN}`;
}

// ---- Anti-bot: signed math challenge (no external captcha, free) ----
// GET /api/challenge returns {a,b,token}; token = HMAC(a+b). Submitter sends
// the sum + token back. Stateless, expires via timestamp in the token.
async function hmac(env, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ADMIN_TOKEN || 'fmr'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handleChallenge(env) {
  const a = 2 + Math.floor(Math.random() * 8);
  const b = 2 + Math.floor(Math.random() * 8);
  const exp = Date.now() + 10 * 60 * 1000; // 10 min
  const sig = await hmac(env, `${a + b}:${exp}`);
  return json({ a, b, exp, token: sig });
}

async function verifyChallenge(env, answer, exp, token) {
  if (!exp || Date.now() > +exp) return false;
  const expected = await hmac(env, `${answer}:${exp}`);
  return expected === token;
}

async function handleSubmit(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }

  // Honeypot: hidden field bots fill in.
  if (body.website) return json({ ok: true }); // silently drop

  if (!(await verifyChallenge(env, body.answer, body.exp, body.token)))
    return json({ error: 'Please solve the verification question correctly.' }, 400);

  const req = ['title', 'company', 'description', 'apply_url'];
  for (const f of req) if (!body[f] || !String(body[f]).trim()) return json({ error: `Missing ${f}` }, 400);

  const url = String(body.apply_url).trim();
  if (!/^https?:\/\//i.test(url)) return json({ error: 'Apply link must start with http' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || '';
  // Light rate limit: max 3 pending from same IP.
  const pend = await env.DB.prepare("SELECT COUNT(*) n FROM submissions WHERE submitter_ip=? AND status='pending'").bind(ip).first();
  if (pend.n >= 3) return json({ error: 'You have submissions awaiting review already.' }, 429);

  await env.DB.prepare(
    `INSERT INTO submissions (title,company,description,location,salary,job_type,category,remote,apply_url,contact_email,submitter_ip,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?)`
  ).bind(
    String(body.title).slice(0, 200), String(body.company).slice(0, 160),
    String(body.description).slice(0, 6000), String(body.location || '').slice(0, 160),
    String(body.salary || '').slice(0, 80), String(body.job_type || '').slice(0, 40),
    String(body.category || '').slice(0, 60), body.remote ? 1 : 0, url,
    String(body.contact_email || '').slice(0, 160), ip, Math.floor(Date.now() / 1000)
  ).run();

  return json({ ok: true, message: 'Thanks — your job is awaiting review and will appear once approved.' });
}

async function handleAdminSubmissions(env) {
  const rows = await env.DB.prepare("SELECT * FROM submissions WHERE status='pending' ORDER BY created_at DESC").all();
  return json({ pending: rows.results || [] });
}

async function handleAdminReview(request, env, id, action) {
  const s = await env.DB.prepare('SELECT * FROM submissions WHERE id=?').bind(id).first();
  if (!s) return json({ error: 'Not found' }, 404);
  const now = Math.floor(Date.now() / 1000);

  if (action === 'approve') {
    const key = `submitted:${id}`;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO jobs (dedup_key,source,external_id,title,company,description,location,country,
        salary,job_type,category,tags,remote,apply_url,posted_at,first_seen,last_seen,status,clicks)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'live',0)`
    ).bind(key, 'submitted', String(id), s.title, s.company, s.description, s.location, '',
      s.salary, s.job_type, s.category || 'Other', JSON.stringify(s.remote ? ['Remote'] : []),
      s.remote, s.apply_url, now, now, now).run();
  }

  await env.DB.prepare('UPDATE submissions SET status=?, reviewed_at=? WHERE id=?')
    .bind(action === 'approve' ? 'approved' : 'rejected', now, id).run();
  return json({ ok: true, id, action });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (url.hostname === 'www.findmyrizq.co.uk')
      return Response.redirect('https://findmyrizq.co.uk' + url.pathname + url.search, 301);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      if (path === '/api/jobs') return await handleJobs(url, env);
      if (path === '/api/meta') return await handleMeta(env);
      if (path === '/api/prayer-room') return await handlePrayerRoom(url, env);
      if (path === '/api/prayer-room/report' && request.method === 'POST') return await handlePrayerReport(request, env);

      if (path === '/api/challenge') return await handleChallenge(env);
      if (path === '/api/submit' && request.method === 'POST') return await handleSubmit(request, env);

      let m;
      if ((m = path.match(/^\/api\/job\/(\d+)$/))) return await handleJob(+m[1], env);
      if ((m = path.match(/^\/job-go\/(\d+)$/))) return await handleRedirect(+m[1], request, env);

      if (path === '/api/admin/fetch' && request.method === 'POST') {
        if (!requireAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
        const summary = await runFetch(env);
        const expired = await runExpiry(env);
        return json({ ok: true, summary, expired });
      }

      if (path === '/api/admin/submissions') {
        if (!requireAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
        return await handleAdminSubmissions(env);
      }

      if ((m = path.match(/^\/api\/admin\/submissions\/(\d+)\/(approve|reject)$/)) && request.method === 'POST') {
        if (!requireAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
        return await handleAdminReview(request, env, +m[1], m[2]);
      }

      if (path === '/api/admin/status') {
        if (!requireAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
        const runs = await env.DB.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 20').all();
        const clicks = await env.DB.prepare('SELECT * FROM click_stats ORDER BY day DESC LIMIT 60').all();
        return json({ runs: runs.results, clicks: clicks.results });
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await runFetch(env);
      await runExpiry(env);
    })());
  },
};
