require('dotenv').config();
const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// Manually-maintained list of candidate_ids confirmed to have lost their
// primary. Reloaded from disk on every request (cheap, tiny file) so you
// can update config/excluded-candidates.json without restarting the server.
const EXCLUDED_PATH = path.join(__dirname, 'config', 'excluded-candidates.json');
function getExcludedIds() {
  try {
    const raw = fs.readFileSync(EXCLUDED_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return new Set(parsed.excluded_candidate_ids || []);
  } catch (err) {
    console.warn('Could not read excluded-candidates.json:', err.message);
    return new Set();
  }
}

const FEC_API_KEY = process.env.FEC_API_KEY || 'DEMO_KEY';
const FEC_BASE = 'https://api.open.fec.gov/v1';
const CYCLE = process.env.ELECTION_CYCLE || '2026';

const VOTEHUB_BASE = 'https://api.votehub.com';

const STATE_NAMES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',
  CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',
  IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',
  ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',
  MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',
  NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',
  NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',
  PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',
  TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',
  WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming'
};

// Cache FEC responses for 6 hours so we don't hammer the (rate-limited) API
// on every click, and so the site stays fast.
const cache = new NodeCache({ stdTTL: 60 * 60 * 6 });

async function fecFetch(path, params = {}) {
  const url = new URL(FEC_BASE + path);
  url.searchParams.set('api_key', FEC_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const cacheKey = url.toString();
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`FEC API ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  cache.set(cacheKey, data);
  return data;
}

// VoteHub is a free, public polling-aggregation API (no key required).
// https://votehub.com/polls/api/ — CC BY 4.0 licensed.
async function votehubFetch(path, params = {}) {
  const url = new URL(VOTEHUB_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const cacheKey = 'votehub:' + url.toString();
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`VoteHub API ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  cache.set(cacheKey, data);
  return data;
}

function simplifyCandidate(c) {
  return {
    candidate_id: c.candidate_id,
    name: c.name,
    party: c.party,
    party_full: c.party_full,
    incumbent_challenge: c.incumbent_challenge_full,
    office: c.office_full,
    state: c.state,
    district: c.district,
    status: c.candidate_status,
    election_years: c.election_years,
  };
}

// Best-effort: attach fundraising totals per candidate. If the FEC totals
// endpoint fails or rate-limits for a given candidate, we just omit their
// financials rather than failing the whole request.
async function attachFinancials(candidates) {
  return Promise.all(
    candidates.map(async (c) => {
      try {
        const totals = await fecFetch(`/candidate/${c.candidate_id}/totals/`, {
          cycle: CYCLE,
        });
        const t = totals.results && totals.results[0];
        return {
          ...c,
          financials: t
            ? {
                receipts: t.receipts,
                disbursements: t.disbursements,
                cash_on_hand: t.cash_on_hand_end_period,
                coverage_end_date: t.coverage_end_date,
              }
            : null,
        };
      } catch (err) {
        return { ...c, financials: null, financials_error: err.message };
      }
    })
  );
}

// Fetch VoteHub polls for a race and compute a simple average share per
// party from the most recent polls, then attach that number to each
// candidate whose party matches. This only meaningfully ranks candidates
// once primary losers have been filtered out (see excludeConfirmedLosers) —
// with a full primary field still in the data, several same-party
// candidates would incorrectly share one polling number.
async function attachPolling(candidates, votehubParams) {
  let polls = [];
  try {
    const data = await votehubFetch('/polls', votehubParams);
    polls = Array.isArray(data) ? data : [];
  } catch (err) {
    return candidates.map((c) => ({ ...c, polling: null, polling_error: err.message }));
  }

  if (polls.length === 0) {
    return candidates.map((c) => ({ ...c, polling: null }));
  }

  // Most recent 5 polls, most recent first.
  const recent = [...polls]
    .sort((a, b) => new Date(b.end_date || b.created_at) - new Date(a.end_date || a.created_at))
    .slice(0, 5);

  const partyTotals = {}; // { DEM: {sum, n}, REP: {sum, n} }
  for (const poll of recent) {
    for (const answer of poll.answers || []) {
      const key = normalizeParty(answer.choice);
      if (!key) continue;
      if (!partyTotals[key]) partyTotals[key] = { sum: 0, n: 0 };
      partyTotals[key].sum += answer.pct;
      partyTotals[key].n += 1;
    }
  }
  const partyAverages = {};
  for (const [party, { sum, n }] of Object.entries(partyTotals)) {
    partyAverages[party] = Math.round((sum / n) * 10) / 10;
  }

  return candidates.map((c) => {
    const key = normalizeParty(c.party);
    const avg = key && partyAverages[key] !== undefined ? partyAverages[key] : null;
    return {
      ...c,
      polling: avg !== null ? { avg_pct: avg, based_on_polls: recent.length } : null,
    };
  });
}

// Poll "choice" labels and FEC party codes both need collapsing to a common
// key ("DEM"/"REP") since VoteHub uses labels like "Dem"/"Democrat" and FEC
// uses "DEM".
function normalizeParty(label) {
  if (!label) return null;
  const l = label.toUpperCase();
  if (l.startsWith('DEM')) return 'DEM';
  if (l.startsWith('REP')) return 'REP';
  return null;
}

function excludeConfirmedLosers(candidates) {
  const excluded = getExcludedIds();
  if (excluded.size === 0) return candidates;
  return candidates.filter((c) => !excluded.has(c.candidate_id));
}

// Sort by live polling average first (missing polling sinks to the bottom),
// then by fundraising as a fallback signal.
function rankCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const pa = a.polling ? a.polling.avg_pct : -1;
    const pb = b.polling ? b.polling.avg_pct : -1;
    if (pa !== pb) return pb - pa;
    const ra = a.financials ? a.financials.receipts || 0 : 0;
    const rb = b.financials ? b.financials.receipts || 0 : 0;
    return rb - ra;
  });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, cycle: CYCLE, using_demo_key: FEC_API_KEY === 'DEMO_KEY' });
});

