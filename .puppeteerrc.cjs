const { join } = require('path');

/**
 * Puppeteer configuration for cloud deployment (Render, etc.)
 * This ensures Chrome is installed to a local directory we control
 */
module.exports = {
    cacheDirectory: join(__dirname, '.puppeteer_cache'),
};
