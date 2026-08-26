# YHD NYE

A self-hosted, single-page info site for the **Yachthafenresidenz Hohe Düne** New Year's Eve work trip. Content — including photos and PDFs — is authored entirely in Notion; a small sync service renders it into static HTML styled as a faithful **Notion dark/light** page. Served by nginx behind Traefik.

Live: <https://yhd.olliecross.com>

## How it works

```text
Notion page ──(Notion API)──▶  sync service  ──renders + downloads──▶  site/  ──▶  nginx  ──▶  visitor
                               (Node, container)   (HTML + media)      (static)     (container)
```

- **`sync/`** — Node service. Every `SYNC_INTERVAL` seconds it pulls the Notion page and its databases via the official API, renders `site/index.html`, and downloads any image/PDF blocks into `site/media/` (HEIC is auto-converted to JPEG — browsers can't render it). A manifest keyed by block id + `last_edited_time` skips re-downloading unchanged files, so most syncs only touch text. Writes are atomic (temp file + rename), so a failed sync never breaks the live page.
- **`css/`, `js/`** — the design system (Notion dark + light themes) and page behavior (CSV/DB tables, table-of-contents, lightbox, theme toggle, welcome animation). No build step, no external dependencies at runtime.
- **`assets/`** — the one piece of media that *isn't* Notion-sourced: a deliberately chosen page cover (`titleimage.jpg`), committed like any other code asset.
- **`nginx/`** — hardened static file server config.
- **`deploy/`** — production-only Docker Compose override (Traefik labels, HSTS).

Synced from Notion: text, headings, lists, toggles, columns, colors, databases (including select/status option colors), and all image/PDF blocks.

## Requirements

- Docker + Docker Compose
- A Notion internal integration token, with the page shared to it

## Configuration

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

| Variable         | Description                                          | Default          |
| ---------------- | ----------------------------------------------------- | ----------------- |
| `NOTION_TOKEN`   | Notion internal integration token (`ntn_…`)           | — (required)      |
| `NOTION_PAGE_ID` | ID of the Notion page to render                       | the YHD NYE page  |
| `SYNC_INTERVAL`  | Seconds between syncs (min 60)                        | `300`             |
| `WEB_PORT`       | Host port for the web container (bound to 127.0.0.1)  | `8080`            |

`.env` is gitignored — never commit your token.

## Run locally

```bash
docker compose up -d --build
# first sync downloads everything from Notion — can take 1-3 minutes
# depending on how much media there is; later syncs are much faster
open http://localhost:8080
```

The web container serves `site/`, which starts empty (aside from a couple of
`.gitkeep`-held mountpoint directories) and is populated by the sync
container on its first run.

## Development

Linters cover the browser JS, the Node sync service, and the CSS.

```bash
npm install
npm run lint       # eslint + stylelint
npm run lint:fix   # autofix where possible
```

## Deployment

The site runs on a host where Traefik already terminates TLS for `*.olliecross.com`
(docker-label routing + an external `proxy` network + a `letsencrypt` certresolver).

1. Copy the project to the server (e.g. `~/srv/yhd_web/`), including `deploy/docker-compose.override.yml` renamed to `docker-compose.override.yml` in the project root.
2. Ensure `.env` is present with a valid `NOTION_TOKEN` (and a free `WEB_PORT`).
3. `docker compose up -d --build`

The override adds the Traefik router (`Host(yhd.olliecross.com)`, websecure,
letsencrypt) and an HSTS middleware scoped to this router only. The web port is
bound to `127.0.0.1` — all public traffic goes through Traefik.

## Security

- Static HTML only — no server-side request handling, database, or user input at runtime. Media downloads happen at build/sync time, never in response to a visitor request.
- Strict CSP (`default-src 'none'`, assets from `'self'`), `X-Frame-Options: DENY`,
  `nosniff`, Referrer-Policy, Permissions-Policy, HSTS.
- nginx: GET/HEAD only, dotfiles denied, `server_tokens off`, per-IP rate limiting.
- Containers: non-root, read-only rootfs, `cap_drop: ALL`, `no-new-privileges`.
- The sync service (which holds the token) is not reachable from the internet.
