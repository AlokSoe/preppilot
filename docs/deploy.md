# Deploying PrepPilot for free (Oracle Cloud Always Free)

Result: PrepPilot on your own HTTPS address, running on an Oracle Cloud "Always Free" VM with
three containers — Caddy (HTTPS), the API, and the isolated code runner. Your note repos stay
**private**: the server reads them with read-only deploy keys.

**The server holds no API key.** The free demo tier is off, and every user signs up and adds their
own key in **Settings** (a free Gemini key from https://aistudio.google.com works).

Time: about 30–45 minutes, mostly in Oracle's console. Free-tier terms change, so check Oracle's
current Always Free limits as you go.

## 1. Create the VM (Oracle console)

1. Sign up at **cloud.oracle.com**. A card is needed for identity verification; Always Free
   resources aren't charged.
2. **Menu → Compute → Instances → Create instance**
   - **Image:** Canonical **Ubuntu 24.04**
   - **Shape:** Ampere **VM.Standard.A1.Flex**, 1 OCPU, 6 GB memory (inside the free allowance).
     If Ampere says "out of capacity", try another availability domain or try again later.
   - **SSH keys:** choose *Paste public key* and paste the output of this command from your Mac:
     ```bash
     cat ~/.ssh/id_ed25519.pub || (ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 && cat ~/.ssh/id_ed25519.pub)
     ```
3. Create it, wait until it's **Running**, and copy its **Public IP address**.

## 2. Open ports 80 and 443 (Oracle console)

Instance page → **Primary VNIC → Subnet → Security Lists → Default Security List → Add Ingress Rules**:

| Source CIDR | IP protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

(The VM's own firewall is opened by the setup script.)

## 3. Get a free domain name

HTTPS needs a domain. Free option: **https://www.duckdns.org** → sign in → create a subdomain
(e.g. `preppilot-kumar`) → set its **current ip** to the VM's public IP → **update ip**.
Your address is then `preppilot-kumar.duckdns.org`.

## 4. Run the setup script on the VM

From your Mac:
```bash
ssh ubuntu@<public-ip>
curl -fsSL https://raw.githubusercontent.com/AlokSoe/preppilot/main/scripts/setup-server.sh -o setup.sh
bash setup.sh preppilot-kumar.duckdns.org
```

Partway through, the script prints **two deploy keys**, one per note repo, each with a GitHub link.
For each one: open the link, title it `preppilot-server`, paste the key, leave **Allow write access
unchecked**, and click **Add key**. Then press Enter in the terminal.

When it finishes, open `https://<your-domain>` (allow a minute or two for the HTTPS certificate),
create an account, and add your API key in **Settings**.

## Operating it

Run these on the VM, in `~/preppilot`:

| Task | Command |
|---|---|
| Update PrepPilot | `git pull && sudo docker compose up -d --build` |
| Update your notes | `git -C notes/machine-coding-js pull && git -C notes/javascript-engineering-handbook pull && sudo docker compose restart api` |
| Logs | `sudo docker compose logs -f api` (JSON lines; secrets are redacted) |
| Restart | `sudo docker compose restart` |
| Back up the database | `sudo docker compose exec api node -e "new (require('node:sqlite').DatabaseSync)('/data/preppilot.db').exec(\"VACUUM INTO '/data/backup.db'\")" && sudo docker compose cp api:/data/backup.db .` |

**Keep `.env` safe** (it's created with owner-only permissions). If `KEY_ENCRYPTION_SECRET` is lost,
stored user keys can't be decrypted; users just re-enter them.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser can't reach the site | Check step 2's ingress rules, and that DuckDNS points at the current IP. |
| Certificate errors right after setup | Wait 1–2 minutes; check `sudo docker compose logs caddy`. |
| Deploy-key clone fails | The key must be added to the matching repo (each repo has its own key). Re-run `bash setup.sh <domain>`; it resumes. |
| "Add your API key" for every request | Expected: open Settings and add your own key. |
