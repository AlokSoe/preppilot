# Deploying PrepPilot for free (Oracle Cloud Always Free)

This puts PrepPilot on a public HTTPS URL at no hosting cost: an Oracle Cloud "Always Free" VM
running Docker Compose with three containers — Caddy (HTTPS), the API, and the isolated code runner.

> Free-tier terms change. Check Oracle's current Always Free limits before you start. Model usage is
> **not** free: the demo tier spends your Anthropic credit (capped by `DEMO_DAILY_TOKENS`), and users
> with their own key spend theirs.

## 1. Create the VM

1. Sign up at cloud.oracle.com (a card is needed for verification; Always Free resources aren't charged).
2. **Compute → Instances → Create instance**
   - Image: **Ubuntu 24.04**
   - Shape: **Ampere (VM.Standard.A1.Flex)**, 1–2 OCPU, 6–12 GB RAM (inside the free allowance)
   - Add your SSH public key.
3. Note the instance's **public IP**.

## 2. Open ports 80 and 443

Two firewalls need it:

- **Oracle network:** Instance → Subnet → Security List → *Add Ingress Rules*: source `0.0.0.0/0`,
  TCP, destination ports `80` and `443`.
- **On the VM** (Oracle's Ubuntu images ship with strict iptables rules):
  ```bash
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo netfilter-persistent save
  ```

## 3. Point a domain at it

Caddy needs a domain name to get an HTTPS certificate. Any of:
- your own domain: an `A` record → the VM's public IP, or
- a free subdomain from a dynamic-DNS service (e.g. DuckDNS) pointing at the IP.

## 4. Install Docker

```bash
ssh ubuntu@<public-ip>
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
```

## 5. Get the code and your notes

```bash
git clone https://github.com/AlokSoe/preppilot.git
cd preppilot
mkdir notes
git clone https://github.com/AlokSoe/machine-coding-js.git notes/machine-coding-js
git clone https://github.com/AlokSoe/javascript-engineering-handbook.git notes/javascript-engineering-handbook
```

## 6. Configure

```bash
cp .env.example .env
nano .env
```
- `DOMAIN` — your domain from step 3
- `ANTHROPIC_API_KEY` — powers the free demo tier (leave empty to require users' own keys)
- `KEY_ENCRYPTION_SECRET` — `openssl rand -hex 32`
- `RUNNER_TOKEN` — `openssl rand -hex 24`

**Keep `KEY_ENCRYPTION_SECRET` safe.** If you lose it, stored user keys can't be decrypted
(users would just re-enter them).

## 7. Start

```bash
docker compose up -d --build
docker compose logs -f api      # look for "listening" with "auth":"accounts"
```

Open `https://<your-domain>` and create an account.

## Operating it

| Task | Command |
|---|---|
| Update to the latest code | `git pull && docker compose up -d --build` |
| Update your notes | `git -C notes/machine-coding-js pull && docker compose restart api` |
| Logs | `docker compose logs -f api` (JSON lines; secrets are redacted) |
| Back up the database | `docker compose exec api node -e "new (require('node:sqlite').DatabaseSync)('/data/preppilot.db').exec(\"VACUUM INTO '/data/backup.db'\")"` then copy it off the VM with `docker compose cp api:/data/backup.db .` |
| Restart | `docker compose restart` |

## Fallback: Render free tier

For a quick demo without a VM: deploy the Dockerfile as a Render web service with `AUTH` unset
(single-user) or set. Limits: the service sleeps when idle (slow first request), there's no
persistent disk on the free tier (the SQLite data resets on redeploy), and there's no separate
runner container — code runs in the API container, protected by Node's permission model only.