// GET /api/senate/:state?financials=true|false
app.get('/api/senate/:state', async (req, res) => {
  const state = req.params.state.toUpperCase();
  const stateName = STATE_NAMES[state];
  const includeFinancials = req.query.financials !== 'false';
  try {
    const data = await fecFetch('/candidates/', {
      state,
      office: 'S',
      cycle: CYCLE,
      per_page: 50,
      sort: 'name',
    });
    let candidates = (data.results || []).map(simplifyCandidate);
    candidates = excludeConfirmedLosers(candidates);
    if (includeFinancials) candidates = await attachFinancials(candidates);
    if (stateName) {
      candidates = await attachPolling(candidates, {
        subject: `${CYCLE} ${stateName}`,
        poll_type: 'us-senator',
      });
    }
    candidates = rankCandidates(candidates);
    res.json({ state, office: 'Senate', cycle: CYCLE, count: candidates.length, candidates });
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch from FEC API', detail: err.message });
  }
});

// GET /api/house/:state?district=03&financials=true|false
// Omit ?district to get every House candidate filed in that state.
app.get('/api/house/:state', async (req, res) => {
  const state = req.params.state.toUpperCase();
  const district = req.query.district;
  const includeFinancials = req.query.financials !== 'false';
  try {
    const params = { state, office: 'H', cycle: CYCLE, per_page: 100, sort: 'name' };
    if (district) params.district = String(district).padStart(2, '0');
    const data = await fecFetch('/candidates/', params);
    let candidates = (data.results || []).map(simplifyCandidate);
    candidates = excludeConfirmedLosers(candidates);
    if (includeFinancials) candidates = await attachFinancials(candidates);
    if (district) {
      candidates = await attachPolling(candidates, {
        subject: `${CYCLE} ${state}-${String(district).padStart(2, '0')}`,
        poll_type: 'us-representative',
      });
    }
    candidates = rankCandidates(candidates);
    res.json({
      state,
      office: 'House',
      district: district || 'all',
      cycle: CYCLE,
      count: candidates.length,
      candidates,
    });
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch from FEC API', detail: err.message });
  }
});

// GET /api/polls/senate/:state — live polls for that state's 2026 Senate race
// via VoteHub. Subject format per VoteHub's /subjects endpoint is
// "2026 <Full State Name>", e.g. "2026 Georgia".
app.get('/api/polls/senate/:state', async (req, res) => {
  const stateAbbr = req.params.state.toUpperCase();
  const stateName = STATE_NAMES[stateAbbr];
  if (!stateName) return res.status(404).json({ error: 'Unknown state' });
  const subject = `${CYCLE} ${stateName}`;
  try {
    const polls = await votehubFetch('/polls', { subject, poll_type: 'us-senator' });
    res.json({ state: stateAbbr, subject, poll_type: 'us-senator', count: Array.isArray(polls) ? polls.length : 0, polls });
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch from VoteHub API', detail: err.message });
  }
});

// GET /api/polls/house/:state/:district — live polls for a House district
// via VoteHub. Subject format is "2026 <STATE>-<DD>", e.g. "2026 AZ-06".
app.get('/api/polls/house/:state/:district', async (req, res) => {
  const stateAbbr = req.params.state.toUpperCase();
  const district = String(req.params.district).padStart(2, '0');
  const subject = `${CYCLE} ${stateAbbr}-${district}`;
  try {
    const polls = await votehubFetch('/polls', { subject, poll_type: 'us-representative' });
    res.json({ state: stateAbbr, district, subject, poll_type: 'us-representative', count: Array.isArray(polls) ? polls.length : 0, polls });
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch from VoteHub API', detail: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Election backend listening on port ${PORT} (cycle ${CYCLE})`));
