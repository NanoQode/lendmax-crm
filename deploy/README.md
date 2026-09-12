# Deploying to lendmax.ca/crm

The CRM runs as its own process on 127.0.0.1:3400 and nginx routes `/crm` to it.
It shares the box with three other live things, so everything here is named to
stay clear of them:

| Already on the box | Do not confuse with |
|---|---|
| `lendmax_crm` database | the **marketing site's CMS** — it has its own `users`, `sessions`, `settings` and `audit_log` tables |
| `/srv/lendmax-crm`, `lendmax-crm.service` | the **MIC platform** (app.lendmaxcapital.ca) |
| `lendmax_brokerage_crm` database, `/srv/lendmax-brokerage-crm`, `lendmax-brokerage-crm.service` | this CRM |

## Files

- `lendmax-brokerage-crm.service` → `/etc/systemd/system/`
- `deploy-brokerage-crm` → `/usr/local/sbin/` — clone/update, install, migrate, seed, build, start
- `deploy-brokerage-crm-nginx` → `/usr/local/sbin/` — the nginx route, run **only** once the app answers on 3400

The environment file is `/etc/lendmax/brokerage-crm.env`, mode 640, root-owned.
It is not in this repository and must not be: see `.env.example` for its shape.
Generate the secrets on the server (`openssl rand -hex 32` for `SESSION_SECRET`,
`openssl rand -base64 32` for `CREDENTIALS_KEY`) so they never pass through a
terminal transcript.

## Order

```sh
deploy-brokerage-crm              # code, schema, client build, service
npm run seed -- --admin you@x.ca  # prints a one-time password, once
deploy-brokerage-crm-nginx        # public routing — last, and only if the above is healthy
```

The two are separate on purpose. `deploy-brokerage-crm-nginx` edits the config
that serves *every* site on the machine; it backs up first, runs `nginx -t`, and
restores the backup rather than reloading a config nginx rejected.

## Four things that cost time here — leave them as they are

1. **`npm` is not on `PATH`.** Node lives in `/root/.hermes/node`, and only
   `node` is symlinked into `/usr/local/bin`. The deploy script puts
   `/root/.hermes/node/bin` on `PATH` itself.

2. **Every value in the env file is quoted.** systemd is relaxed about this;
   `bash` is not, and the deploy script sources the same file. `EMAIL_FROM=Lendmax
   <noreply@lendmax.ca>` unquoted is a *redirection* to bash, and the whole file
   fails to parse on that line.

3. **`npm ci` installs everything, then prunes.** `--omit=dev` up front skips
   `esbuild` and `preact`, so the client never builds. Playwright's browser
   download is skipped instead (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`).

4. **`if nginx -t | tail -2` tests `tail`, not nginx** — it is always 0, so the
   restore-from-backup branch can never run. The output is captured to a file
   instead.

## Verifying a deploy

```sh
curl -fsS http://127.0.0.1:3400/crm/api/health         # before nginx
curl -sL  https://lendmax.ca/crm/ -o /dev/null -w '%{http_code}\n'
curl -s   https://lendmax.ca/crm/api/customers -o /dev/null -w '%{http_code}\n'   # 401 signed out
curl -s   https://lendmax.ca/crm/api/internal/x -o /dev/null -w '%{http_code}\n'  # 404, always
```

`/crm` answers 301 → `/crm/`; a check without `-L` reports the redirect, not a
failure. The index references hashed asset filenames, so confirm the `app-*.js`
it names actually returns 200 — that pairing is what a stale committed
`index.html` used to break.

And check the neighbours are untouched: `https://lendmax.ca/`,
`https://lendmax.ca/admin`, `https://apply.lendmax.ca/`, `https://rateshop.ca/`.
