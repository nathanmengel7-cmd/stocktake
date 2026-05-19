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
Then edit `.env.local` and paste your Anthropic API key as the value for `ANTHROPIC_API_KEY` (see https://console.anthropic.com).

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
2. Choose **Scan mode** (general, dry bags, canned, or pills) so the analyser uses instructions matched to what you are photographing
3. Click **Analyse photos**
4. Review and edit the results table inline; each photo card shows which scan mode was used for that image
5. Click **Export CSV** to download for Lupa import

### Scan modes

- **General / mixed shelves** — default rules for mixed stock
- **Dry food (bags)** — emphasises separate vertical tiers, pack weights, flavours, and life-stage (puppy/adult/senior)
- **Canned / wet food** — grid counting (height × depth) for uniform stacks, exact product-line labels, and flags for irregular or edge stacks
- **Pills / small items** — tray counts only; does not use the bottle’s printed quantity as the tray count

Your last selected mode is remembered in the browser for the next visit.

---

## Notes

- CSV exports include **Brand**, **Size**, and **Scan mode** columns (after Product name) for filtering and Lupa import
- Each photo is analysed independently; results accumulate in one table per session
- The Confidence column flags items to double-check (Low = verify manually)
- Flags section lists anything the model was uncertain about
- Session data is not saved — export before closing the tab
