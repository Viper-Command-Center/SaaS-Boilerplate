# True Therapy — workspace brief

Client facts for the True Therapy workspace. **How the tools behave is no longer written here** — that now travels with the plugins themselves (`BuiltinProvider.guidance`), so every workspace with the Elementor or WordPress connection enabled gets it automatically and it can never drift out of date in one workspace while being fixed in another.

Keep this file to things that are true about *this client*.

## The site

- **truetherapy.ca** — WordPress, Elementor 4.2.2 with Pro, Rank Math for SEO, LiteSpeed hosting.
- **Homepage is page id 51.** Built entirely with 3.x-compatible containers and widgets — no atomic/v4 elements, though v4 widgets are registered on the site. If anyone adds an `e-heading` or similar from the Elementor editor, the tree becomes mixed and is worth re-checking before writing.
- Practitioner: Sonia Dillon, RP. Services are 100% virtual across Canada; trauma therapy and EMDR.

## Who this site is for

The audience is often in distress and deciding whether to trust the practice within a few seconds of landing. **Warmth is not decoration here — it is what converts.**

Do not strip human phrasing to fit a keyword. Work the keyword into language a person would actually say: "Online Trauma Therapy for Adults Across Canada" carries the same search intent as a keyword string and still reads like a sentence.

When proposing copy, show the **exact sentences** before writing them, so what gets approved is the words rather than a plan.

## SEO positioning

- Focus keyword: `online trauma therapy Canada`.
- Supporting terms: EMDR, trauma therapist, virtual therapy, adults.
- Rank Math fields are set through the Elementor connection's `update_seo_meta`.

## Current state

Homepage H1, eyebrow label and subtitle were rewritten for SEO. Those writes went in **without a prior `get_page_tree` snapshot**, so there is no stored rollback for that specific change — take one before the next batch.

The H1 wraps such that "Canada" can land alone on the second line at some widths. Run `check_layout` before and after any fix so the result is measured rather than assumed.

## Access

The connection currently uses an Administrator Application Password (`hostinger`). That is broader than the integration needs — `edit_posts` is sufficient, so an Editor account is the safer resting state. Worth moving when convenient.
