# Noah — corrections and additions to your Duda capability assessment

Your audit was accurate about the visual editor: Duda's API does not expose drag-and-drop layout, and that will not change. But three of the five limitations you listed are narrower than you reported, and the ChurchWeb templates are being set up so that the rest do not matter for a standard build. Update your memory with the following.

## 1. You CAN set site-wide colours and fonts

`get_site_theme` and `update_site_theme` are on the Duda connection. They control the site's colour palette and font families globally. Use them to apply each church's brand colours and typography after duplicating the template. Do not tell a client that colours and fonts are off-limits — only per-element styling is.

Order of operations on a new site: duplicate template → `update_site_theme` → content → images → SEO → publish.

## 2. Custom CSS and scripts go through inject IDs

The templates carry hidden HTML widgets with fixed inject IDs. Use `inject content` on them:

- `custom-css` — inject a `<style>…</style>` block. This is how you change the styling of any specific element (a button, a section background, spacing). Target elements by the class or ID visible in the site's HTML.
- `custom-head` — inject third-party embeds and tags: Planning Center, Tithe.ly / giving widgets, analytics, chat.

Keep injected CSS small and scoped; write comments in it saying what it is for, because it is the only per-site styling that exists and the next person to read it will be you.

If a site was built from an older template and one of these IDs is missing, say so and stop — do not improvise a different location.

## 3. Sermons, events and staff are collections, not pages

The templates include dynamic pages already bound to collections. Never try to create a dynamic page yourself — add and update **rows** with the collection tools (`get_collections`, `create_collection_rows`, `update_collection_rows`, `delete_collection_rows`). A church adding a sermon is you adding a row, not you editing a page.

Standard collection names in every ChurchWeb template: `sermons`, `events`, `staff`, `ministries`. Check with `get_collections` before writing; if a template variant lacks one, report it rather than creating a differently named collection.

## 4. Content slots have inject IDs too

Every editable text and image slot in the templates has an inject ID following the pattern `<page>-<section>-<element>`, for example `home-hero-heading`, `home-hero-image`, `about-pastor-photo`, `about-pastor-bio`, `contact-service-times`. Business name, address, phone, email, hours and social links come from the **content library** and are bound in the template — set them once with the content library tools and every page updates.

Do not inject into a location you have not confirmed exists on that site. When unsure, read the page and list the IDs first.

## 5. Layout changes mean choosing a different template, not editing this one

If a church wants a different structure, pick the closest ChurchWeb template variant and rebuild from it. Do not attempt layout changes through the API, and do not promise them. Tell the client which variants exist and what differs between them. Anything genuinely bespoke is a human task — flag it to Ryan rather than working around it.

## 6. Multilingual

Per-language content is a Duda API feature that this connection does not expose yet. If a church needs a second language, note it as a follow-up for Ryan; do not attempt it via page duplication.

## What this means for your standard build

Your 12-minute estimate stands. The sequence is: duplicate template → theme → content library (business details, socials) → page text via inject IDs → images (upload, then inject) → collection rows → SEO titles/descriptions → `custom-head` embeds if any → client account and permissions → publish. Report what you did, and list anything you could not do with the specific reason from the tool result, never a guessed one.
