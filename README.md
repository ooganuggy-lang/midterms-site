# 2026 Midterms Tracker — deploy on Render

This repo has everything needed for two Render services:
- `backend/` — Node/Express API that fetches live candidate data from the FEC
- `frontend/index.html` — the dashboard (map + tables) that calls the backend

## 1. Push this to GitHub

```bash
cd this-folder
git init
git add .
git commit -m "Initial commit"
```
Create a new empty repo on GitHub, then:
```bash
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

## 2. Deploy both services at once with a Render Blueprint

1. In the Render dashboard, click **New +** → **Blueprint**.
2. Connect the GitHub repo you just pushed. Render will detect `render.yaml`
   automatically and show you both services (`midterms-backend`,
   `midterms-frontend`).
3. When prompted for `FEC_API_KEY`, paste your free key from
   https://api.data.gov/signup/ (or leave it and edit later in the
   `midterms-backend` service's Environment tab).
4. Click **Apply** / **Deploy**. Render builds and deploys both services.

## 3. Connect the frontend to the backend (one manual step)

Static sites on Render are just files — they can't read environment
variables at runtime, so you need to point the frontend at the backend's
real URL once it exists:

1. Once `midterms-backend` finishes deploying, copy its URL from the Render
   dashboard (looks like `https://midterms-backend-xxxx.onrender.com`).
2. Open `frontend/index.html` in your editor, find this line near the top
   of the `<script>` block:
   ```js
   const API_BASE = "http://localhost:3001";
   ```
   and change it to your backend's URL, e.g.:
   ```js
   const API_BASE = "https://midterms-backend-xxxx.onrender.com";
   ```
3. Commit and push:
   ```bash
   git add frontend/index.html
   git commit -m "Point frontend at deployed backend"
   git push
   ```
   Render auto-redeploys `midterms-frontend` on push.

## 4. Visit your site

Render gives `midterms-frontend` its own URL, e.g.
`https://midterms-frontend-xxxx.onrender.com` — that's your live site.
You can rename either service or attach a custom domain from its Settings
tab in the Render dashboard.

## Notes on Render's free tier

- Free **web services** (the backend) spin down after ~15 minutes of no
  traffic. The first request after idling can take 30–60 seconds to wake
  back up — normal, not a bug. Later clicks are fast again.
- Free **static sites** don't sleep and are served from Render's CDN.
- If you outgrow the free tier's cold starts, Render's cheapest paid web
  service tier keeps the backend always warm.
