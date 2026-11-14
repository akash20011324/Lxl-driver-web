# LXL Driver — Standalone Website

The LXL Driver app (Lubana Xpress LLC) as a standalone website, so the owner
can open the Admin Portal on his MacBook — or anywhere — in a browser, without
going through Muse. The phone app (iPhone/Android) remains the standalone
version for drivers; this is the web version of the same app, same backend
API.

**Live address (once deployed): https://app.lubanaxpress.com**
(the owner's own domain, `lubanaxpress.com` on GoDaddy; the app lives on the
`app` subdomain so his main website is untouched).

## What is in this folder

```
lxl-driver-web/
├── README.md                 this file
├── render.yaml               Render Blueprint: one free web service (Docker)
├── Dockerfile                Node 22 image that runs the server
├── .dockerignore / .gitignore
├── public/                   the website (no build step)
│   ├── index.html            SPA shell
│   ├── app.js                all views: sign-in, Admin Portal, driver views
│   ├── styles.css            locked design: royal blue + gold on black
│   └── assets/logo.png       LXL + gold arrow logo
└── server/                   backend API (Node/Express + SQLite)
    ├── package.json
    ├── src/index.js          API + serves public/ from the same process
    ├── src/db.js             SQLite schema
    ├── src/seed.js           demo seed (not used on a fresh deploy)
    ├── src/seed-fleet.js     real-fleet seed (1301/1302, 531/5302)
    ├── src/push.js           Expo push notifications (phone app)
    └── scripts/smoke-test.mjs  backend test suite (56 steps)
```

The backend is the same API as the native phone app
(`~/workspace/lxl-driver-native/`, contract in its `API_CONTRACT.md`).
Driver sign-in is **phone number OR email + password**; admin sign-in is
**email + password**. One process serves both the API (`/api/...`) and the
website, so there is nothing else to host.

**Real fleet is already seeded:** on a fresh database the server inserts
Truck **1301** (2021 Kenworth T680) and Truck **1302** (2021 Freightliner
Cascadia), Trailers **531** and **5302** — all unassigned, in the yard.
Driver accounts are **not** created here: the admin adds them in the portal
(Drivers → Add driver, with a phone number and/or email and a password).
Adding the first real fleet deactivates demo mode, so there is no demo
sign-in on this site — by design.

## Run it locally

Requires Node.js 22 or newer.

```bash
cd lxl-driver-web/server
npm install
npm start
```

Open http://localhost:3000. First visit shows the setup form: create your
admin account (name, email, password of your choice, min 8 characters).
After that you sign in as admin and land in the Admin Portal.

Useful commands:

```bash
npm test                                   # backend smoke test (56 steps)
node src/seed-fleet.js                     # re-seed the real fleet if needed
SEED_REAL_FLEET=0 npm start                # start without auto-seeding
DATA_DIR=/path/to/data npm start           # store the database elsewhere
```

## Deploy it on Render (free to try)

No hosting account exists yet and nothing has been deployed. The owner does
these steps himself; nothing here spends money.

### 1. Put the code on GitHub

Render deploys from a Git repo.

```bash
cd ~/workspace/lxl-driver-web
git init
git add -A
git commit -m "LXL Driver standalone website"
# create an empty repo on github.com (e.g. lubanaxpress/lxl-driver-web)
git remote add origin https://github.com/lubanaxpress/lxl-driver-web.git
git push -u origin main
```

### 2. Create the service from the Blueprint

1. Sign up / sign in at https://render.com (free Hobby workspace, $0).
2. Dashboard → **New → Blueprint Instance** (or **New → Web Service** and
   pick the repo manually).
3. Connect your GitHub account, pick the `lxl-driver-web` repo.
4. Render reads `render.yaml` and creates one web service,
   `lxl-driver-web`, plan **free**, Docker environment.
   (If you create a manual web service instead: Environment **Docker**,
   Dockerfile path `./Dockerfile`, plan **Free**, health check path
   `/api/setup/status`.)
5. Click **Apply** / **Create Web Service** and wait for the first deploy
   (a few minutes; the Docker image builds on Render).
6. Open the service URL Render gives you
   (e.g. `https://lxl-driver-web.onrender.com`). First visit shows the
   setup form — create your admin account there. That account is the owner
   admin for the live site.

The Dockerfile was written to spec but **not build-tested locally** (no
Docker in this workspace), so the first Render deploy is the real test of
the image. If the build fails, the Render deploy log will show why.

### 3. Add the custom domain — app.lubanaxpress.com

Do this after the first deploy works on the `*.onrender.com` address.

**In Render (5 minutes):**

1. Open the `lxl-driver-web` service → **Settings** → **Custom Domain** →
   **Add Custom Domain**.
2. Enter `app.lubanaxpress.com` and save.
3. Render shows the DNS value it expects — a CNAME target that looks like
   `lxl-driver-web-xxxx.onrender.com`. Copy that exact value.

**In GoDaddy (5 minutes):**

