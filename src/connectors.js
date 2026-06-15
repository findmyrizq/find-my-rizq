// Find My Rizq — source connectors
// Each connector is an async function (env, query) => normalisedJob[]
// query: { what, where, page, perPage }
//
// Normalised job shape (missing keys are defaulted by normalize()):
//   external_id, source, title, company, description, location, country,
//   salary, salary_min, salary_max, currency, job_type, category,
//   remote (bool), latitude, longitude, url, posted (unix seconds)

const UA = 'FindMyRizq/1.0 (+https://findmyrizq.com)';

async function getJSON(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Accept': 'application/json', 'User-Agent': UA, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

function ts(value) {
  if (!value) return Math.floor(Date.now() / 1000);
  if (typeof value === 'number') return value > 1e12 ? Math.floor(value / 1000) : value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? Math.floor(Date.now() / 1000) : Math.floor(t / 1000);
}

function clean(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function mapType(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return '';
  const table = [
    ['full', 'Full Time'], ['part', 'Part Time'], ['contract', 'Contract'],
    ['freelance', 'Contract'], ['temporary', 'Temporary'], ['temp', 'Temporary'],
    ['permanent', 'Permanent'], ['intern', 'Internship'], ['apprentice', 'Apprenticeship'],
  ];
  for (const [needle, label] of table) if (s.includes(needle)) return label;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function looksRemote(text) {
  const s = String(text || '').toLowerCase();
  return ['remote', 'work from home', 'wfh', 'anywhere', 'fully distributed'].some(n => s.includes(n));
}

function salaryStr(min, max, sym = '', cur = '') {
  const fmt = n => sym + Math.round(n).toLocaleString('en-GB');
  if (min == null && max == null) return '';
  if (min != null && max != null && min !== max) return `${fmt(min)} - ${fmt(max)}${cur ? ' ' + cur : ''}`;
  const one = min != null ? min : max;
  return `${fmt(one)}${cur ? ' ' + cur : ''}`;
}

/* ---------------- Adzuna ---------------- */
async function adzuna(env, q) {
  if (!env.ADZUNA_APP_ID || !env.ADZUNA_APP_KEY) return [];
  const country = (env.ADZUNA_COUNTRY || 'gb').toLowerCase();
  const page = q.page || 1;
  const params = new URLSearchParams({
    app_id: env.ADZUNA_APP_ID, app_key: env.ADZUNA_APP_KEY,
    results_per_page: String(Math.min(50, q.perPage || 50)), 'content-type': 'application/json',
  });
  if (q.what) params.set('what', q.what);
  if (q.where) params.set('where', q.where);
  const data = await getJSON(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?${params}`);
  return (data.results || []).map(r => ({
    external_id: String(r.id || r.redirect_url),
    source: 'adzuna',
    title: r.title || '',
    company: r.company?.display_name || '',
    description: clean(r.description),
    location: r.location?.display_name || '',
    country,
    salary: salaryStr(r.salary_min, r.salary_max),
    salary_min: r.salary_min ?? null,
    salary_max: r.salary_max ?? null,
    job_type: mapType(r.contract_time),
    category: r.category?.label || '',
    latitude: r.latitude ?? null,
    longitude: r.longitude ?? null,
    remote: looksRemote(`${r.title} ${r.location?.display_name}`),
    url: r.redirect_url || '',
    posted: ts(r.created),
  }));
}

/* ---------------- Jooble ---------------- */
async function jooble(env, q) {
  if (!env.JOOBLE_API_KEY) return [];
  const data = await getJSON(`https://jooble.org/api/${encodeURIComponent(env.JOOBLE_API_KEY)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords: q.what || '', location: q.where || '', page: String(q.page || 1) }),
  });
  return (data.jobs || []).map(r => ({
    external_id: String(r.id || (r.link || '') + (r.title || '')),
    source: 'jooble',
    title: r.title || '',
    company: r.company || '',
    description: clean(r.snippet),
    location: r.location || '',
    salary: r.salary || '',
    job_type: mapType(r.type),
    remote: looksRemote(`${r.title} ${r.location}`),
    url: r.link || '',
    posted: ts(r.updated),
  }));
}

/* ---------------- USAJobs ---------------- */
async function usajobs(env, q) {
  if (!env.USAJOBS_API_KEY || !env.USAJOBS_EMAIL) return [];
  const params = new URLSearchParams({ ResultsPerPage: String(Math.min(250, q.perPage || 50)), Page: String(q.page || 1) });
  if (q.what) params.set('Keyword', q.what);
  if (q.where) params.set('LocationName', q.where);
  const data = await getJSON(`https://data.usajobs.gov/api/search?${params}`, {
    headers: { 'Host': 'data.usajobs.gov', 'User-Agent': env.USAJOBS_EMAIL, 'Authorization-Key': env.USAJOBS_API_KEY },
  });
  return (data.SearchResult?.SearchResultItems || []).map(row => {
    const d = row.MatchedObjectDescriptor || {};
    const rem = d.PositionRemuneration?.[0] || {};
    return {
      external_id: String(d.PositionID || d.PositionURI),
      source: 'usajobs',
      title: d.PositionTitle || '',
      company: d.OrganizationName || '',
      description: clean(d.UserArea?.Details?.JobSummary || d.QualificationSummary || ''),
      location: d.PositionLocationDisplay || d.PositionLocation?.[0]?.LocationName || '',
      country: 'us',
      salary: salaryStr(rem.MinimumRange ? +rem.MinimumRange : null, rem.MaximumRange ? +rem.MaximumRange : null, '$'),
      salary_min: rem.MinimumRange ? +rem.MinimumRange : null,
      salary_max: rem.MaximumRange ? +rem.MaximumRange : null,
      currency: 'USD',
      job_type: mapType(d.PositionSchedule?.[0]?.Name),
      category: d.JobCategory?.[0]?.Name || '',
      latitude: d.PositionLocation?.[0]?.Latitude ?? null,
      longitude: d.PositionLocation?.[0]?.Longitude ?? null,
      url: d.PositionURI || '',
      posted: ts(d.PublicationStartDate),
    };
  });
}

/* ---------------- Reed ---------------- */
async function reed(env, q) {
  if (!env.REED_API_KEY) return [];
  const per = Math.min(100, q.perPage || 50);
  const params = new URLSearchParams({ resultsToTake: String(per), resultsToSkip: String(((q.page || 1) - 1) * per) });
  if (q.what) params.set('keywords', q.what);
  if (q.where) { params.set('locationName', q.where); params.set('distanceFromLocation', '15'); }
  const auth = btoa(`${env.REED_API_KEY}:`);
  const data = await getJSON(`https://www.reed.co.uk/api/1.0/search?${params}`, { headers: { Authorization: `Basic ${auth}` } });
  return (data.results || []).map(r => {
    let type = 'Full Time';
    if (r.partTime) type = 'Part Time';
    if (r.contractType) type = r.contractType;
    else if (r.permanent) type = 'Permanent';
    else if (r.temp) type = 'Temporary';
    else if (r.contract) type = 'Contract';
    return {
      external_id: String(r.jobId || r.jobUrl),
      source: 'reed',
      title: r.jobTitle || '',
      company: r.employerName || '',
      description: clean(r.jobDescription),
      location: r.locationName || '',
      country: 'gb',
      salary: salaryStr(r.minimumSalary, r.maximumSalary, '£'),
      salary_min: r.minimumSalary ?? null,
      salary_max: r.maximumSalary ?? null,
      currency: r.currency || 'GBP',
      job_type: mapType(type),
      remote: looksRemote(`${r.jobTitle} ${r.locationName}`),
      url: r.jobUrl || '',
      posted: ts(r.date),
    };
  });
}

/* ---------------- The Muse ---------------- */
async function muse(env, q) {
  if (env.MUSE_ENABLED !== '1') return [];
  const params = new URLSearchParams({ page: String(q.page || 1) });
  if (env.MUSE_API_KEY) params.set('api_key', env.MUSE_API_KEY);
  if (q.what) params.set('category', q.what);
  if (q.where) params.set('location', q.where);
  const data = await getJSON(`https://www.themuse.com/api/public/jobs?${params}`);
  return (data.results || []).map(r => {
    const loc = (r.locations || []).map(l => l.name).join(', ');
    return {
      external_id: String(r.id || r.refs?.landing_page),
      source: 'muse',
      title: r.name || '',
      company: r.company?.name || '',
      description: clean(r.contents),
      location: loc,
      remote: looksRemote(loc),
      job_type: mapType(r.type),
      category: r.categories?.[0]?.name || '',
      url: r.refs?.landing_page || '',
      posted: ts(r.publication_date),
    };
  });
}

/* ---------------- Arbeitnow ---------------- */
async function arbeitnow(env, q) {
  if (env.ARBEITNOW_ENABLED !== '1') return [];
  const data = await getJSON(`https://www.arbeitnow.com/api/job-board-api?page=${q.page || 1}`);
  const kw = (q.what || '').toLowerCase();
  return (data.data || [])
    .filter(r => !kw || `${r.title} ${r.description}`.toLowerCase().includes(kw))
    .map(r => ({
      external_id: String(r.slug || r.url),
      source: 'arbeitnow',
      title: r.title || '',
      company: r.company_name || '',
      description: clean(r.description),
      location: r.location || '',
      remote: !!r.remote,
      job_type: mapType((r.job_types || [])[0]),
      category: (r.tags || [])[0] || '',
      url: r.url || '',
      posted: r.created_at ? +r.created_at : ts(),
    }));
}

/* ---------------- Jobicy ---------------- */
async function jobicy(env, q) {
  if (env.JOBICY_ENABLED !== '1') return [];
  const params = new URLSearchParams({ count: String(Math.min(50, q.perPage || 50)) });
  if (q.what) params.set('tag', q.what);
  const data = await getJSON(`https://jobicy.com/api/v2/remote-jobs?${params}`);
  return (data.jobs || []).map(r => ({
    external_id: String(r.id || r.url),
    source: 'jobicy',
    title: r.jobTitle || '',
    company: r.companyName || '',
    description: clean(r.jobDescription),
    location: r.jobGeo || 'Remote',
    remote: true,
    salary: salaryStr(r.annualSalaryMin, r.annualSalaryMax, '', r.salaryCurrency || ''),
    salary_min: r.annualSalaryMin ?? null,
    salary_max: r.annualSalaryMax ?? null,
    currency: r.salaryCurrency || '',
    job_type: mapType(Array.isArray(r.jobType) ? r.jobType[0] : r.jobType),
    category: (r.jobIndustry || [])[0] || '',
    url: r.url || '',
    posted: ts(r.pubDate),
  }));
}

/* ---------------- Findwork ---------------- */
async function findwork(env, q) {
  if (!env.FINDWORK_API_KEY) return [];
  const params = new URLSearchParams({ page: String(q.page || 1), sort_by: 'date' });
  if (q.what) params.set('search', q.what);
  if (q.where) params.set('location', q.where);
  const data = await getJSON(`https://findwork.dev/api/jobs/?${params}`, { headers: { Authorization: `Token ${env.FINDWORK_API_KEY}` } });
  return (data.results || []).map(r => ({
    external_id: String(r.id || r.url),
    source: 'findwork',
    title: r.role || '',
    company: r.company_name || '',
    description: clean(r.text),
    location: r.location || '',
    remote: !!r.remote,
    job_type: mapType(r.employment_type),
    category: (r.keywords || [])[0] || '',
    url: r.url || '',
    posted: ts(r.date_posted),
  }));
}

/* ---------------- Remotive ---------------- */
async function remotive(env, q) {
  if (env.REMOTIVE_ENABLED !== '1') return [];
  const params = new URLSearchParams({ limit: String(q.perPage || 50) });
  if (q.what) params.set('search', q.what);
  const data = await getJSON(`https://remotive.com/api/remote-jobs?${params}`);
  return (data.jobs || []).map(r => ({
    external_id: String(r.id || r.url),
    source: 'remotive',
    title: r.title || '',
    company: r.company_name || '',
    description: clean(r.description),
    location: r.candidate_required_location || 'Remote',
    remote: true,
    salary: r.salary || '',
    job_type: mapType(r.job_type),
    category: r.category || '',
    url: r.url || '',
    posted: ts(r.publication_date),
  }));
}

export const CONNECTORS = [
  { slug: 'remotive', fn: remotive },
  { slug: 'adzuna', fn: adzuna },
  { slug: 'jooble', fn: jooble },
  { slug: 'usajobs', fn: usajobs },
  { slug: 'reed', fn: reed },
  { slug: 'muse', fn: muse },
  { slug: 'arbeitnow', fn: arbeitnow },
  { slug: 'jobicy', fn: jobicy },
  { slug: 'findwork', fn: findwork },
];

export function normalize(job) {
  return {
    external_id: '', source: '', title: '', company: '', description: '',
    location: '', country: '', salary: '', salary_min: null, salary_max: null,
    currency: '', job_type: '', category: '', remote: false,
    latitude: null, longitude: null, url: '', posted: Math.floor(Date.now() / 1000),
    ...job,
  };
}
