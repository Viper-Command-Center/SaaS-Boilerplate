# mcp-browser — built-in web browsing for the Command Center

Gives every workspace agent JS-rendered browsing at flat compute cost
(~$5–10/mo total) instead of per-session cloud-browser pricing. Premium
options (Firecrawl, Browserbase, Hyperbrowser MCPs) remain per-workspace
add-ons in the Tools panel for heavier scraping or bot-protected sites.

Tools: `browse_page` (title + readable text + links), `get_page_html`,
`scrape_page` (CSS selectors). Zero npm dependencies.

## Deploy on Railway (two services, ~10 minutes)

### 1. Browserless (the actual browser — keep it PRIVATE)
- ArtivioAI project → **Add → Docker Image** → `ghcr.io/browserless/chromium`
- Variables: `TOKEN` = a random string (this is the Browserless auth token)
- Do NOT generate a public domain — it's reached over private networking.
- Note its private hostname (Settings → Networking → Private), e.g.
  `browserless.railway.internal`, port 3000.

### 2. mcp-browser (this wrapper)
- **Add → GitHub repo → Viper-Command-Center/SaaS-Boilerplate**,
  Settings → **Root Directory = `mcp-browser`**, generate a public domain.
- Variables:
  - `MCP_API_KEY` — random string for clients
  - `BROWSERLESS_URL` — `http://browserless.railway.internal:3000` (match the
    private hostname from step 1)
  - `BROWSERLESS_TOKEN` — same value as the `TOKEN` on the Browserless service
- Health check: `https://<domain>/health` → `{"ok":true,"backend":true}`

## Connect in the Command Center

Tools panel → Add MCP server: name `browser`, URL `https://<domain>/`,
header `Authorization` = `Bearer <MCP_API_KEY>`. Browsing tools are read-only —
safe to set to `auto` policy so the agent can research without approvals.

## Notes

- SSRF-guarded (no internal/private addresses), 40 KB text cap per page.
- Datacenter IPs: heavily bot-protected sites may block; recommend Firecrawl
  MCP per workspace when that matters.
