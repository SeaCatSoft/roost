# Deploying Roost

Two separate things, deployed to two separate places:

| Piece | Where it lives | Why |
| --- | --- | --- |
| The landing page (this repo) | GitHub Pages | Static files. Free, fast, no server. |
| Postgres + the API | Supabase (or Neon + a small API host) | Pages **cannot** run a database or server code. |

> **The one thing to get right:** a static page can never hold a Postgres connection
> string. Anything shipped to the browser is readable by anyone who opens developer
> tools. The database is reached through an authenticated API, never directly.

---

## Part 1 — Get the site on GitHub Pages

### 1.1 Set your git identity (not yet configured on this machine)

```bash
git config --global user.name "Raymond Morris"
```

```bash
git config --global user.email "raymonddmorris@gmail.com"
```

### 1.2 Initialise the repository

From `C:\projects\roost`:

```bash
git init -b main
```

Create a `.gitignore`:

```bash
printf '.DS_Store\nThumbs.db\nnode_modules/\n.env\n.env.*\n' > .gitignore
```

Then commit:

```bash
git add -A && git commit -m "Roost landing page"
```

### 1.3 Create the repository on GitHub

The `gh` CLI is not installed here, so use the web UI:

1. Go to <https://github.com/new>
2. Name it `roost`
3. **Public.** On a free account, GitHub Pages only publishes from public repositories —
   private-repo Pages needs Pro/Team/Enterprise.
4. Do **not** add a README, .gitignore or licence — the repo already has content.
5. Create repository.

> Prefer the CLI? `winget install GitHub.cli`, then `gh auth login` and
> `gh repo create roost --public --source=. --push` replaces steps 1.3 and 1.4.

### 1.4 Push

Replace `YOUR-USERNAME`:

```bash
git remote add origin https://github.com/YOUR-USERNAME/roost.git
```

```bash
git push -u origin main
```

### 1.5 Turn Pages on

In the repository: **Settings → Pages → Build and deployment → Source → GitHub Actions**.

That is the only click required. `.github/workflows/pages.yml` is already in the repo and
runs on every push to `main`. It uploads the repository root as-is — there is no build.

Watch the run under the **Actions** tab. When it goes green the site is at:

```
https://YOUR-USERNAME.github.io/roost/
```

The site lives at a sub-path, which is fine: every asset reference in `index.html` is
relative (`assets/styles.css`), so nothing needs rewriting.

### 1.6 Custom domain (optional)

1. **Settings → Pages → Custom domain**, enter e.g. `roost.yourfarm.com`, save.
   This commits a `CNAME` file to the repo.
2. At your DNS provider add a `CNAME` record: `roost` → `YOUR-USERNAME.github.io`.
   For an apex domain (`yourfarm.com`) use `A` records to GitHub's four Pages IPs
   instead — the Pages settings screen lists the current ones.
3. Wait for DNS, then tick **Enforce HTTPS**.

---

## Part 2 — Stand up Postgres

### Why not just "connect the database"

The browser cannot talk to Postgres. Something has to sit in between that
authenticates the user and decides which rows they may see. You have two routes:

**Route A — Supabase (recommended to start).** Managed Postgres that *generates* a REST
API over your tables, plus authentication and row-level security. No API server to write
or host. The schema in [`data-model.md`](data-model.md) applies unchanged.

**Route B — Neon/RDS + your own API.** A Postgres host plus a small service (Hono,
Fastify, Express) on Fly.io, Render or Railway. More control, more to run. Choose this
when you outgrow generated endpoints — invoice numbering, PDF generation and the AI
follow-up queue will eventually want real server code.

Start with A. Phase 2 is when B starts to earn itself.

### 2.1 Create the project

1. <https://supabase.com> → new project.
2. Choose a region near the farm and set a strong database password (store it in a
   password manager — you will rarely need it).
3. Note **Project URL** and the **anon public** key from **Settings → API**.

### 2.2 Apply the schema

Open **SQL Editor** and run the statements from
[`data-model.md`](data-model.md) in order: enums, then core tables, then feed, daily
checks, health, processing, costs, assets.

### 2.3 Turn on row-level security — do not skip this

The anon key is embedded in the page and is **public by design**. It is safe *only*
because RLS decides what that key can read. Without RLS, a public anon key means a
public database.

