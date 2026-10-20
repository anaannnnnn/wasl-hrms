# Wasl HRMS

UAE-first HR, payroll and compliance platform for SMEs (Mainland + Free Zones).
Node.js + Express + MongoDB, plain-JS web client with English/Arabic (RTL), Docker setup for Linode.

## What works in this build

| Area | What it does |
| --- | --- |
| Sign-in & roles | JWT login; roles: hr_admin, payroll_maker, payroll_checker, manager, employee |
| Tenant isolation | Every query, save and aggregate is scoped to the signed-in tenant by a Mongoose plugin. A query without tenant context throws instead of leaking data. |
| Employees | Master records, salary in integer fils, IBAN checksum validation, bank details never sent to the browser in full |
| Payroll | Deterministic calculation, unpaid-leave deduction, 50% deduction cap, month-over-month anomaly flags, held lines for blocking errors |
| WPS pre-flight & SIF | MOHRE ID, routing code, 14-digit labour card, IBAN mod-97, duplicates, SCR = sum(EDR) to the fils, filename timestamp; .sif export |
| Maker-checker | Maker submits, a *different* checker approves; approval re-verifies inputs (hash) and locks the run |
| Emiratisation | Tier 1/Tier 2 detection, qualifying-national checks (full-time, pension, AED 6,000, WPS), fine exposure, NAFIS scenario |
| Gratuity (EOSB) | Art. 51 formula with cap, unpaid-leave exclusion, DEWS path, full calculation trace |
| Document radar | Expiry list with severity; open a renewal case with steps |
| Leave | Requests, approve/reject, department overlap detection |
| AI agent | Natural-language command → proposal → you approve → executes (hire, leave, salary certificate). Runs without an API key; see `server/src/lib/agent.js` to plug in an LLM. |
| Audit log | Append-only (updates/deletes blocked) with actor, action and correlation ID |

## Run it

### Option A: Docker (recommended, same as Linode)

Needs Docker Desktop (or Docker Engine + Compose).

```bash
cp .env.example .env              # then set JWT_SECRET
docker compose up -d --build
docker compose exec api node server/src/seed.js
```

Open http://localhost:4000

### Option B: Node directly

Needs Node 20+ and MongoDB 7 running locally (or a MongoDB Atlas URI).

```bash
cd server
cp ../.env.example .env           # set MONGO_URI and JWT_SECRET
npm install
npm run seed
npm run dev
```

Open http://localhost:4000

### Demo sign-ins (password `Demo@2026`)

- `admin@alnoor.demo`: HR admin + payroll maker
- `checker@alnoor.demo`: payroll checker
- `manager@alnoor.demo`: line manager

### A 3-minute demo path

1. Sign in as admin. **Command Center** shows expiring visas, Emiratisation exposure and leave clashes.
2. **Payroll & WPS** → *Compute payroll*. Pre-flight blocks Ravi Shrestha's invalid IBAN and flags Grace Okafor's overtime spike.
3. **Employees** → *Update* Ravi's IBAN (try `AE070331234567890123456`; any valid UAE IBAN works) → back to payroll → *Recompute* → *Submit for approval*.
4. Sign out, sign in as `checker@alnoor.demo` → *Approve payroll* → *Export .SIF* → download the file.
5. Back as admin: **Audit log** shows every step. Try the AI bar: "Hire Omar Al-Maktoum as Senior Engineer, AED 22,000, start Nov 1".

## Tests

```bash
cd server && npm test
```

Covers money precision, IBAN, gratuity (under 1 year, 5-year boundary, cap, unpaid leave, DEWS, missing rule pack), WPS file totals/format/holds, Emiratisation tiers, NAFIS cap and payroll deductions.

## Deploy on Linode (Akamai)

1. Create a Dedicated or Shared CPU Linode, Ubuntu 24.04 LTS, in the region closest to your users. Add a Cloud Firewall allowing 22 (your IP only), 80 and 443.
2. Install Docker: `curl -fsSL https://get.docker.com | sh`
3. Copy this folder to the server, create `.env` with `NODE_ENV=production` and a strong `JWT_SECRET`.
4. Point your domain's A record to the Linode IP. Edit `nginx/nginx.conf` and replace `hr.example.ae`.
5. Get certificates: `sudo apt install certbot && sudo certbot certonly --standalone -d your.domain` and copy `/etc/letsencrypt` to `nginx/certs`.
6. `docker compose --profile proxy up -d --build`, then seed or create your first tenant.
7. Backups: schedule `mongodump` to Linode Object Storage daily, and test a restore before go-live.

For production MongoDB, prefer a 3-node replica set (or a managed MongoDB) over the single container used here.

## Project layout

```
server/
  src/
    lib/            rules.js (versioned rule packs), money.js, iban.js, payroll.js,
                    wps.js, eosb.js, emiratisation.js, agent.js, tenantContext.js
    models/         all Mongoose schemas
    middleware/     auth, roles, audit helper
    routes/api.js   REST API
    seed.js         demo tenant
  test/             engine tests (node --test)
web/                index.html, app.js, styles.css (no build step)
nginx/              TLS reverse proxy config
docker-compose.yml  mongo, redis, api, nginx
```

## Compliance note

All statutory figures live in `server/src/lib/rules.js`, taken from the PRD blueprint and marked `pending-legal-review`. Validate every value, the SIF column layout against your agent bank's current spec, and free-zone rules with UAE counsel before using this with real payroll.

## Next sprints

1. Document uploads to Linode Object Storage (presigned URLs) + OCR, scheduled expiry alerts via BullMQ/Redis
2. Attendance, shifts, Ramadan hours and overtime capture feeding payroll inputs
3. Bilingual PDF letters and payslips; WhatsApp/email delivery
4. Employee self-service mobile flows; LLM-backed agent with tool calling and voice
5. Multi-establishment UI, Free Zone rule packs (DIFC, ADGM, DMCC, JAFZA), off-cycle and final-settlement payroll
