# Deploy to build.happyoperators.com

Put a website or app live at `https://<name>.build.happyoperators.com`. No account needed. You need an **access code** from the person who shared this link.

People: use the form at [build.happyoperators.com/#deploy](https://build.happyoperators.com/#deploy).

AI agents (Claude, Codex, Cursor and others): read on. Everything below works with plain `curl`.

## Before you start, collect these

- **name**: 3 to 30 characters, lowercase letters, numbers and dashes. It becomes `<name>.build.happyoperators.com`. Suggest one from the project folder name.
- **code**: the access code. If you don't have it, ask the user. Never guess it.
- **what you are deploying**: pick the option below that fits.

If anything is missing, the API answers with `"missing": [...]` and a short explanation. Ask the user for those values, then try again.

## Which option?

Decide this yourself by looking at the project. The user does not need to know or choose.

- **Prefer Option A (upload).** No GitHub needed. Use it whenever the result is a website that runs in the browser: plain HTML, or anything that builds to static files (Vite, React, Astro, Next.js with `output: 'export'`, and similar).
- **Use Option B (GitHub) only when the project must run a server**: an API, a backend (Express, FastAPI, Flask, Django), server-side rendering, or a database. If it is not on GitHub yet, ask the user to push it to a public repo first, then continue.
- **Only ask the user if you really can't tell** from the files. Ask one short question, for example: "Does this need to run a server, or is it just a website?"

## Option A: a static site (folder, zip or one HTML file)

Use this for plain HTML/CSS/JS, or the **built output** of a framework (`dist/`, `build/`, `out/`). There must be an `index.html` at the top level. Max 25 MB.

1. If the project has a build step (a `package.json` with a `build` script), run it first and deploy the output folder, not the source.
2. Zip the folder's contents:

```bash
cd dist && zip -r ../site.zip . && cd ..
```

3. Upload:

```bash
curl -s -X POST --data-binary @site.zip \
  -H "Content-Type: application/zip" \
  "https://build.happyoperators.com/api/sites?name=NAME&code=CODE"
```

A single page works too:

```bash
curl -s -X POST --data-binary @index.html \
  -H "Content-Type: text/html" \
  "https://build.happyoperators.com/api/sites?name=NAME&code=CODE"
```

The reply looks like:

```json
{ "name": "my-site", "url": "https://my-site.build.happyoperators.com", "key": "...", "live": false, "deployment": "abc123" }
```

- **Save the `key`** and give it to the user. It is shown once and is needed to update the site later. Add `&key=KEY` to the same command to update.
- If `live` is `false`, a new address is being switched on. It takes about a minute. Check progress with `GET /api/deploys/status/<deployment>` until `status` is `finished`, then open the url.
- Updates to an existing site are live at once.
- To take a site down: `curl -s -X DELETE "https://build.happyoperators.com/api/sites?name=NAME&key=KEY"`

## Option B: an app from a public GitHub repo

Use this for apps that run a server (Node, Python, etc.) or anything with a Dockerfile. The repo must be public.

```bash
curl -s -X POST https://build.happyoperators.com/api/deploys \
  -H "Content-Type: application/json" \
  -d '{"repo":"https://github.com/OWNER/REPO","name":"NAME","code":"CODE"}'
```

- The server reads the repo and works out how to run it: Dockerfile (uses its `EXPOSE` port), Node or Next.js (port 3000, `PORT` is set for you), Vite or React front-ends (built, then served as static files), Python, Go, Ruby, or a plain `index.html`. The reply says what it `detected`.
- The app should listen on the `PORT` environment variable. Most frameworks already do.
- Optional overrides if detection gets it wrong: `"branch"` (default: the repo's default branch), `"pack"` (`auto`, `dockerfile` or `static`) and `"port"`.
- The reply has a `deployment` id. Poll `GET https://build.happyoperators.com/api/deploys/status/<deployment>` every few seconds. `status` goes `queued`, `in_progress`, then `finished` or `failed`. `log` has the last build lines; if it failed, read them, fix the repo, push, and send the same request again.
- Sending the same name with the same repo again redeploys it.

## Rules

- One name per project. A name that is already used by someone else is refused, so pick another.
- Apps get 512 MB of memory and half a CPU.
- No secrets in public repos or uploads.
- Be kind: this is a shared community server run by Happy Operators.

## Quick reference

- `GET /api/sites`: what the upload endpoint needs (JSON)
- `POST /api/sites`: upload a static site
- `DELETE /api/sites?name=&key=`: remove your static site
- `POST /api/deploys`: deploy a GitHub repo
- `GET /api/deploys`: list live apps
- `GET /api/deploys/status/<id>`: build progress
