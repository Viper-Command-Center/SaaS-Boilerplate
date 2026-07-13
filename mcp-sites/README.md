# mcp-sites — website-update MCP server

Lets the Command Center agent read and edit the GitHub repos behind the
Railway-hosted sites (BudgetSmart marketing, WellnessTrove, ChurchWebGlobal…).
Every edit is a commit to the site's deploy branch — Railway auto-deploys it.
This replaces the OpenClaw agent's job. WordPress sites: use the WordPress MCP
instead.

Tools: `list_sites`, `list_files`, `read_file`, `update_file`, `create_file`,
`recent_commits`. Zero npm dependencies (`node server.mjs`).

## Deploy on Railway (one-time, ~5 minutes)

1. ArtivioAI project → **Add → GitHub repo → Viper-Command-Center/SaaS-Boilerplate**
   (yes, same repo — it becomes a second service).
2. Service Settings → **Root Directory = `mcp-sites`**. Start command auto-detects
   (`npm start`). Generate a Railway domain for it (Settings → Networking →
   Generate Domain).
3. Variables:
   - `MCP_API_KEY` — random string, e.g. `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
   - `GITHUB_TOKEN` — fine-grained PAT (github.com → Settings → Developer settings
     → Fine-grained tokens): Resource owner = Viper-Command-Center (and/or the
     account owning the site repos), Repository access = just the site repos,
     Permissions → **Contents: Read and write**.
   - `SITES` — e.g.
     ```json
     {"budgetsmart-web":{"owner":"Viper-Command-Center","repo":"web","branch":"main","label":"BudgetSmart marketing site"}}
     ```
4. Health check: open `https://<service-domain>/health` → `{"ok":true,...}`.

## Connect it to the Command Center

Dashboard → Tools panel → Add MCP server:
- Name: `sites`
- URL: `https://<service-domain>/`
- Auth header: `Authorization` · value: `Bearer <MCP_API_KEY>`

All tools default to **approval** — every site edit lands in the Approvals
inbox before it commits. Promote `list_sites`/`list_files`/`read_file`/
`recent_commits` to `auto` via PATCH toolPolicy when trusted.

## Safety

Bearer-key auth · path traversal + `.git`/workflow paths blocked · 400 KB file
limit · commits attributed "via Artivio Command Center" · approvals gateway in
the platform gates writes by default.
