# Steenberg Stocktake Tool

AI-powered shelf photo analyser for Steenberg Veterinary Clinic.

## Setup

**1. Create a new Next.js project (if you don't have one)**
```bash
npx create-next-app@latest steenberg-stocktake --typescript --tailwind --app
cd steenberg-stocktake
```

**2. Drop in the files from this folder**
- `app/api/claude/route.ts` → proxy route for Anthropic API
- `app/stocktake/page.tsx` → the stocktake UI

**3. Add your API key**
```bash
cp .env.local.example .env.local
```
Then edit `.env.local` and replace `your_api_key_here` with your key from https://console.anthropic.com

**4. Run locally**
```bash
npm run dev
```
Open http://localhost:3000/stocktake

---

## Deploy to Vercel

**1. Push to GitHub**
```bash
git init && git add . && git commit -m "init"
gh repo create steenberg-stocktake --private --push
```

**2. Import in Vercel**
- Go to https://vercel.com/new
- Import your repo
- Under Environment Variables, add: `ANTHROPIC_API_KEY` = your key
- Click Deploy

Your app will be live at `https://steenberg-stocktake.vercel.app/stocktake`

---

## Usage

1. Upload one or more shelf photos (drag & drop or click)
2. Click **Analyse photos**
3. Review and edit the results table inline
4. Click **Export CSV** to download for Lupa import

---

## Notes

- Each photo is analysed independently; results accumulate in one table per session
- The Confidence column flags items to double-check (Low = verify manually)
- Flags section lists anything the model was uncertain about
- Session data is not saved — export before closing the tab
