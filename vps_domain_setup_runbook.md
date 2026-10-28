# SportsDesk & Fantasy402 Production VPS & Domain Deployment Runbook

This guide details the deployment of the **SportsDesk & Fantasy402 Ops Daemon**, **Telegram Bot (@demodevdeskbot)**, **Telegram Mini App (TMA)**, and **Live Bettor Churn Dashboard** on your public domain or cloud VPS.

## 1. Automated 1-Step Deployment

The included script `deploy_to_vps.sh` automates the entire installation:

1. Copy the project files to your VPS:
```bash
scp -r sportsdesk-ops/* root@<YOUR_VPS_IP>:/opt/sportsdesk-ops/
```

2. Run the deployment script on the VPS:
```bash
ssh root@<YOUR_VPS_IP>
cd /opt/sportsdesk-ops
chmod +x deploy_to_vps.sh
./deploy_to_vps.sh desk.yourdomain.com
```

The script automatically:
- Installs `curl`, `unzip`, `nginx`, and `certbot`.
- Installs the native **Bun** runtime.
- Configures production environment variables in `.env`.
- Installs and enables the Systemd service.
- Deploys the Nginx virtual host with Let's Encrypt SSL and Telegram Mini App headers.
- Registers the Telegram webhook with Telegram's Bot API.

## 2. Verification & Diagnostics

| Component | Command / URL | Expected Result |
| :--- | :--- | :--- |
| **Systemd Service** | `systemctl status sportsdesk-ops` | `Active: active (running)` |
| **Public Health** | `curl -s https://desk.yourdomain.com/health` | `HTTP 200 OK` |
| **Telegram Bot** | `https://t.me/demodevdeskbot` | Interactive `/start` menu and Mini App |
