// Find My Rizq — geocoding via OpenStreetMap Nominatim, cached in D1.
// Best-effort: returns {lat,lng} or null. Caches negatives too.

const UA = 'FindMyRizq/1.0 (+https://findmyrizq.com)';

export async function geocode(env, location) {
  const q = (location || '').trim().toLowerCase();
  if (!q || q === 'remote' || env.ENABLE_GEOCODING !== '1') return null;

  // cache lookup
  const cached = await env.DB.prepare('SELECT lat, lng, ok FROM geocache WHERE q = ?').bind(q).first();
  if (cached) return cached.ok ? { lat: cached.lat, lng: cached.lng } : null;

  let result = null;
  try {
    const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: location, format: 'json', limit: '1' })}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': UA } });
    if (res.ok) {
      const body = await res.json();
      if (body[0]?.lat && body[0]?.lon) result = { lat: +body[0].lat, lng: +body[0].lon };
    }
  } catch (_) { /* ignore, cache as miss */ }

  await env.DB.prepare('INSERT OR REPLACE INTO geocache (q, lat, lng, ok) VALUES (?, ?, ?, ?)')
    .bind(q, result?.lat ?? null, result?.lng ?? null, result ? 1 : 0).run();

  return result;
}
