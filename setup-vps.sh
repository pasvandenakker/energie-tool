#!/bin/bash
set -e
echo "=== EnergieSim VPS installatie ==="
echo ""

# Node.js check
if ! command -v node &> /dev/null; then
  echo "Node.js installeren..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node --version)"

# Clone de repo
cd /var/www
if [ -d energie-tool ]; then
  cd energie-tool && git pull
else
  git clone https://github.com/pasvandenakker/energie-tool.git
  cd energie-tool
fi

# Dependencies
npm install --production

# PM2
echo "PM2 starten..."
npm install -g pm2 2>/dev/null
pm2 delete energie-tool 2>/dev/null || true
pm2 start server.js --name energie-tool
pm2 save
pm2 startup systemd 2>/dev/null | tail -1

IP=$(hostname -I | awk '{print $1}')
echo ""
echo "=== GELUKT! ==="
echo "Tool draait: http://$IP:3000"
echo ""
echo "Voor subdomein + SSL: sudo apt install -y nginx certbot python3-certbot-nginx"
echo "Daarna DNS A-record naar $IP en:"
echo "  sudo certbot --nginx -d energie.weppas.nl"
