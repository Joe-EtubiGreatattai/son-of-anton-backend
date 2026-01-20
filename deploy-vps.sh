#!/bin/bash

# Son of Anton Backend Deployment Script
# VPS: 46.175.147.124
# This script deploys the backend to your VPS server

set -e  # Exit on any error

echo "🚀 Starting Son of Anton Backend Deployment..."
echo "================================================"

# Configuration
APP_DIR="/var/www/sonofanton"
REPO_URL="YOUR_GITHUB_REPO_URL"  # Replace with actual repo URL
APP_NAME="sonofanton-backend"
NODE_VERSION="18"  # or your preferred version

echo "📦 Step 1: Installing Node.js and PM2..."
# Install Node.js if not present
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
    echo "✅ Node.js installed: $(node --version)"
else
    echo "✅ Node.js already installed: $(node --version)"
fi

# Install PM2 globally if not present
if ! command -v pm2 &> /dev/null; then
    npm install -g pm2
    echo "✅ PM2 installed"
else
    echo "✅ PM2 already installed"
fi

echo ""
echo "📂 Step 2: Setting up application directory..."
cd $APP_DIR

# Clone or pull repository
if [ -d "backend" ]; then
    echo "📥 Pulling latest changes..."
    cd backend
    git pull origin main
else
    echo "📥 Cloning repository..."
    git clone $REPO_URL backend
    cd backend
fi

echo ""
echo "📦 Step 3: Installing dependencies..."
npm install --production

echo ""
echo "🔧 Step 4: Setting up environment variables..."
# Create .env file if it doesn't exist
if [ ! -f ".env" ]; then
    cat > .env << 'EOL'
# MongoDB
MONGODB_URI=your_mongodb_uri_here

# Google API
GOOGLE_API_KEY=your_google_api_key

# JWT Secret
JWT_SECRET=your_jwt_secret_here

# Exchange Rate API
EXCHANGE_RATE_API_KEY=your_exchange_rate_key

# Clerk
CLERK_SECRET_KEY=your_clerk_secret_key

# Email (SendGrid)
SENDGRID_API_KEY=your_sendgrid_key
SENDGRID_FROM_EMAIL=your_email@domain.com
SENDGRID_FROM_NAME=Son of Anton

# Server
PORT=3000

# Scrapper URL  
SCRAPPER_URL=http://46.175.147.124:3001/api/search

# Search Frequency
SEARCH_FREQUENCY_MINUTES=10

# Exchange Rate Update
EXCHANGE_RATE_UPDATE_HOURS=6
EOL
    echo "⚠️  .env file created. Please update with your actual credentials!"
    echo "   Edit: nano $APP_DIR/backend/.env"
else
    echo "✅ .env file already exists"
fi

echo ""
echo "🔥 Step 5: Setting up PM2 process..."
# Stop existing process if running
pm2 delete $APP_NAME 2>/dev/null || true

# Start the application with PM2
pm2 start server.js --name $APP_NAME \
    --max-memory-restart 500M \
    --error /var/log/sonofanton-error.log \
    --output /var/log/sonofanton-output.log

# Save PM2 configuration
pm2 save

# Setup PM2 to start on system boot
pm2 startup systemd -u root --hp /root

echo ""
echo "🔒 Step 6: Setting up firewall..."
# Allow port 3000 (or your configured port)
ufw allow 3000/tcp 2>/dev/null || echo "UFW not installed or already configured"

echo ""
echo "================================================"
echo "✅ Deployment Complete!"
echo "================================================"
echo ""
echo "📊 Application Status:"
pm2 status

echo ""
echo "📝 Useful Commands:"
echo "  View logs:       pm2 logs $APP_NAME"
echo "  Restart:         pm2 restart $APP_NAME"
echo "  Stop:            pm2 stop $APP_NAME"
echo "  Monitor:         pm2 monit"
echo "  Check status:    pm2 status"
echo ""
echo "🌐 Your backend should be running at: http://46.175.147.124:3000"
echo ""
echo "⚠️  IMPORTANT: Don't forget to:"
echo "   1. Update .env file with real credentials"
echo "   2. Restart the app: pm2 restart $APP_NAME"
echo "   3. Update frontend to point to this server"
echo ""
