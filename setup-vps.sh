#!/bin/bash
set -e

echo "=== EnergieSim VPS setup ==="
echo ""

# Directory
mkdir -p /var/www/energie-tool
cd /var/www/energie-tool

# Node.js check
if ! command -v node &> /dev/null; then
  echo "Node.js installeren..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node.js $(node --version)"

# Maak package.json
cat > package.json << 'PKGJSON'
{
  "name": "energiesim",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2"
  }
}
PKGJSON

# Haal de bestanden op via curl (raw GitHub content)
echo "Bestanden downloaden..."
curl -sL -o server.js "https://raw.githubusercontent.com/pascalvandenakker/energie-tool/main/server.js" 2>/dev/null || true
curl -sL -o index.html "https://raw.githubusercontent.com/pascalvandenakker/energie-tool/main/index.html" 2>/dev/null || true
curl -sL -o zonneplan-api.js "https://raw.githubusercontent.com/pascalvandenakker/energie-tool/main/zonneplan-api.js" 2>/dev/null || true
curl -sL -o energyzero-api.js "https://raw.githubusercontent.com/pascalvandenakker/energie-tool/main/energyzero-api.js" 2>/dev/null || true

# Check of downloads gelukt zijn, anders fallback naar lokale upload instructie
if [ ! -f server.js ] || [ ! -f index.html ]; then
  echo ""
  echo "=== BESTANDEN NIET GEVONDEN OP GITHUB ==="
  echo "Upload de bestanden eerst via hPanel File Manager naar /var/www/energie-tool/"
  echo "Of push naar GitHub en run dit script opnieuw."
  echo ""
  echo "Bestanden om te uploaden uit C:\Weppas\projects\energie-tool\:"
  echo "  - server.js"
  echo "  - index.html"
  echo "  - zonneplan-api.js"
  echo "  - energyzero-api.js"
  echo "  - package.json (wordt al aangemaakt)"
  echo ""
  exit 1
fi

# npm install
echo "Dependencies installeren..."
npm install

# PM2
echo "PM2 installeren en starten..."
npm install -g pm2
pm2 delete energie-tool 2>/dev/null || true
pm2 start server.js --name energie-tool
pm2 save
pm2 startup systemd 2>/dev/null | tail -1

echo ""
echo "=== Server draait op http://$(hostname -I | awk '{print $1}'):3000 ==="

# Nginx (optioneel, voor subdomein)
if command -v nginx &> /dev/null; then
  echo ""
  echo "Nginx configureren..."
  DOMAIN="energie.weppas.nl"
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
  nginx -t && systemctl restart nginx
  echo "Nginx draait voor $DOMAIN"

  # SSL
  if command -v certbot &> /dev/null; then
    certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email pascal@weppas.nl 2>/dev/null || \
    echo "SSL later handmatig: sudo certbot --nginx -d $DOMAIN"
  fi
fi

echo ""
echo "=== KLAAR! ==="
echo "Open http://$(hostname -I | awk '{print $1}'):3000"
echo "Of https://energie.weppas.nl (als DNS + SSL werkten)"
