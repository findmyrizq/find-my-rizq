// Find My Rizq — halal / unwanted-job exclusion filter
//
// Returns a reason string if a job should be excluded, or null if allowed.
// Config comes from env (set as Worker vars / secrets) so you can tune it
// without redeploying code logic.

export const GROUPS = {
  alcohol: {
    label: 'Alcohol (pubs, bars, breweries, wine, spirits)',
    terms: ['bartender','brewery','brewer','winery','sommelier','pub ','public house','bar staff','bar manager','cocktail','distillery','off licence','off-licence','liquor','wine merchant','beer','alcohol','nightclub','mixologist','wine ','spirits ','vineyard'],
    except: [],
  },
  gambling: {
    label: 'Gambling (casinos, betting, lottery)',
    terms: ['casino','gambling','betting','bookmaker','bookmakers','croupier','poker','bingo','lottery','wagering','sportsbook','slot machine','igaming','i-gaming'],
    except: [],
  },
  riba_banking: {
    label: 'Interest-based banking & finance (riba)',
    terms: ['bank teller','retail bank','investment bank','mortgage advisor','mortgage adviser','loan officer','payday loan','interest rate','credit underwriter','usury','pawnbroker','money lender','moneylender'],
    except: ['islamic bank','islamic finance','sharia','shariah','takaful','halal investment'],
  },
  adult: {
    label: 'Adult / nudity / explicit content',
    terms: ['adult entertainment','stripper','exotic dancer','escort','cam model','webcam model','gentlemen\'s club','lingerie model','glamour model','pornograph','xxx','erotic','massage parlour'],
    except: [],
  },
  non_halal_food: {
    label: 'Pork & non-halal food handling',
    terms: ['pork','bacon','ham processing','pig farm','piggery','abattoir','slaughterhouse','butcher','charcuterie'],
    except: ['halal'],
  },
  tobacco: {
    label: 'Tobacco, vaping & cannabis',
    terms: ['tobacco','cigarette','vape','vaping','e-cigarette','cannabis','dispensary','shisha'],
    except: [],
  },
};

function splitTerms(raw) {
  return String(raw || '')
    .split(/[\n,]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function wordMatch(haystack, term) {
  term = term.trim();
  if (!term) return false;
  if (term.includes(' ')) return haystack.includes(term);
  // word boundary for single words so "bar" doesn't hit "barista"
  return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'u').test(haystack);
}

export function buildFilterConfig(env) {
  const enabled = env.EXCLUSION_GROUPS
    ? splitTerms(env.EXCLUSION_GROUPS).map(s => s.replace(/ /g, '_'))
    : Object.keys(GROUPS);
  return {
    groups: enabled,
    block: splitTerms(env.EXCLUDE_KEYWORDS),
    allow: splitTerms(env.ALLOW_KEYWORDS),
    blockCategories: splitTerms(env.EXCLUDE_CATEGORIES),
  };
}

export function shouldExclude(job, cfg) {
  const title = (job.title || '').toLowerCase();
  const company = (job.company || '').toLowerCase();
  const category = (job.category || '').toLowerCase();
  const desc = (job.description || '').toLowerCase().slice(0, 600);

  const primary = `${title} ${company} ${category}`;
  const full = `${primary} ${desc}`;

  const hasAny = (hay, arr) => arr.some(n => n && hay.includes(n));

  // 1. blocked source categories
  for (const exc of cfg.blockCategories) {
    if (exc && category.includes(exc) && !hasAny(full, cfg.allow)) return `category:${exc}`;
  }

  // 2. built-in groups
  for (const key of cfg.groups) {
    const group = GROUPS[key];
    if (!group) continue;
    const exceptions = [...cfg.allow, ...group.except.map(s => s.toLowerCase())];
    if (hasAny(full, exceptions)) continue;
    for (const term of group.terms) {
      const t = term.toLowerCase();
      if (wordMatch(primary, t) || wordMatch(desc, t)) return `group:${key}:${t.trim()}`;
    }
  }

  // 3. custom block terms
  if (!hasAny(full, cfg.allow)) {
    for (const term of cfg.block) {
      if (wordMatch(full, term)) return `custom:${term}`;
    }
  }

  return null;
}
