# BudgetSmart — workspace brief

Standing context for the BudgetSmart workspace.

**How the tools behave is not written here.** That travels with the plugins themselves, so every workspace gets it automatically and it cannot drift out of date in one place while being fixed in another. This file is only for things true about *this* business.

## What changed recently

**DataForSEO is now available** — real search data for deciding what to write and how to rank: search volume, CPC, keyword difficulty, keyword ideas and long-tail suggestions, live Google SERPs, what a domain already ranks for, and its organic competitors. The order to use them in, and the traps, come with the plugin.

**The Notes panel is fully editable now.** Add rows, delete rows, and edit any cell directly in the dashboard — not just the `status` column. This applies to every table panel, not only Notes.

Two corrections that follow from that, because both were told to the owner as fact and neither was true:

- Adding rows was never a "platform limitation." It was an unfinished feature, and it has been finished. Do not describe it that way again.
- The blank-placeholder-rows workaround was worse than nothing: only a column literally named `status` was editable, so those rows could not be filled in at all. If any remain in the Notes table, delete them.

The general rule: **before telling the owner something is a platform limitation, say instead that you cannot do it and do not know why.** A genuine platform fault says so itself, in those words. Asserting a limit that turns out to be a missing feature costs more trust than admitting uncertainty.

## The business

- Primary domain: **budgetsmart.io**, with the product at **app.budgetsmart.io**.
- Traffic data: Cloudflare Web Analytics (near-realtime) and GA4 + Search Console (deeper funnel). Cloudflare for "what is happening now", GA4 for what actually converted.
- Deployed from a GitHub repo via Railway.

> **Owner: fill this in and the rest of the file gets much more useful.**
> - What BudgetSmart sells, in one sentence.
> - Who the customer is.
> - **Which country/market to target** — this one matters most. Every DataForSEO call takes a `location`, it defaults to the United States, and search volumes differ enormously by market. Planning Canadian content against US volumes plans against the wrong numbers.

Until that market is confirmed, **state the `location` you used** whenever you report keyword numbers, so a wrong assumption is visible rather than buried.

## Spending real money

DataForSEO is a Tier 1 plugin: it runs on the owner's own account and every call draws down a shared prepaid balance, metered to this workspace and billed at the platform markup. Calls are cheap — usually a fraction of a cent — but they are not free, and the balance is shared with every other client workspace.

So: research deliberately, not exhaustively. `serp_overview` costs more than the keyword tools, so run it on a shortlist of two or three, never on a list of thirty. Every response reports what it cost; if a research session is running long, say what has been spent so far rather than continuing silently.

## Reporting SEO numbers honestly

Search volume is Google's twelve-month monthly average, not live traffic. Difficulty is a 0–100 estimate, not a promise. Traffic and traffic-value figures for a domain are modelled from ranking positions, not measured — GA4 is the source for what actually happened.

Say which is which when reporting to the owner. A modelled estimate presented as measured traffic is the kind of number that gets repeated to a client and then has to be walked back.

## Before writing anything

Start from what already ranks. `ranked_keywords` on budgetsmart.io finds pages sitting at positions 5–20 — improving one of those is usually a cheaper win than a new article, because the page exists and only needs to get better. Check that before proposing a content calendar.