Add tenancy first — the schema as written has no notion of who owns a farm:

```sql
CREATE TABLE farm_members (
  farm_id bigint NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  user_id uuid   NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role    text   NOT NULL DEFAULT 'member',
  PRIMARY KEY (farm_id, user_id)
);
```

Then enable RLS on every table and scope access through it:

```sql
ALTER TABLE farms         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cycles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_checks  ENABLE ROW LEVEL SECURITY;
-- ...and every other table. RLS is per-table; a table you forget is a table anyone reads.

CREATE POLICY "members read their farm" ON farms
  FOR SELECT USING (
    id IN (SELECT farm_id FROM farm_members WHERE user_id = auth.uid())
  );

CREATE POLICY "members work their cycles" ON cycles
  FOR ALL USING (
    farm_id IN (SELECT farm_id FROM farm_members WHERE user_id = auth.uid())
  );

-- Tables reached through a cycle join back to it
CREATE POLICY "members work their daily checks" ON daily_checks
  FOR ALL USING (
    cycle_id IN (
      SELECT c.id FROM cycles c
      JOIN farm_members m ON m.farm_id = c.farm_id
      WHERE m.user_id = auth.uid()
    )
  );
```

Verify before trusting it: **Settings → API → API Docs** has a "run as anon" console, and
the table editor flags any table still missing RLS.

### 2.4 Authentication

**Authentication → Providers** → enable email/password (or a magic link, which suits a
farm where nobody wants another password). Create your own user, then insert the
`farm_members` row linking it to the farm.

---

## Part 3 — Wire the page to the backend

### 3.1 Configuration file

The landing page itself needs no backend — it is marketing. The moment you add the
signup form or the app screens, keep the endpoint in one place:

```js
// assets/config.js  — committed; these two values are public by design
window.ROOST_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi...'   // safe ONLY because RLS is on
};
```

Load it before your app script. **Never** put the `service_role` key, the database
password, or a connection string here — `service_role` bypasses RLS entirely and belongs
only on a server.

### 3.2 CORS

Supabase's API already accepts browser requests from any origin, so Pages works with no
configuration. If you go with Route B, allowlist your origins explicitly:

```
https://YOUR-USERNAME.github.io
https://roost.yourfarm.com
```

Allowlist them — don't use `*` once requests carry credentials.

### 3.3 Where the app itself goes

The logged-in app can be more static pages in this same repo — `app/index.html` calling
Supabase — and Pages hosts it free. The repo being public does not expose farm data;
data is protected by auth and RLS, not by hiding the source.

Move to Vercel/Netlify/Fly when you need server-side rendering, scheduled jobs, or
secrets that must stay off the client — which is exactly what Phase 3's AI follow-up
needs, since the model API key can never touch the browser.

---

## Part 4 — Day-to-day

Deploying is a push:

```bash
git add -A && git commit -m "Update pricing copy" && git push
```

Pages redeploys in about a minute.

### Things that will bite you

- **Free Supabase projects pause after ~7 days idle.** Fine for daily use; annoying if a
  cycle ends and nobody logs in for a fortnight. The paid tier removes it.
- **Pages caches aggressively.** If a CSS change doesn't appear, hard-reload
  (`Ctrl+Shift+R`). For real cache-busting, version the asset URLs
  (`styles.css?v=2`) when you change them.
- **Pages is public.** Anyone with the URL can read the landing page. That is the point
  here — but never let a page under Pages render farm data without an auth check.
- **Back up the database.** Supabase's free tier keeps limited backups. A weekly
  `pg_dump` to your own storage is cheap insurance for records you cannot re-enter.
- **Secrets in GitHub Actions** (`Settings → Secrets and variables → Actions`) are for
  the *build*. Anything the build writes into the page is public. A secret that must stay
  secret belongs on a server, not in a static build.

---

## Order of work

1. Push the repo, enable Pages, confirm the landing page is live. ← *you are here*
2. Create the Supabase project, apply the schema, enable RLS, prove it with a test user.
3. Build the daily check screen — the highest-value part of the app and the smallest.
4. Add cycles, feed and processing.
5. Phase 2 (invoicing) is where a real API server starts to pay for itself.
