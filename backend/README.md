# 2026 Midterms — Live Candidate Backend

A small Express API that fetches **real, official candidate filing data**
from the [FEC's public API](https://api.open.fec.gov/developers/) for U.S.
Senate and House races — who's actually running, their party, and (best
effort) their campaign fundraising totals.

**What this is NOT:** a live polling feed. There's no free, public API for
polling averages that covers every Senate/House race — that data is either
paywalled (Cook Political, RealClearPolitics) or not offered as an API at
all. The candidate/finance data below is real and live; poll numbers still
need to be entered manually (see the frontend's static dataset).

## What it does

- `GET /api/health` — sanity check
- `GET /api/senate/:state` — all candidates filed for that state's 2026 Senate race
  - e.g. `/api/senate/GA`
- `GET /api/house/:state` — all House candidates filed in that state
  - optional `?district=03` to filter to one district
  - e.g. `/api/house/NY?district=03`
- Both accept `?financials=false` to skip fundraising totals and respond faster
- `GET /api/polls/senate/:state` — live polls for that state's 2026 Senate race,
  from [VoteHub](https://votehub.com/polls/api/) (free, public, CC BY 4.0)
  - e.g. `/api/polls/senate/GA`
- `GET /api/polls/house/:state/:district` — live polls for a House district
  - e.g. `/api/polls/house/AZ/6`

> **Note on VoteHub filtering:** VoteHub's `/polls` endpoint accepts `subject`
> and `poll_type` query params to filter results (documented at the link
> above, subjects like `"2026 Georgia"` for Senate or `"2026 AZ-06"` for
> House — confirmed real via their `/subjects` endpoint). When testing this
> from the sandboxed environment used to build this code, query-string
> filtering did not appear to narrow results — but that sandbox could only
> reach the internet through a caching fetch tool that may have stripped
> query strings before hitting VoteHub's servers, not necessarily a problem
> with VoteHub itself. Test `/api/polls/senate/GA` for yourself once
> deployed (or locally with `curl`) and confirm you get Georgia Senate polls
> back, not an unfiltered dump of every poll in their database. If it's
> unfiltered, open an issue with VoteHub or filter client-side by checking
> each poll's `subject` field against the expected value.

Responses look like:

```json
{
  "state": "GA",
  "office": "Senate",
  "cycle": "2026",
  "count": 4,
  "candidates": [
    {
      "candidate_id": "S0GA00...",
      "name": "OSSOFF, JON",
      "party": "DEM",
      "party_full": "Democratic Party",
      "incumbent_challenge": "Incumbent",
      "office": "Senate",
      "state": "GA",
      "district": "00",
      "status": "C",
      "financials": {
        "receipts": 12345678,
        "disbursements": 4567890,
        "cash_on_hand": 8901234,
        "coverage_end_date": "2026-06-30"
      }
    }
  ]
}
```

Responses are cached in memory for 6 hours per query, so repeat clicks on
the same state don't re-hit the FEC API (which is rate-limited, especially
on the free `DEMO_KEY`).

## Run it locally

```bash
npm install
cp .env.example .env
# edit .env and add your free FEC API key (see below)
npm start
```

Then test: `curl http://localhost:3001/api/senate/GA`

**Get a free FEC API key** (recommended — the shared `DEMO_KEY` is limited
to ~30 requests/hour across everyone using it):
1. Go to https://api.data.gov/signup/
2. Enter your email, check your inbox for the key
3. Put it in `.env` as `FEC_API_KEY=your_key_here`

> **Note on testing:** this code was written and syntax/logic-tested in a
> sandboxed environment that could not reach `api.open.fec.gov` (network
> egress there is restricted to package registries only). The server
> starts correctly and error-handles failed FEC calls gracefully — but you
> should do one real end-to-end test locally with your API key before
> deploying, to confirm the live FEC response shape matches expectations.

## Ranking candidates & excluding primary losers

`/api/senate/:state` and `/api/house/:state?district=` now do two extra
things before returning candidates:

1. **Rank by live polling.** If VoteHub has polls for the race, candidates
   are sorted by their party's average share across the 5 most recent polls
   (falls back to fundraising if no polls exist yet). This only produces a
   meaningful order once a race is down to its general-election candidates —
   with multiple same-party primary candidates still in the list, they'd all
   incorrectly show the same party-level polling number.

2. **Exclude confirmed primary losers.** There is no free, live API (FEC or
   otherwise) that reports actual primary election *results* — FEC's
   candidate data only reflects who has filed and raised money, not who won.
   So this can't be automated safely. Instead, `config/excluded-candidates.json`
   is a small file you maintain by hand:
   ```json
   { "excluded_candidate_ids": ["S2GA00123", "H2AZ06045"] }
   ```
   Find a candidate's `candidate_id` in the API response, confirm they lost
   their primary from an official source (your state's Secretary of State
   election-results page, the AP, or Ballotpedia), then add the ID here.
   Changes take effect on the next request — no restart needed.

## Deploy it (Render, free tier)

1. Push this `backend/` folder to a GitHub repo.
2. Go to https://render.com → New → Web Service → connect your repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Add environment variables in the Render dashboard: `FEC_API_KEY`,
   `ELECTION_CYCLE=2026`.
5. Deploy. Render gives you a URL like `https://your-app.onrender.com`.
6. Open the frontend HTML file, find the `API_BASE` constant near the top
   of the `<script>` block, and set it to that URL.

Railway, Fly.io, and Cloudflare Workers (with adaptation) work similarly.

## Limitations to know about

- FEC data reflects **who has officially filed** — for a handful of very
  early or very late-entering candidates it may lag reality by days.
- The `DEMO_KEY` is shared across every developer testing FEC's API
  worldwide and will get rate-limited fast under real traffic — get your
  own free key before sharing your site publicly.
- Fundraising totals are a reasonable proxy for race competitiveness but
  are not the same thing as polling — a big war chest doesn't guarantee a
  lead.
