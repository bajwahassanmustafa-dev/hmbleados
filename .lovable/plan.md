# Online Lead Search

A new page that researches the live internet for businesses in a niche + location, and flags the ones that have no real website of their own — the best prospects for web-development work.

## What the user does

1. Opens **Online Search** in the left menu.
2. Enters: business type / niche, location, and (optionally) a minimum and maximum number of leads.
3. Presses **Start Search**. A progress line shows what is being researched right now (map listings, web results, social pages).
4. Results appear in a fast, compact list. Each result shows:
   - Business name, category, city/location
   - Phone and email when they are published somewhere public
   - Social profile links (Instagram, Facebook, LinkedIn, TikTok, X, YouTube)
   - Google/Maps profile link
   - **Website status** badge: No Website Found · Social Only · Directory Only · Website Found · Uncertain
   - **Evidence**: the short reason for that status plus every source link found, each openable in a new tab
5. Filters across the top: location, category, website status, has-social, lead quality. Sorting by relevance (prospect value first) or by name.
6. **Search Again / Expand Search** runs further rounds with broader and nearby queries, adding only businesses not already found.
7. **Import Selected** saves the chosen results into the existing Leads table, so they flow into AI analysis and outreach as usual.

Prospect ordering puts "No Website Found" and "Social Only" first, then businesses that look active (reviews, ratings, a live social presence).

## Where the data comes from

- **Google Maps Platform** (already connected): real businesses for the niche and area, with phone, address, rating, review count and the website field Google holds.
- **Firecrawl** (needs connecting): live web search over search engines, directories and public social platforms, plus page fetching to read published contact details. This is the piece that finds businesses with no map listing and confirms social-only presences.
- **Existing website lookup**: for any candidate domain, the app already visits the page and pulls published email and social links; that is reused here.

If Firecrawl is not connected, the page says "Not configured" and points to the Settings → Lead Source section; nothing is faked, and map-only search still works.

## How website status is decided

Every URL found for a business is classified by a rules table, not by guesswork:

- Social platform hosts (instagram.com, facebook.com, tiktok.com, linkedin.com, x.com, youtube.com) → social profile
- Link-in-bio and card hosts (linktr.ee, beacons.ai, bio.link, carrd.co, msha.ke …) → link page, not a website
- Directory and marketplace hosts (yelp, yellowpages, tripadvisor, thumbtack, justdial, amazon, etsy, ebay …) → directory listing
- Booking and profile platforms (booksy, fresha, square.site, calendly, opentable, doordash, ubereats …) → booking profile
- Google-hosted pages (business.site, sites.google.com, g.page) → Google-hosted page, treated as not a standalone site
- Anything else that resolves to a live page whose content matches the business → standalone website

Resulting status:
- **Website Found** — a live standalone domain
- **Social Only** — only social profiles, no standalone domain
- **Directory Only** — only directory/marketplace/booking listings
- **No Website Found** — nothing but the map listing / a phone number
- **Uncertain** — a candidate domain exists but could not be reached or does not clearly belong to this business

The evidence stored with each lead lists each URL, what it was classified as, and why.

Nothing is invented: a field stays empty when no public source published it, and every populated field carries the source URL it came from.

## Deduplication

Businesses found through different sources merge into one record, matched in this order: same Google place id → same website domain → same normalised phone number → very similar name in the same city. Merging keeps the first non-empty value per field and unions all sources and social links.

## Technical notes

- New table `search_runs` (id, user_id, niche, location, min/max, status, counts, created_at) and `search_results` (id, run_id, user_id, merged business fields, website_status, evidence jsonb, sources jsonb, social_links jsonb, quality score, imported_lead_id, created_at). RLS own-rows plus GRANTs; results persist so a run can be reopened and expanded.
- New `src/lib/online-search.server.ts`: query planner (map query, directory queries, `site:instagram.com` style social queries), Firecrawl search via the connector gateway, candidate extraction, host classifier, merger, quality scoring. Pure functions kept separate so they are unit-testable.
- New `src/lib/online-search.functions.ts`: `startOnlineSearch`, `runSearchStage` (client drives stages in small batches so progress is visible and no request runs long), `expandSearch`, `listSearchResults`, `importSearchResults`, `getOnlineSearchStatus`.
- Firecrawl calls go through `https://connector-gateway.lovable.dev/firecrawl` with the workspace key server-side only; errors surface the provider status and body.
- AI is used only for a narrow judgement — "does this page belong to this business" — with the existing provider abstraction, and never to produce contact facts.
- New route `src/routes/_authenticated/online-search.tsx` plus nav entry; plain table UI, no charts.

## Sequence

1. Connect Firecrawl (a connect card will appear).
2. Database tables and grants.
3. Search engine server library + classifier.
4. Server functions with staged progress.
5. Page, filters, sorting, evidence panel, expand search, import to Leads.
6. End-to-end run against a real niche and location.
