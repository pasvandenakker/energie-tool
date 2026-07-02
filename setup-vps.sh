#!/bin/bash
set -e

DOMAIN="${1:-energie.weppas.nl}"
echo "=== EnergieSim VPS installatie ==="
echo "Domein: $DOMAIN"
echo ""

# Node.js
if ! command -v node &> /dev/null; then
  echo "Node.js installeren..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node --version)"

# App
cd /var/www
if [ -d energie-tool ]; then
  cd energie-tool && git pull
else
  git clone https://github.com/pasvandenakker/energie-tool.git
  cd energie-tool
fi
npm install --production
npm install -g pm2 2>/dev/null
pm2 delete energie-tool 2>/dev/null || true
pm2 start server.js --name energie-tool --update-env
pm2 save

# Nginx
echo ""
echo "Nginx + SSL instellen..."
apt-get install -y nginx certbot python3-certbot-nginx 2>/dev/null

cat > /etc/nginx/sites-available/$DOMAIN << NGINX
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# SSL
echo ""
IP=$(hostname -I | awk '{print $1}')
echo "Probeer SSL-certificaat voor $DOMAIN..."
echo "Check of DNS A-record naar $IP wijst..."
sleep 2

if certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email pascal@weppas.nl 2>/dev/null; then
  echo "✅ SSL actief!"
else
  echo ""
  echo "⚠️  Certbot kon geen certificaat aanvragen."
  echo "    Dit komt meestal doordat DNS nog niet naar $IP wijst."
  echo ""
  echo "    Stap 1: hPanel -> DNS Zone Editor -> A-record: $DOMAIN -> $IP"
  echo "    Stap 2: certbot --nginx -d $DOMAIN"
  echo ""
fi

# Klaar
echo ""
echo "============================================"
echo "  EnergieSim is live!"
echo ""
echo "  Lokale poort:   http://$IP:3000"
echo "  Via domein:     https://$DOMAIN"
echo ""
echo "  Beheer: pm2 status | pm2 logs energie-tool"
echo "============================================"
