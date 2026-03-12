# Deploy to a New VM

This project can be redeployed to a fresh VM with Docker Compose. The app serves the UI/API on port `3030` and persists SQLite data under `./data`.

## 1. Install Docker on the VM

Ubuntu 24.04 example:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
newgrp docker
```

## 2. Copy the project and environment file

```bash
git clone <your-repo-url> job-engine
cd job-engine
cp .env.example .env
mkdir -p data
```

Edit `.env` and fill at least the source settings you actually use:

- `GREENHOUSE_BOARDS`, `LEVER_BOARDS`, `ASHBY_TARGETS`, `WORKDAY_TARGETS`, etc.
- `SERPAPI_KEY`, `SERPAPI_QUERIES`, `SERPAPI_LOCATION` if you use Google Jobs ingestion
- `OPENAI_API_KEY` only if `LLM_ENABLED=true`
- `PD_WEBHOOK_URL`, `PD_WEBHOOK_TOKEN`, `PD_DB_PATH` only if dashboard sync is still needed

If you are migrating existing data, copy the old SQLite DB to the VM and place it at `./data/job-engine.db`.

## 3. Start the service

```bash
docker compose pull
docker compose up -d
docker compose ps
curl http://127.0.0.1:3030/health
```

The app is then available on:

- `http://<vm-ip>:3030/`
- `http://<vm-ip>:3030/health`

## 4. Update after new commits

```bash
git pull origin main
docker compose pull
docker compose up -d
```

## 5. Optional: expose behind Nginx

If you want the app on a domain with HTTPS, put Nginx or Caddy in front of port `3030`.

## 6. GitHub Actions deploy migration

The workflow at `.github/workflows/ci.yml` validates the project first and publishes a GHCR image from `main`. Then `.github/workflows/deploy.yml` deploys only after `CI` succeeds for a push to `main`. Set these GitHub Actions secrets before pushing to `main`:

- `SERVER_HOST`: new VM public IP or hostname
- `SERVER_USER`: SSH user on that VM
- `SERVER_PATH`: absolute repo path on the VM, for example `/home/ubuntu/job-engine`
- `SSH_KEY`: private key used by GitHub Actions to SSH into the VM

Expected layout on the VM:

- repo cloned at `SERVER_PATH`
- `.env` created manually at `SERVER_PATH/.env`
- Docker and Docker Compose plugin installed
- outbound access from the VM to `ghcr.io`

Each push to `main` will then run:

```bash
docker compose pull
docker compose up -d
```

The remote deploy script now waits for `http://127.0.0.1:3030/health` before reporting success. If your app listens on another port, export `PORT` on the VM or adjust the container env accordingly.