1. Sign in at https://godaddy.com → **My Products** → **Domains** →
   `lubanaxpress.com` → **DNS** (Manage DNS).
2. Find the existing record for the `app` subdomain — it is currently an
   **A record** pointing at the website host. A CNAME cannot exist next to
   another record for the same name, so **delete that `app` A record**
   first. (Only the `app` record changes; `lubanaxpress.com` itself and
   `www` are untouched, so the main website keeps working.)
3. **Add** a new record:
   - **Type:** CNAME
   - **Host:** `app`
   - **Points to:** paste the exact `*.onrender.com` value Render showed
   - **TTL:** 1 Hour (or leave the default)
4. Save.

**Then wait:** DNS changes usually work within minutes but can take up to
an hour. Render then issues the free HTTPS certificate automatically
(also a few minutes). When it is ready, https://app.lubanaxpress.com
opens the app with a lock icon. If the certificate step stalls, check in
Render → Settings → Custom Domain that it says **Verified**; if it does
not, re-check the CNAME value in GoDaddy (a typo is the usual cause).

## Costs

Prices checked October–November 2026 at render.com/pricing; confirm there
before paying anything.

| Setup | Monthly cost | What you get / limits |
|---|---|---|
| **Free (try it out)** | **$0** | Free web service (0.1 CPU, 512 MB). Spins down after 15 minutes with no traffic — the first visit after that takes ~1 minute to wake up. **No persistent disk: the database and uploaded files are lost on every redeploy or restart.** Fine for trying it out; not for daily use. |
| **Recommended for daily use** | **~$7.25** | Starter instance **$7/mo** (0.5 CPU, 512 MB, never sleeps) + 1 GB persistent disk **$0.25/mo**. Database and uploads survive restarts and deploys. |

No domain cost: `app.lubanaxpress.com` is a subdomain of the domain the
owner already owns on GoDaddy. The Hobby workspace ($0) includes custom
domains and the TLS certificate.

### Keeping data permanently (paid upgrade)

1. In Render, change the service plan from **Free** to **Starter**.
2. In `render.yaml`, uncomment the `disk:` block (1 GB at `/var/data`) and
   the `DATA_DIR: /var/data` env var, commit, and push — Render redeploys
   with the disk attached.
3. Note: the first deploy with a disk starts with an **empty** database
   (the old free-tier data does not carry over). Re-create the admin
   account on first visit; the real fleet (1301/1302, 531/5302) seeds
   itself again automatically.

## First use (after deploy)

1. Open the site, create the admin account on the setup form.
2. **Drivers → Add driver** for Akashdeep Singh and Arshdeep Singh
   (name + phone number and/or email + password). Drivers sign in with
   their phone number or email.
3. **Trucks & Trailers**: assign truck 1301 + trailer 531 to Akashdeep,
   truck 1302 + trailer 5302 to Arshdeep (or let drivers pick their trailer
   themselves in the driver view). Use the **In the Yard / On the Road**
   chips to move units between yard and road.
4. **Loads → Assign load**, **Rate Cons** to upload rate confirmations
   (auto-renamed `LOADNUMBER_PICKUPSTATE-DELIVERYSTATE_dates`), **Trucks &
   Trailers → unit → Paperwork** for registration/insurance/inspection.

## Notes and known issues

- **Driver-requests bug — fixed here.** `POST /api/driver/requests`
  returned a 500 in the original backend (the INSERT was missing the
  `'pending'` status value, so `createdAt` got NULL). Fixed in
  `server/src/index.js` in this copy; verified end-to-end (driver creates
  an advance request → admin approves it). **The same bug exists in the
  native app's server** (`lxl-driver-native/server/src/index.js`, same
  line) — it should be fixed there too, because driver requests from the
  phone app will fail the same way.
- **Two small frontend fixes were applied during verification:** the
  Dashboard now fetches truck/trailer/load counts directly (the overview
  endpoint returns a driver array, not counts), and the Drivers table
  merges assignments from the overview (the drivers endpoint does not
  include them).
- **Map:** the Locations page uses Leaflet + OpenStreetMap tiles from a
  CDN. If the map library cannot load (no internet/CDN blocked), the page
  falls back to a plain table of driver coordinates.
- **Uploads:** files are stored on the server's disk under the data
  directory (`data/uploads`). On the free tier they disappear on redeploy
  — see the paid upgrade above.
- **Security:** sessions are random server-issued tokens; passwords are
  bcrypt-hashed and never returned or logged. The admin account is
  created by the owner on first visit; there is no default password.
- **Backups:** on the paid setup, back up the SQLite file
  (`/var/data/lxl.db`) and the `uploads` folder regularly. There is no
  automatic backup on the free tier.

## Open questions

None blocking. The owner still has to do himself: create the GitHub repo
and push this code, create the Render account/service, and add the
`app.lubanaxpress.com` CNAME at GoDaddy. No accounts were created and no
money was spent building this.
