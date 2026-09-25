# GAfix AI Summary — Deployment Guide

Two ready-to-deploy folders. Pick one.

---

## Option A: Vercel (recommended for speed)

**Folder:** `gafix-deploy-vercel/`

**What's inside:**
```
gafix-deploy-vercel/
├── api/
│   └── summarize.js      ← serverless function (holds your API key)
├── public/
│   └── index.html         ← the frontend (v4)
├── vercel.json            ← routing config
├── package.json
├── .gitignore
└── .env.example
```

### Steps

1. **Get your Anthropic API key**
   → https://console.anthropic.com/settings/keys
   → Create a key, copy it (starts with `sk-ant-`)

2. **Push the folder to GitHub**
   ```bash
   cd gafix-deploy-vercel
   git init
   git add .
   git commit -m "gafix ai summary"
   gh repo create gafix-ai-summary --private --push
   ```
   (or create the repo on github.com and push manually)

3. **Connect to Vercel**
   → Go to https://vercel.com/new
   → Import your GitHub repo
   → Vercel auto-detects the vercel.json config

4. **Add your API key**
   → In the Vercel deploy screen, expand "Environment Variables"
   → Add: `ANTHROPIC_API_KEY` = `sk-ant-api03-your-key-here`

5. **Deploy**
   → Click Deploy
   → Done. Your URL is `https://gafix-ai-summary.vercel.app` (or custom domain)

**Cost:** Vercel free tier = 100GB bandwidth, 100K function invocations/month. More than enough for a POC. Each summary call takes <10s.

---

## Option B: Render (recommended for simplicity)

**Folder:** `gafix-deploy-render/`

**What's inside:**
```
gafix-deploy-render/
├── public/
│   └── index.html         ← the frontend (v4)
├── server.js              ← Express server (API proxy + static files)
├── package.json
├── render.yaml            ← auto-config for Render
├── .gitignore
└── .env.example
```

### Steps

1. **Get your Anthropic API key**
   → https://console.anthropic.com/settings/keys

2. **Push the folder to GitHub**
   ```bash
   cd gafix-deploy-render
   git init
   git add .
   git commit -m "gafix ai summary"
   gh repo create gafix-ai-summary --private --push
   ```

3. **Create a Web Service on Render**
   → Go to https://dashboard.render.com/new/web-service
   → Connect your GitHub repo
   → Render reads `render.yaml` and auto-fills everything
   → Or manually set:
     - Build command: `npm install`
     - Start command: `npm start`
     - Plan: Free (spins down after 15 min idle) or Starter ($7/mo, always on)

4. **Add your API key**
   → In Render dashboard → your service → Environment
   → Add: `ANTHROPIC_API_KEY` = `sk-ant-api03-your-key-here`

5. **Deploy**
   → Click "Create Web Service"
   → Done. Your URL is `https://gafix-ai-summary.onrender.com`

**Cost:** Render free tier = 750 hours/month, spins down after idle (first request after sleep takes ~30s). Starter at $7/mo stays always-on.

---

## After deployment

- Share the URL with anyone — they can upload their own audit JSON and generate summaries
- Their files never leave their browser except as optimized data sent to your proxy
- Your API key is server-side only, never exposed to the browser
- Each summary costs ~$0.02-0.05 depending on how many tabs run

## Security notes

- **Never commit your .env file** — it's in .gitignore
- **Restrict CORS in production** — change `Access-Control-Allow-Origin: *` to your actual domain
- **Add auth if needed** — wrap the /api/summarize endpoint with your own auth middleware (API key, session, OAuth) so only your users can generate summaries on your dime

## Local testing

```bash
cd gafix-deploy-render  # or gafix-deploy-vercel
npm install
export ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
npm start               # Render: runs on localhost:3000
                        # Vercel: use `npx vercel dev` instead
```
Open http://localhost:3000 and test.
