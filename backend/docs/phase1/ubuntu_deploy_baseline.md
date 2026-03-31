# Ubuntu Deploy Baseline (Phase 1)

## 1) Install runtime

```bash
sudo apt update
sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
```

## 2) Clone and install

```bash
git clone <your-repo-url> /opt/backend
cd /opt/backend
npm install
cp ops/env.example ops/.env
```

## 3) Start infra

```bash
docker compose -f docker-compose.local.yml up -d
npm run db:migrate
```

## 4) Run services

```bash
npm run start:api
npm run start:worker
```

## 5) Validate

```bash
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/ready
```

## 6) Optional process manager (pm2)

```bash
sudo npm i -g pm2
pm2 start "npm run start:api" --name mcu-api --cwd /opt/backend
pm2 start "npm run start:worker" --name mcu-worker --cwd /opt/backend
pm2 save
```

