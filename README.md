# Tungston — Is It Down Checker

A tiny glassmorphism website that checks whether a URL is reachable, and
asks Groq's LLM for a one-line plain-English summary. The Groq API key
lives only on the server (a Vercel serverless function) — the browser
never sees it.

## Project structure

```
tungston-is-it-down-checker/
├── api/
│   └── check.js       <- server-side function (runs on Vercel, has the API key)
├── public/
│   ├── index.html      <- the page
│   ├── styles.css       <- glassmorphism styling
│   └── script.js        <- calls /api/check
├── package.json
├── .gitignore
└── .env.example         <- copy to .env for local testing
```

---

## 1. Install Node.js on AntiX

AntiX is Debian-based, so:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # should print v20.x
npm -v
```

## 2. Get the project onto your machine

Create the folder and put the files from this chat into it exactly as
shown in the structure above (same names, same folders — `api/check.js`
must be inside a folder literally called `api`, that's how Vercel finds it).

```bash
mkdir tungston-is-it-down-checker
cd tungston-is-it-down-checker
mkdir api public
```

Then paste each file's contents into the matching path.

## 3. Add your Groq API key locally

```bash
cp .env.example .env
nano .env
```

Replace the placeholder so the line reads:

```
GROQ_API_KEY=gsk_your_real_key_here
```

Save and exit (`Ctrl+O`, Enter, `Ctrl+X` in nano). **This is the only
place you ever paste the real key.** `.env` is already listed in
`.gitignore`, so it will never be committed to git.

## 4. Push it to GitHub

You said you already have a Personal Access Token ("passkey") good for
30 days — that's what GitHub wants in place of a password over HTTPS.

```bash
git init
git add .
git commit -m "Initial commit: Tungston Is It Down Checker"
```

Create an empty repository on github.com named `tungston-is-it-down-checker`
(don't initialize it with a README, so there's no merge conflict), then:

```bash
git branch -M main
git remote add origin https://github.com/<your-username>/tungston-is-it-down-checker.git
git push -u origin main
```

When it asks for a username/password:
- **Username:** your GitHub username
- **Password:** paste your Personal Access Token (not your real GitHub password)

If you don't want to retype the token every time, cache it for the rest
of its 30-day life:

```bash
git config --global credential.helper 'cache --timeout=2592000'
```

## 5. Deploy on Vercel

```bash
npm install -g vercel
vercel login
```

From inside the project folder:

```bash
vercel
```

Answer the prompts (link to a new project, accept the defaults — Vercel
auto-detects the `api/` folder and `public/` folder, no build step needed).

### Add the API key to Vercel (this is the production equivalent of step 3)

```bash
vercel env add GROQ_API_KEY
```

Paste your real Groq key when prompted, choose **Production** (and
Preview, if you want previews to work too).

Then deploy for real:

```bash
vercel --prod
```

Vercel prints your live URL — that's it, live and deployed, with the key
stored securely in Vercel's environment settings, never in your code.

You can also add/edit the env var later from the Vercel dashboard:
**Project → Settings → Environment Variables.**

---

## Security features already built in (see comments in `api/check.js`)

- **API key never reaches the browser** — it's read from
  `process.env.GROQ_API_KEY` inside the serverless function only.
- **SSRF protection** — blocks `localhost`, private IP ranges
  (10.x, 172.16–31.x, 192.168.x, 169.254.x/cloud metadata, etc.), and
  re-checks the *resolved* IP (not just the hostname text) so a public
  domain name can't be used to sneak past the filter via DNS rebinding.
- **Protocol allowlist** — only `http://` and `https://` are accepted.
- **Request timeout** — any check is aborted after 8 seconds so a slow
  or hanging target can't tie up your function.
- **Basic rate limiting** — caps each IP to 15 checks/minute per warm
  function instance.
- **Security headers** — `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Cache-Control: no-store` on every response.
- **Output escaping** — the AI summary is HTML-escaped before being
  inserted into the page, so a malicious response can't inject HTML/JS.

### If you want to go further

- The in-memory rate limiter resets on cold start and doesn't share
  state across regions/instances. For real protection under abuse,
  put this behind [Vercel's Firewall](https://vercel.com/docs/security/vercel-waf)
  or use a shared store like [Upstash Redis](https://upstash.com/) for
  the rate limit counters.
- Consider adding a CAPTCHA (e.g. Cloudflare Turnstile) on the form if
  the site gets public traffic and starts seeing abuse.
- Rotate your Groq key periodically from the Groq console, and update
  it in Vercel's env settings — no code change or redeploy of secrets needed.
