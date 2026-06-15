// Find My Rizq — aggregation engine (D1)

import { CONNECTORS, normalize } from './connectors.js';
import { categorize, tagsFor, jobType } from './categorizer.js';
import { buildFilterConfig, shouldExclude } from './filter.js';
import { geocode } from './geocode.js';

function getQueries(env) {
  const raw = (env.SEARCH_QUERIES || '').trim();
  const perPage = parseInt(env.PER_PAGE || '50', 10);
  const queries = [];
  for (const line of raw.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    const [what = '', where = ''] = l.split('|').map(s => s.trim());
    queries.push({ what, where, page: 1, perPage });
  }
  if (!queries.length) queries.push({ what: '', where: '', page: 1, perPage });
  return queries;
}

export async function runFetch(env) {
  const now = Math.floor(Date.now() / 1000);
  const cfg = buildFilterConfig(env);
  const queries = getQueries(env);
  const summary = { fetched: 0, inserted: 0, updated: 0, excluded: 0, expired: 0, errors: [] };

  // Cap geocode lookups per run so a cron tick stays well within limits.
  let geocodeBudget = parseInt(env.GEOCODE_PER_RUN || '15', 10);

  for (const { slug, fn } of CONNECTORS) {
    for (const q of queries) {
      let rows;
      try {
        rows = await fn(env, q);
      } catch (e) {
        summary.errors.push(`${slug}: ${e.message}`);
        continue;
      }
      if (!rows || !rows.length) continue;

      for (const raw of rows) {
        const job = normalize(raw);
        if (!job.title || !job.url) continue;
        summary.fetched++;

        const reason = shouldExclude(job, cfg);
        if (reason) {
          summary.excluded++;
          await env.DB.prepare('DELETE FROM jobs WHERE dedup_key = ?')
            .bind(`${job.source}:${job.external_id}`).run();
          continue;
        }

        job.category = categorize(job);
        const tags = tagsFor(job);
        job.job_type = jobType(job);

        // coordinates: source-provided, else geocode (budgeted)
        let lat = job.latitude, lng = job.longitude;
        if ((lat == null || lng == null) && job.location && geocodeBudget > 0) {
          const existing = await env.DB.prepare('SELECT lat FROM jobs WHERE dedup_key = ?')
            .bind(`${job.source}:${job.external_id}`).first();
          if (!existing || existing.lat == null) {
            geocodeBudget--;
            const geo = await geocode(env, job.location);
            if (geo) { lat = geo.lat; lng = geo.lng; }
          }
        }

        const res = await upsert(env, job, tags, lat, lng, now);
        if (res === 'inserted') summary.inserted++;
        else if (res === 'updated') summary.updated++;
      }
    }
  }

  await env.DB.prepare(
    'INSERT INTO runs (ran_at, fetched, inserted, updated, excluded, expired, errors) VALUES (?,?,?,?,?,?,?)'
  ).bind(now, summary.fetched, summary.inserted, summary.updated, summary.excluded, 0,
    summary.errors.length ? JSON.stringify(summary.errors).slice(0, 1000) : null).run();

  return summary;
}

async function upsert(env, job, tags, lat, lng, now) {
  const key = `${job.source}:${job.external_id}`;
  const existing = await env.DB.prepare('SELECT id FROM jobs WHERE dedup_key = ?').bind(key).first();

  if (existing) {
    await env.DB.prepare(
      `UPDATE jobs SET title=?, company=?, description=?, location=?, salary=?, salary_min=?, salary_max=?,
       currency=?, job_type=?, category=?, tags=?, remote=?, lat=COALESCE(?,lat), lng=COALESCE(?,lng),
       apply_url=?, posted_at=?, last_seen=?, status='live' WHERE id=?`
    ).bind(job.title, job.company, job.description, job.location, job.salary, job.salary_min, job.salary_max,
      job.currency, job.job_type, job.category, JSON.stringify(tags), job.remote ? 1 : 0, lat, lng,
      job.url, job.posted, now, existing.id).run();
    return 'updated';
  }

  await env.DB.prepare(
    `INSERT INTO jobs (dedup_key, source, external_id, title, company, description, location, country,
      salary, salary_min, salary_max, currency, job_type, category, tags, remote, lat, lng,
      apply_url, posted_at, first_seen, last_seen, status, clicks)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'live',0)`
  ).bind(key, job.source, job.external_id, job.title, job.company, job.description, job.location, job.country,
    job.salary, job.salary_min, job.salary_max, job.currency, job.job_type, job.category, JSON.stringify(tags),
    job.remote ? 1 : 0, lat, lng, job.url, job.posted, now, now).run();
  return 'inserted';
}

export async function runExpiry(env) {
  const now = Math.floor(Date.now() / 1000);
  const maxAge = parseInt(env.EXPIRE_AFTER_HOURS || '72', 10) * 3600;
  const cutoff = now - maxAge;

  const r = await env.DB.prepare("UPDATE jobs SET status='expired' WHERE status='live' AND last_seen < ?")
    .bind(cutoff).run();
  const expired = r.meta?.changes || 0;

  const delDays = parseInt(env.DELETE_AFTER_DAYS || '0', 10);
  if (delDays > 0) {
    const delCutoff = now - delDays * 86400;
    await env.DB.prepare("DELETE FROM jobs WHERE status='expired' AND last_seen < ?").bind(delCutoff).run();
  }

  return expired;
}
