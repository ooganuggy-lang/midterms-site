require('dotenv').config();
const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');

const app = express();
app.use(cors());

const FEC_API_KEY = process.env.FEC_API_KEY || 'DEMO_KEY';
const FEC_BASE = 'https://api.open.fec.gov/v1';
const CYCLE = process.env.ELECTION_CYCLE || '2026';

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

app.get('/api/health', (req, res) => {
  res.json({ ok: true, cycle: CYCLE, using_demo_key: FEC_API_KEY === 'DEMO_KEY' });
});

// GET /api/senate/:state?financials=true|false
app.get('/api/senate/:state', async (req, res) => {
  const state = req.params.state.toUpperCase();
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
    if (includeFinancials) candidates = await attachFinancials(candidates);
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
    if (includeFinancials) candidates = await attachFinancials(candidates);
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Election backend listening on port ${PORT} (cycle ${CYCLE})`));
