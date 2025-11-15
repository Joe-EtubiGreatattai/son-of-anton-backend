// server.js - Complete with Cart Feature Implementation
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

const corsOptions = {
    origin: [
        'https://son-of-anton-chat.vercel.app',
        'http://localhost:3000',
        'http://localhost:8080',
        'http://localhost:5173',
    ],
    credentials: true,
    optionsSuccessStatus: 200
};

app.use(express.json());
app.use(cors(corsOptions));

// Load API keys and configuration from environment variables
const SERP_API_KEY = process.env.SERP_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sonofanton';
const SERP_BASE_URL = 'https://serpapi.com/search';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// Search frequency configuration
const SEARCH_FREQUENCY_HOURS = parseInt(process.env.SEARCH_FREQUENCY_HOURS) || 6;
const SEARCH_FREQUENCY_MINUTES = parseInt(process.env.SEARCH_FREQUENCY_MINUTES) || null;
const MIN_SEARCH_INTERVAL = 0.0667;
const MAX_SEARCH_INTERVAL = 24 * 7;

// Affiliate configuration
const AFFILIATE_CONFIGS = {
    amazon: {
        enabled: process.env.AMAZON_AFFILIATE_ENABLED === 'true',
        tag: process.env.AMAZON_AFFILIATE_TAG || 'your-tag-20',
        domains: ['amazon.com', 'amazon.co.uk', 'amazon.ca', 'amazon.de', 'amazon.fr', 'amzn.to']
    },
    ebay: {
        enabled: process.env.EBAY_AFFILIATE_ENABLED === 'true',
        campaignId: process.env.EBAY_CAMPAIGN_ID || 'your-campaign-id',
        domains: ['ebay.com', 'ebay.co.uk', 'ebay.ca', 'ebay.de']
    },
    walmart: {
        enabled: process.env.WALMART_AFFILIATE_ENABLED === 'true',
        publisherId: process.env.WALMART_PUBLISHER_ID || 'your-publisher-id',
        domains: ['walmart.com']
    }
};

// Calculate the cron interval
function getCronInterval() {
    if (SEARCH_FREQUENCY_MINUTES) {
        return SEARCH_FREQUENCY_MINUTES * 60 * 1000;
    }
    return SEARCH_FREQUENCY_HOURS * 60 * 60 * 1000;
}

const CRON_INTERVAL = getCronInterval();

// Validate search frequency
function validateSearchFrequency() {
    let frequencyHours = SEARCH_FREQUENCY_HOURS;

    if (SEARCH_FREQUENCY_MINUTES) {
        frequencyHours = SEARCH_FREQUENCY_MINUTES / 60;
    }

    if (frequencyHours < MIN_SEARCH_INTERVAL) {
        console.warn(`⚠️  Search frequency (${frequencyHours}h) is below minimum (${MIN_SEARCH_INTERVAL}h). Using minimum frequency.`);
        return MIN_SEARCH_INTERVAL * 60 * 60 * 1000;
    }

    if (frequencyHours > MAX_SEARCH_INTERVAL) {
        console.warn(`⚠️  Search frequency (${frequencyHours}h) exceeds maximum (${MAX_SEARCH_INTERVAL}h). Using maximum frequency.`);
        return MAX_SEARCH_INTERVAL * 60 * 60 * 1000;
    }

    return CRON_INTERVAL;
}

const VALIDATED_CRON_INTERVAL = validateSearchFrequency();

// Email configuration
const { transporter, sendDealEmail } = require('./email-utils');

// Validate required environment variables
if (!SERP_API_KEY) {
    console.error('❌ ERROR: SERP_API_KEY is not set in environment variables');
    process.exit(1);
}

if (!GOOGLE_API_KEY) {
    console.error('❌ ERROR: GOOGLE_API_KEY is not set in environment variables');
    process.exit(1);
}

// MongoDB connection
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => {
        console.error('❌ MongoDB connection error:', err);
        process.exit(1);
    });

// MongoDB Schemas
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    searchPreferences: {
        frequencyHours: { type: Number, default: 6 },
        notifyOnDeals: { type: Boolean, default: true },
        maxPriceAlerts: { type: Boolean, default: true },
        quickSearchMode: { type: Boolean, default: true }
    }
});

const conversationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: String, required: true },
    messages: [{
        role: { type: String, enum: ['user', 'model'], required: true },
        content: { type: String, required: true },
        timestamp: { type: Date, default: Date.now }
    }],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const searchPartySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    itemName: { type: String, required: true },
    searchQuery: { type: String, required: true },
    maxPrice: { type: Number },
    preferences: { type: String },
    isActive: { type: Boolean, default: true },
    lastSearched: { type: Date, default: Date.now },
    searchFrequency: { type: Number, default: null },
    foundResults: [{
        title: String,
        price: Number,
        source: String,
        link: String,
        image: String,
        rating: String,
        reviews: String,
        foundAt: { type: Date, default: Date.now }
    }],
    createdAt: { type: Date, default: Date.now }
});

// Click Tracking Schema for Affiliate Analytics
const clickTrackingSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sessionId: { type: String },
    productTitle: { type: String, required: true },
    originalLink: { type: String, required: true },
    affiliateLink: { type: String, required: true },
    source: { type: String, required: true },
    price: { type: Number },
    searchQuery: { type: String },
    clicked: { type: Boolean, default: false },
    clickedAt: { type: Date },
    userAgent: { type: String },
    ipAddress: { type: String },
    createdAt: { type: Date, default: Date.now }
});

// Cart Schema
const cartSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    items: [{
        productId: { type: String, required: true },
        title: { type: String, required: true },
        price: { type: Number, required: true },
        quantity: { type: Number, default: 1, min: 1 },
        source: { type: String, required: true },
        link: { type: String, required: true },
        image: { type: String },
        rating: { type: String },
        reviews: { type: String },
        inStock: { type: Boolean, default: true },
        lastStockCheck: { type: Date, default: Date.now },
        addedAt: { type: Date, default: Date.now }
    }],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Stock Check History Schema
const stockCheckSchema = new mongoose.Schema({
    cartItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cart.items' },
    productTitle: { type: String, required: true },
    inStock: { type: Boolean, required: true },
    price: { type: Number },
    checkedAt: { type: Date, default: Date.now },
    source: { type: String }
});

const User = mongoose.model('User', userSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);
const SearchParty = mongoose.model('SearchParty', searchPartySchema);
const ClickTracking = mongoose.model('ClickTracking', clickTrackingSchema);
const Cart = mongoose.model('Cart', cartSchema);
const StockCheck = mongoose.model('StockCheck', stockCheckSchema);

// Store active sessions in memory
const activeSessions = new Map();

// Display configuration
function displaySearchConfiguration() {
    console.log('\n🔍 SEARCH CONFIGURATION:');
    if (SEARCH_FREQUENCY_MINUTES) {
        console.log(`   Frequency: Every ${SEARCH_FREQUENCY_MINUTES} minutes`);
    } else {
        console.log(`   Frequency: Every ${SEARCH_FREQUENCY_HOURS} hours`);
    }
    console.log(`   Minimum interval: ${MIN_SEARCH_INTERVAL} hour`);
    console.log(`   Maximum interval: ${MAX_SEARCH_INTERVAL} hours (1 week)`);
    console.log(`   Next search in: ${VALIDATED_CRON_INTERVAL / (60 * 1000)} minutes\n`);
}

function displayAffiliateConfiguration() {
    console.log('💰 AFFILIATE CONFIGURATION:');
    console.log(`   Amazon: ${AFFILIATE_CONFIGS.amazon.enabled ? '✅ Enabled' : '❌ Disabled'} ${AFFILIATE_CONFIGS.amazon.enabled ? `(Tag: ${AFFILIATE_CONFIGS.amazon.tag})` : ''}`);
    console.log(`   eBay: ${AFFILIATE_CONFIGS.ebay.enabled ? '✅ Enabled' : '❌ Disabled'} ${AFFILIATE_CONFIGS.ebay.enabled ? `(Campaign: ${AFFILIATE_CONFIGS.ebay.campaignId})` : ''}`);
    console.log(`   Walmart: ${AFFILIATE_CONFIGS.walmart.enabled ? '✅ Enabled' : '❌ Disabled'} ${AFFILIATE_CONFIGS.walmart.enabled ? `(Publisher: ${AFFILIATE_CONFIGS.walmart.publisherId})` : ''}`);
    console.log('');
}

// Function to add affiliate parameters to links
function addAffiliateLink(originalLink, source) {
    if (!originalLink || originalLink === '#') {
        return originalLink;
    }

    try {
        const url = new URL(originalLink);
        const hostname = url.hostname.replace('www.', '').toLowerCase();

        // Amazon affiliate links
        if (AFFILIATE_CONFIGS.amazon.enabled &&
            AFFILIATE_CONFIGS.amazon.domains.some(domain => hostname.includes(domain))) {
            url.searchParams.set('tag', AFFILIATE_CONFIGS.amazon.tag);
            console.log(`🔗 Added Amazon affiliate tag to link`);
            return url.toString();
        }

        // eBay affiliate links
        if (AFFILIATE_CONFIGS.ebay.enabled &&
            AFFILIATE_CONFIGS.ebay.domains.some(domain => hostname.includes(domain))) {
            url.searchParams.set('mkcid', '1');
            url.searchParams.set('mkrid', '711-53200-19255-0');
            url.searchParams.set('siteid', '0');
            url.searchParams.set('campid', AFFILIATE_CONFIGS.ebay.campaignId);
            url.searchParams.set('toolid', '10001');
            console.log(`🔗 Added eBay affiliate parameters to link`);
            return url.toString();
        }

        // Walmart affiliate links
        if (AFFILIATE_CONFIGS.walmart.enabled &&
            hostname.includes('walmart.com')) {
            url.searchParams.set('affcampaignid', AFFILIATE_CONFIGS.walmart.publisherId);
            console.log(`🔗 Added Walmart affiliate parameter to link`);
            return url.toString();
        }

        return originalLink;
    } catch (error) {
        console.error('Error adding affiliate link:', error);
        return originalLink;
    }
}

// Function to create tracked affiliate link
async function createTrackedLink(deal, searchQuery, userId = null, sessionId = null) {
    try {
        const affiliateLink = addAffiliateLink(deal.link, deal.source);

        // Save to database for tracking
        const tracking = new ClickTracking({
            userId: userId,
            sessionId: sessionId,
            productTitle: deal.title,
            originalLink: deal.link,
            affiliateLink: affiliateLink,
            source: deal.source,
            price: deal.price,
            searchQuery: searchQuery
        });

        await tracking.save();

        // Return redirect URL through your domain
        return `/api/redirect/${tracking._id}`;
    } catch (error) {
        console.error('Error creating tracked link:', error);
        return deal.link;
    }
}

// Function to detect cart management commands
function isCartManagementCommand(message) {
    const cartCommands = [
        'clear cart', 'empty cart', 'remove from cart', 'delete from cart',
        'keep only', 'checkout only', 'clear everything except', 'clear all except',
        'remove the', 'delete the', 'take out', 'clear the rest', 'empty my cart',
        'clear my cart', 'show cart', 'view cart', 'what\'s in my cart'
    ];
    
    const lowerMessage = message.toLowerCase();
    
    return cartCommands.some(command => lowerMessage.includes(command));
}

// Function to parse cart commands
function parseCartCommand(message) {
    const lowerMessage = message.toLowerCase();
    
    // Show cart
    if (lowerMessage.includes('show cart') || 
        lowerMessage.includes('view cart') ||
        lowerMessage.includes('what\'s in my cart')) {
        return { action: 'show_cart' };
    }
    
    // Clear entire cart
    if (lowerMessage.includes('clear cart') || 
        lowerMessage.includes('empty cart') ||
        lowerMessage.includes('clear my cart') ||
        lowerMessage.includes('empty my cart') ||
        (lowerMessage.includes('clear everything') && !lowerMessage.includes('except'))) {
        return { action: 'clear_cart' };
    }
    
    // Keep only specific items
    if (lowerMessage.includes('keep only') || 
        lowerMessage.includes('checkout only') ||
        lowerMessage.includes('clear everything except') ||
        lowerMessage.includes('clear all except') ||
        lowerMessage.includes('clear the rest') ||
        lowerMessage.includes('i only want')) {
        
        // Extract items to keep
        let itemsToKeep = [];
        
        if (lowerMessage.includes('apple watch') || lowerMessage.includes('watch 9')) {
            itemsToKeep = ['apple watch', 'watch series 9', 'apple watch series 9'];
        }
        
        // More sophisticated parsing for other items
        const keepMatch = message.match(/keep only (.+?)(?:,|\.|$)/i) || 
                         message.match(/checkout only (.+?)(?:,|\.|$)/i) ||
                         message.match(/clear everything except (.+?)(?:,|\.|$)/i) ||
                         message.match(/clear all except (.+?)(?:,|\.|$)/i) ||
                         message.match(/i only want (.+?)(?:,|\.|$)/i);
        
        if (keepMatch && itemsToKeep.length === 0) {
            itemsToKeep = keepMatch[1].split(',').map(item => item.trim());
        }
        
        if (itemsToKeep.length > 0) {
            return { action: 'keep_only', items: itemsToKeep };
        }
    }
    
    // Remove specific items
    if (lowerMessage.includes('remove the') || 
        lowerMessage.includes('delete the') ||
        lowerMessage.includes('take out the')) {
        
        const removeMatch = message.match(/remove the (.+?)(?:,|\.|$)/i) || 
                           message.match(/delete the (.+?)(?:,|\.|$)/i) ||
                           message.match(/take out the (.+?)(?:,|\.|$)/i);
        
        if (removeMatch) {
            const itemsToRemove = removeMatch[1].split(',').map(item => item.trim());
            return { action: 'remove_items', items: itemsToRemove };
        }
    }
    
    return null;
}

// Redirect endpoint for affiliate tracking (NO AUTH REQUIRED)
app.get('/api/redirect/:trackingId', async (req, res) => {
    try {
        const { trackingId } = req.params;
        const tracking = await ClickTracking.findById(trackingId);

        if (!tracking) {
            return res.status(404).send('Link not found');
        }

        // Mark as clicked and save metadata
        tracking.clicked = true;
        tracking.clickedAt = new Date();
        tracking.userAgent = req.headers['user-agent'];
        tracking.ipAddress = req.ip || req.connection.remoteAddress;
        await tracking.save();

        // Log for analytics
        console.log(`🎯 AFFILIATE CLICK: "${tracking.productTitle}" - ${tracking.price} - ${tracking.source}`);

        // Redirect to affiliate link
        res.redirect(tracking.affiliateLink);
    } catch (error) {
        console.error('Redirect error:', error);
        res.status(500).send('Redirect failed');
    }
});

// Dynamic SYSTEM_PROMPT
const getSystemPrompt = (user, cart = null) => {
    const cartContext = cart && cart.items.length > 0 ?
        `\n\nCART CONTEXT - REMEMBER THIS:
The user has ${cart.items.length} item(s) in their cart totaling $${cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0).toFixed(2)}.
Items in cart: ${cart.items.map(item => `${item.title} (Qty: ${item.quantity})`).join(', ')}.

IMPORTANT CART BEHAVIORS:
1. When user is discussing purchases, gently remind them about cart items: "By the way, I noticed you have ${cart.items.length} item(s) in your cart. Want to review them before checking out?"
2. If they mention "checkout", "buy", or "purchase", offer to help with their cart items
3. If they ask about stock, offer to check their cart items
4. If they're searching for new items, suggest they might want to add to cart if it looks good
5. If they mention "cart", "shopping cart", or "basket", offer to show them their current items
6. When they add new items to cart, confirm and remind them of total items
7. If they want to remove items, use cart management commands (see below)` :
        '';

    const basePrompt = `You are "Son of Anton" - a super friendly, upbeat, and enthusiastic shopping assistant with tons of personality! ${cartContext}

YOUR PERSONALITY:
- You're excited about helping people find great deals! Use emojis and exclamation marks!
- You're very friendly and chatty - like talking to an enthusiastic best friend
- You understand users want quick results but also appreciate personalized recommendations
- You're knowledgeable and give personalized recommendations
- Keep responses SHORT and conversational - 2-3 sentences max unless providing detailed options

NEW QUICK SEARCH STRATEGY:
When users ask for products, follow this approach:

1. **IMMEDIATE ACTION**: Always start searching right away with a basic query based on what they mentioned
2. **OPTIONAL DETAILS**: While searching, ask if they want to provide more details for better results
3. **BALANCED APPROACH**: Don't ask multiple questions before searching - get them results first!

SPECIAL COMMANDS:
- When users want ongoing searches, say: "SEARCH_PARTY: [item description]|[max budget]|[preferences]|[frequency in hours]"
- When users want to remove cart items, say: "REMOVE_CART_ITEMS: [item names separated by commas]"
- When users want to keep only specific cart items, say: "KEEP_CART_ITEMS: [item names to keep separated by commas]"
- When users want to clear their entire cart, say: "CLEAR_CART"
- When users want to see their cart, say: "SHOW_CART"
- Only use SEARCH: when doing immediate single searches
- Keep all responses concise and friendly

CART MANAGEMENT EXAMPLES:
User: "remove the laptop from my cart"
You: "REMOVE_CART_ITEMS: laptop" + "I'll remove that laptop from your cart! 🛒"

User: "i only want to checkout the apple watch, clear the rest"
You: "KEEP_CART_ITEMS: apple watch" + "Perfect! I'll keep only your Apple Watch in the cart and remove everything else! 🛍️"

User: "empty my cart"
You: "CLEAR_CART" + "Clearing out your cart! 🧹 Your shopping cart is now empty."

User: "show my cart"
You: "SHOW_CART" + "Let me show you what's in your cart! 🛒"

MANAGING SEARCH PARTIES:
- When users ask about their search parties, respond with: "LIST_SEARCH_PARTIES"
- When users want to edit a search party, guide them to use the web interface
- When users ask to change frequency, explain they can do it per search party

QUICK SEARCH FORMAT:
When user mentions a product, respond with:
- Start immediate search with basic query
- Show quick results 
- Ask if they want to refine with: budget, brand preferences, specific features, etc.

Example approach:
User: "I need a new laptop"
You: "SEARCH: laptop deals today" + "Searching for laptops! 💻 Want to specify your budget or preferred brand for more tailored results?"

This gives them immediate value while keeping the door open for better personalization.`;

    if (user) {
        return `${basePrompt}

PERSONALIZATION:
- You are talking to ${user.username} (email: ${user.email})
- Always address them by their name when appropriate - use "${user.username}" naturally in conversation
- Remember their preferences from previous conversations
- Be extra personal and friendly since you know who you're talking to
- Reference past conversations or preferences if relevant
- Make them feel valued and remembered

Remember: You're Son of Anton - friendly, helpful, personal, and always making your responses look nice and easy to read!`;
    }

    return `${basePrompt}

Remember: You're Son of Anton - friendly, helpful, and always making your responses look nice and easy to read!`;
};

// Authentication middleware
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            req.user = await User.findById(decoded.userId);
        } catch (error) {
            console.error('Token verification error:', error);
        }
    }
    next();
};

// Auth routes
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        const existingUser = await User.findOne({
            $or: [{ email }, { username }]
        });

        if (existingUser) {
            return res.status(400).json({ error: 'User already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 12);
        const user = new User({ username, email, password: hashedPassword });
        await user.save();

        const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });

        res.status(201).json({
            message: 'User created successfully',
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                searchPreferences: user.searchPreferences
            }
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                searchPreferences: user.searchPreferences
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update user search preferences
app.put('/api/user/preferences', authenticateToken, async (req, res) => {
    try {
        const { frequencyHours, notifyOnDeals, maxPriceAlerts, quickSearchMode } = req.body;

        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const user = await User.findById(req.user._id);

        if (frequencyHours !== undefined) {
            if (frequencyHours < MIN_SEARCH_INTERVAL || frequencyHours > MAX_SEARCH_INTERVAL) {
                return res.status(400).json({
                    error: `Search frequency must be between ${MIN_SEARCH_INTERVAL} and ${MAX_SEARCH_INTERVAL} hours`
                });
            }
            user.searchPreferences.frequencyHours = frequencyHours;
        }

        if (notifyOnDeals !== undefined) {
            user.searchPreferences.notifyOnDeals = notifyOnDeals;
        }

        if (maxPriceAlerts !== undefined) {
            user.searchPreferences.maxPriceAlerts = maxPriceAlerts;
        }

        if (quickSearchMode !== undefined) {
            user.searchPreferences.quickSearchMode = quickSearchMode;
        }

        await user.save();

        res.json({
            message: 'Preferences updated successfully',
            searchPreferences: user.searchPreferences
        });
    } catch (error) {
        console.error('Update preferences error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get current search configuration
app.get('/api/search-config', authenticateToken, async (req, res) => {
    try {
        const userConfig = req.user ? req.user.searchPreferences : null;

        res.json({
            system: {
                frequencyHours: SEARCH_FREQUENCY_HOURS,
                frequencyMinutes: SEARCH_FREQUENCY_MINUTES,
                minInterval: MIN_SEARCH_INTERVAL,
                maxInterval: MAX_SEARCH_INTERVAL,
                currentInterval: VALIDATED_CRON_INTERVAL / (60 * 60 * 1000)
            },
            user: userConfig
        });
    } catch (error) {
        console.error('Get search config error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get affiliate statistics (admin endpoint)
app.get('/api/affiliate/stats', authenticateToken, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const totalTrackedLinks = await ClickTracking.countDocuments();
        const totalClicks = await ClickTracking.countDocuments({ clicked: true });
        const clickRate = totalTrackedLinks > 0 ? ((totalClicks / totalTrackedLinks) * 100).toFixed(2) : 0;

        const statsBySource = await ClickTracking.aggregate([
            {
                $group: {
                    _id: '$source',
                    totalClicks: { $sum: { $cond: ['$clicked', 1, 0] } },
                    totalProducts: { $sum: 1 },
                    avgPrice: { $avg: '$price' },
                    lastClick: { $max: '$clickedAt' }
                }
            },
            { $sort: { totalClicks: -1 } }
        ]);

        const topProducts = await ClickTracking.find({ clicked: true })
            .sort({ clickedAt: -1 })
            .limit(10)
            .select('productTitle price source clickedAt searchQuery');

        res.json({
            overview: {
                totalTrackedLinks,
                totalClicks,
                clickRate: `${clickRate}%`,
                potentialRevenue: `Varies by network`
            },
            bySource: statsBySource,
            topProducts: topProducts
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Cart endpoints
app.get('/api/cart', authenticateToken, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        let cart = await Cart.findOne({ userId: req.user._id });

        if (!cart) {
            cart = new Cart({ userId: req.user._id, items: [] });
            await cart.save();
        }

        res.json(cart);
    } catch (error) {
        console.error('Get cart error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/cart/add', authenticateToken, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const { productId, title, price, quantity = 1, source, link, image, rating, reviews } = req.body;

        if (!productId || !title || !price || !source || !link) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        let cart = await Cart.findOne({ userId: req.user._id });

        if (!cart) {
            cart = new Cart({ userId: req.user._id, items: [] });
        }

        // Check if item already exists in cart
        const existingItemIndex = cart.items.findIndex(item =>
            item.productId === productId && item.source === source
        );

        if (existingItemIndex > -1) {
            // Update quantity if item exists
            cart.items[existingItemIndex].quantity += quantity;
            cart.items[existingItemIndex].updatedAt = new Date();
        } else {
            // Add new item
            cart.items.push({
                productId,
                title,
                price,
                quantity,
                source,
                link,
                image,
                rating,
                reviews,
                inStock: true,
                lastStockCheck: new Date(),
                addedAt: new Date()
            });
        }

        cart.updatedAt = new Date();
        await cart.save();

        res.json({
            message: 'Item added to cart',
            cart: cart,
            totalItems: cart.items.reduce((sum, item) => sum + item.quantity, 0)
        });
    } catch (error) {
        console.error('Add to cart error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/cart/update/:itemId', authenticateToken, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const { itemId } = req.params;
        const { quantity } = req.body;

        if (!quantity || quantity < 1) {
            return res.status(400).json({ error: 'Invalid quantity' });
        }

        const cart = await Cart.findOne({ userId: req.user._id });

        if (!cart) {
            return res.status(404).json({ error: 'Cart not found' });
        }

        const item = cart.items.id(itemId);
        if (!item) {
            return res.status(404).json({ error: 'Item not found in cart' });
        }

        item.quantity = quantity;
        item.updatedAt = new Date();
        cart.updatedAt = new Date();

        await cart.save();

        res.json({
            message: 'Cart updated successfully',
            cart: cart
        });
    } catch (error) {
        console.error('Update cart error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/cart/remove/:itemId', authenticateToken, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const { itemId } = req.params;

        const cart = await Cart.findOne({ userId: req.user._id });

        if (!cart) {
            return res.status(404).json({ error: 'Cart not found' });
        }

        cart.items.pull({ _id: itemId });
        cart.updatedAt = new Date();

        await cart.save();

        res.json({
            message: 'Item removed from cart',
            cart: cart
        });
    } catch (error) {
        console.error('Remove from cart error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/cart/clear', authenticateToken, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const cart = await Cart.findOne({ userId: req.user._id });

        if (!cart) {
            return res.status(404).json({ error: 'Cart not found' });
        }

        cart.items = [];
        cart.updatedAt = new Date();

        await cart.save();

        res.json({
            message: 'Cart cleared successfully',
            cart: cart
        });
    } catch (error) {
        console.error('Clear cart error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Keep only specific items in cart
app.post('/api/cart/keep-only', authenticateToken, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const { itemsToKeep } = req.body;

        if (!itemsToKeep || !Array.isArray(itemsToKeep) || itemsToKeep.length === 0) {
            return res.status(400).json({ error: 'Items to keep are required' });
        }

        const cart = await Cart.findOne({ userId: req.user._id });

        if (!cart) {
            return res.status(404).json({ error: 'Cart not found' });
        }

        // Filter items to keep based on keyword matching
        const keptItems = cart.items.filter(item => {
            const itemTitle = item.title.toLowerCase();
            return itemsToKeep.some(keyword => 
                itemTitle.includes(keyword.toLowerCase())
            );
        });

        cart.items = keptItems;
        cart.updatedAt = new Date();

        await cart.save();

        res.json({
            message: `Cart updated - kept ${keptItems.length} item(s)`,
            cart: cart,
            keptItems: keptItems.map(item => item.title)
        });
    } catch (error) {
        console.error('Keep only cart error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Stock check endpoints
app.post('/api/cart/check-stock', authenticateToken, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const { itemId, checkAll = false } = req.body;

        const cart = await Cart.findOne({ userId: req.user._id });

        if (!cart) {
            return res.status(404).json({ error: 'Cart not found' });
        }

        const itemsToCheck = checkAll ? cart.items : [cart.items.id(itemId)];
        const stockResults = [];

        for (const item of itemsToCheck) {
            if (!item) continue;

            const wasInStock = item.inStock;
            // Simulate stock check - in real implementation, you'd call retailer APIs
            const isInStock = await checkProductStock(item.link, item.source);

            item.inStock = isInStock;
            item.lastStockCheck = new Date();

            // Record stock check history
            const stockCheck = new StockCheck({
                cartItemId: item._id,
                productTitle: item.title,
                inStock: isInStock,
                price: item.price,
                source: item.source
            });
            await stockCheck.save();

            stockResults.push({
                itemId: item._id,
                title: item.title,
                wasInStock,
                isInStock,
                price: item.price,
                source: item.source
            });
        }

        cart.updatedAt = new Date();
        await cart.save();

        res.json({
            message: checkAll ? 'Stock check completed for all items' : 'Stock check completed',
            results: stockResults
        });
    } catch (error) {
        console.error('Stock check error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Helper function to check product stock (placeholder implementation)
async function checkProductStock(link, source) {
    try {
        // This is a simplified implementation
        // In production, you'd integrate with retailer APIs or use web scraping

        console.log(`🔍 Checking stock for ${source} product...`);

        // Simulate API call delay
        await new Promise(resolve => setTimeout(resolve, 1000));

        // For demo purposes, return random stock status
        // In real implementation, you'd parse the actual product page
        const isInStock = Math.random() > 0.3; // 70% chance of being in stock

        console.log(`📦 Stock status for ${source}: ${isInStock ? 'IN STOCK' : 'OUT OF STOCK'}`);

        return isInStock;
    } catch (error) {
        console.error('Stock check error:', error);
        return false; // Assume out of stock if check fails
    }
}

// Helper function to send stock notification
async function sendStockNotification(user, item, wasInStock, isInStock) {
    try {
        if (!user.email || !user.searchPreferences.notifyOnDeals) {
            return;
        }

        const subject = wasInStock ?
            `❌ Out of Stock: ${item.title}` :
            `✅ Back in Stock: ${item.title}`;

        const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: ${wasInStock ? '#dc2626' : '#16a34a'};">${wasInStock ? '❌ Out of Stock' : '✅ Back in Stock'}</h2>
        <div style="border: 1px solid #e5e5e5; padding: 20px; border-radius: 8px;">
          <h3>${item.title}</h3>
          <p><strong>Price:</strong> $${item.price.toFixed(2)}</p>
          <p><strong>Store:</strong> ${item.source}</p>
          <p><strong>Status:</strong> ${isInStock ? 'In Stock' : 'Out of Stock'}</p>
          <a href="${item.link}" style="display: inline-block; background: #3b82f6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; margin-top: 10px;">
            View Product
          </a>
        </div>
        <p style="color: #6b7280; font-size: 14px; margin-top: 20px;">
          This notification was sent because you have this item in your cart.
        </p>
      </div>
    `;

        await transporter.sendMail({
            from: process.env.EMAIL_FROM,
            to: user.email,
            subject: subject,
            html: html
        });

        console.log(`📧 Stock notification sent to ${user.email}`);
    } catch (error) {
        console.error('Error sending stock notification:', error);
    }
}

// Helper function to send cart update notification
async function sendCartUpdateNotification(user, searchParty, addedCount) {
    try {
        if (!user.email || !user.searchPreferences.notifyOnDeals) {
            return;
        }

        const subject = `🛒 ${addedCount} Items Added to Cart from Search Party`;

        const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #3b82f6;">🎉 Search Party Results Added to Cart!</h2>
        <div style="border: 1px solid #e5e5e5; padding: 20px; border-radius: 8px;">
          <h3>Search Party: "${searchParty.itemName}"</h3>
          <p><strong>Items Added:</strong> ${addedCount}</p>
          <p>We found some great deals and automatically added them to your cart!</p>
          <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/cart" style="display: inline-block; background: #3b82f6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; margin-top: 10px;">
            View Your Cart
          </a>
        </div>
        <p style="color: #6b7280; font-size: 14px; margin-top: 20px;">
          You can review and manage these items in your cart anytime.
        </p>
      </div>
    `;

        await transporter.sendMail({
            from: process.env.EMAIL_FROM,
            to: user.email,
            subject: subject,
            html: html
        });

        console.log(`📧 Cart update notification sent to ${user.email}`);
    } catch (error) {
        console.error('Error sending cart update notification:', error);
    }
}

// Helper function to detect product search intent
function isProductSearchQuery(message) {
    const searchTriggers = [
        'find', 'search', 'look for', 'buy', 'purchase', 'shop for', 'get',
        'need', 'want', 'looking for', 'shopping for', 'deal', 'price',
        'cost', 'affordable', 'cheap', 'discount', 'sale'
    ];

    const productCategories = [
        'laptop', 'phone', 'tv', 'headphone', 'camera', 'tablet', 'watch',
        'game', 'console', 'book', 'clothing', 'shoe', 'furniture',
        'appliance', 'tool', 'electronic', 'computer', 'monitor',
        'keyboard', 'mouse', 'printer', 'speaker', 'earbud', 'airpod'
    ];

    const lowerMessage = message.toLowerCase();

    // Skip if this is a cart management command
    if (isCartManagementCommand(message)) {
        return false;
    }

    const hasSearchTrigger = searchTriggers.some(trigger =>
        lowerMessage.includes(trigger)
    );

    const hasProductCategory = productCategories.some(category =>
        lowerMessage.includes(category)
    );

    const productPatterns = [
        /\d+\s*(inch|gb|tb|mb|ghz)/i,
        /(rtx|gtx)\s*\d+/i,
        /(iphone|samsung|macbook|ipad|thinkpad|xps)/i,
        /\$\d+/,
        /under\s*\$\d+/i
    ];

    const hasProductPattern = productPatterns.some(pattern =>
        pattern.test(lowerMessage)
    );

    return hasSearchTrigger || hasProductCategory || hasProductPattern;
}

// Generate search query from user message
function generateSearchQuery(message) {
    const cleanedMessage = message.replace(
        /(can you |please |could you |i |want to |looking to |need to )?(find|search for|look for|get|buy|purchase)?\s*/gi,
        ''
    ).trim();

    if (cleanedMessage.length > 0) {
        return `${cleanedMessage} deals today`;
    }

    return `${message} shopping deals`;
}

// Chat endpoint
app.post('/api/chat', authenticateToken, async (req, res) => {
    try {
        const { message, sessionId } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const user = req.user;
        const session = sessionId || Date.now().toString();

        // Get user's cart for context
        let userCart = null;
        if (user) {
            userCart = await Cart.findOne({ userId: user._id });
        }

        // Check for cart management commands FIRST
        const cartCommand = isCartManagementCommand(message);
        if (cartCommand) {
            const parsedCommand = parseCartCommand(message);
            
            if (parsedCommand) {
                return res.json({
                    sessionId: session,
                    type: 'cart_command',
                    message: `I'll handle that cart request! 🛒`,
                    command: parsedCommand,
                    cart: userCart
                });
            }
        }

        let conversationHistory = [];
        let conversationDoc = null;

        if (user) {
            conversationDoc = await Conversation.findOne({ userId: user._id, sessionId: session });
            if (conversationDoc) {
                conversationHistory = conversationDoc.messages.map(msg => ({
                    role: msg.role,
                    parts: [{ text: msg.content }]
                }));
            }
        } else {
            if (!activeSessions.has(session)) {
                activeSessions.set(session, []);
            }
            conversationHistory = activeSessions.get(session) || [];
        }

        conversationHistory.push({
            role: 'user',
            parts: [{ text: message }]
        });

        if (user) {
            const userMessage = { role: 'user', content: message };
            if (!conversationDoc) {
                conversationDoc = new Conversation({
                    userId: user._id,
                    sessionId: session,
                    messages: [userMessage]
                });
            } else {
                conversationDoc.messages.push(userMessage);
                conversationDoc.updatedAt = new Date();
            }
            await conversationDoc.save();
        }

        const systemPrompt = getSystemPrompt(user, userCart);

        const response = await axios.post(
            `${GEMINI_URL}?key=${GOOGLE_API_KEY}`,
            {
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: systemPrompt }]
                    },
                    {
                        role: 'model',
                        parts: [{ text: 'Understood! I am Son of Anton, ready to help with shopping! 🛍️ I\'ll search immediately and offer refinements!' }]
                    },
                    ...conversationHistory
                ]
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        let aiResponse = response.data.candidates[0].content.parts[0].text;
        aiResponse = aiResponse.replace(/\*\*\*/g, '**');

        conversationHistory.push({
            role: 'model',
            parts: [{ text: aiResponse }]
        });

        if (user && conversationDoc) {
            const assistantMessage = { role: 'model', content: aiResponse };
            conversationDoc.messages.push(assistantMessage);
            conversationDoc.updatedAt = new Date();
            await conversationDoc.save();
        } else if (!user) {
            activeSessions.set(session, conversationHistory);
        }

        // Check if AI wants to list search parties
        if (aiResponse.includes('LIST_SEARCH_PARTIES')) {
            if (!user) {
                return res.json({
                    sessionId: session,
                    type: 'message',
                    message: "🔒 To view your search parties, you need to be logged in! Please create an account to save your ongoing searches."
                });
            }

            const searchParties = await SearchParty.find({ userId: user._id }).sort({ createdAt: -1 });

            if (searchParties.length === 0) {
                return res.json({
                    sessionId: session,
                    type: 'message',
                    message: `You don't have any active search parties yet, ${user.username}! 🎯\n\nWant to start one? Just tell me what you're looking for!`
                });
            }

            return res.json({
                sessionId: session,
                type: 'search_parties_list',
                message: `Here are your search parties, ${user.username}! 🎯`,
                searchParties: searchParties.map(party => ({
                    id: party._id,
                    itemName: party.itemName,
                    maxPrice: party.maxPrice,
                    preferences: party.preferences,
                    isActive: party.isActive,
                    searchFrequency: party.searchFrequency || user.searchPreferences.frequencyHours,
                    lastSearched: party.lastSearched,
                    foundResults: party.foundResults.length,
                    createdAt: party.createdAt
                }))
            });
        }

        // Check if AI wants to create a search party
        if (aiResponse.includes('SEARCH_PARTY:')) {
            if (!user) {
                return res.json({
                    sessionId: session,
                    type: 'message',
                    message: "🔒 To set up a Search Party, you need to be logged in! Please create an account to save your ongoing searches."
                });
            }

            const partyData = aiResponse.split('SEARCH_PARTY:')[1].trim().split('|');
            const itemName = partyData[0]?.trim();

            let maxPrice = null;
            if (partyData[1]) {
                const priceStr = partyData[1].trim().replace(/[$,]/g, '');
                const parsedPrice = parseFloat(priceStr);
                if (!isNaN(parsedPrice) && parsedPrice > 0) {
                    maxPrice = parsedPrice;
                }
            }

            const preferences = partyData[2]?.trim() || '';

            let frequency = user.searchPreferences.frequencyHours;
            if (partyData[3]) {
                const freqStr = partyData[3].trim();
                const parsedFreq = parseFloat(freqStr);
                if (!isNaN(parsedFreq) && parsedFreq >= MIN_SEARCH_INTERVAL && parsedFreq <= MAX_SEARCH_INTERVAL) {
                    frequency = parsedFreq;
                }
            }

            if (itemName) {
                const searchParty = new SearchParty({
                    userId: user._id,
                    itemName,
                    searchQuery: itemName,
                    ...(maxPrice !== null && { maxPrice }),
                    preferences,
                    searchFrequency: frequency
                });
                await searchParty.save();

                const priceMsg = maxPrice ? ` under ${maxPrice}` : '';
                const frequencyMsg = ` (searches every ${frequency} hours)`;

                return res.json({
                    sessionId: session,
                    type: 'message',
                    message: `🎉 Search Party started, ${user.username}! I'll keep looking for "${itemName}"${priceMsg}${frequencyMsg} and notify you when I find great deals!`
                });
            }
        }

        // Check if AI wants to show cart
        if (aiResponse.includes('SHOW_CART')) {
            if (!user) {
                return res.json({
                    sessionId: session,
                    type: 'message',
                    message: "🔒 To view your cart, you need to be logged in! Please create an account to save your shopping cart."
                });
            }

            const cart = await Cart.findOne({ userId: user._id });
            if (!cart || cart.items.length === 0) {
                return res.json({
                    sessionId: session,
                    type: 'message',
                    message: `Your cart is empty, ${user.username}! 🛒\n\nWant to start shopping? Just tell me what you're looking for!`
                });
            }

            const total = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            const itemCount = cart.items.reduce((sum, item) => sum + item.quantity, 0);

            return res.json({
                sessionId: session,
                type: 'cart_show',
                message: `Woohoo, ${user.username}! Let's take a peek at your amazing cart! You have **${itemCount} item(s)** in your cart right now, totaling **$${total.toFixed(2)}**!`,
                cart: cart
            });
        }

        // Check if AI wants to remove cart items
        if (aiResponse.includes('REMOVE_CART_ITEMS:')) {
            const itemsToRemove = aiResponse.split('REMOVE_CART_ITEMS:')[1].trim().split(',').map(item => item.trim());
            return res.json({ 
                type: 'cart_command', 
                action: 'remove_items', 
                items: itemsToRemove,
                message: `I'll remove those items from your cart! 🛒`
            });
        }

        // Check if AI wants to keep only specific cart items
        if (aiResponse.includes('KEEP_CART_ITEMS:')) {
            const itemsToKeep = aiResponse.split('KEEP_CART_ITEMS:')[1].trim().split(',').map(item => item.trim());
            return res.json({ 
                type: 'cart_command', 
                action: 'keep_only', 
                items: itemsToKeep,
                message: `Perfect! I'll keep only those items in your cart! 🛍️`
            });
        }

        // Check if AI wants to clear cart
        if (aiResponse.includes('CLEAR_CART')) {
            return res.json({ 
                type: 'cart_command', 
                action: 'clear_cart',
                message: `Clearing out your cart! 🧹 Your shopping cart is now empty.`
            });
        }

        // Check if this is a product search query
        const shouldSearch = isProductSearchQuery(message) && !aiResponse.includes('SEARCH:');

        if (shouldSearch) {
            const searchQuery = generateSearchQuery(message);
            const displayMessage = `Searching for "${searchQuery}"... 🔍\n\nHere are some quick results! Want to specify your budget, brand, or other preferences for more tailored options?`;

            const useQuickSearch = user ? user.searchPreferences.quickSearchMode : true;

            if (useQuickSearch) {
                const searchResults = await searchItem(searchQuery);
                const { deals, totalValid } = await findBestDeals(searchResults, searchQuery, user?._id, session);

                if (deals && deals.length > 0) {
                    const recommendation = await getAIRecommendation(deals, searchQuery, user);
                    const recommendationData = parseRecommendation(recommendation, deals);

                    return res.json({
                        sessionId: session,
                        type: 'recommendation',
                        message: displayMessage,
                        searchQuery,
                        deals: deals.slice(0, 6),
                        recommendation: recommendationData,
                        quickSearch: true
                    });
                } else {
                    return res.json({
                        sessionId: session,
                        type: 'message',
                        message: `Hmm, ${user ? user.username + ', ' : ''}couldn't find any deals for that. 🤔\n\nWant to try a different search or tell me more about what you're looking for?`
                    });
                }
            }
        }

        // Check if AI wants to search
        if (aiResponse.includes('SEARCH:')) {
            const searchQuery = aiResponse.split('SEARCH:')[1].trim();
            const displayMessage = aiResponse.split('SEARCH:')[0].trim() || `Searching for "${searchQuery}"... 🔍`;

            const searchResults = await searchItem(searchQuery);
            const { deals, totalValid } = await findBestDeals(searchResults, searchQuery, user?._id, session);

            if (deals && deals.length > 0) {
                const recommendation = await getAIRecommendation(deals, searchQuery, user);
                const recommendationData = parseRecommendation(recommendation, deals);

                return res.json({
                    sessionId: session,
                    type: 'recommendation',
                    message: formatDisplayMessage(displayMessage),
                    searchQuery,
                    deals: deals.slice(0, 6),
                    recommendation: recommendationData
                });
            } else {
                return res.json({
                    sessionId: session,
                    type: 'message',
                    message: `Hmm, ${user ? user.username + ', ' : ''}couldn't find any deals for that. 🤔\n\nWant to try a different search or adjust your requirements?`
                });
            }
        }

        // Regular response
        res.json({
            sessionId: session,
            type: 'message',
            message: aiResponse
        });

    } catch (error) {
        console.error('Chat error:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Something went wrong',
            details: error.response?.data?.error?.message || error.message
        });
    }
});

// Get user conversations
app.get('/api/conversations', authenticateToken, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const conversations = await Conversation.find({ userId: req.user._id })
            .sort({ updatedAt: -1 })
            .select('sessionId messages createdAt updatedAt');

        res.json(conversations);
    } catch (error) {
        console.error('Get conversations error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get single conversation by session ID
app.get('/api/conversations/:sessionId', authenticateToken, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const { sessionId } = req.params;
        const conversation = await Conversation.findOne({
            userId: req.user._id,
            sessionId: sessionId
        });

        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        res.json(conversation);
    } catch (error) {
        console.error('Get conversation error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get search parties
app.get('/api/search-parties', authenticateToken, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const searchParties = await SearchParty.find({ userId: req.user._id })
            .sort({ createdAt: -1 });

        res.json(searchParties);
    } catch (error) {
        console.error('Get search parties error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Toggle search party active status
app.put('/api/search-parties/:id/toggle', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const searchParty = await SearchParty.findOne({ _id: id, userId: req.user._id });

        if (!searchParty) {
            return res.status(404).json({ error: 'Search party not found' });
        }

        searchParty.isActive = !searchParty.isActive;
        await searchParty.save();

        res.json({
            message: `Search party ${searchParty.isActive ? 'activated' : 'paused'}`,
            searchParty
        });
    } catch (error) {
        console.error('Toggle search party error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update search party frequency
app.put('/api/search-parties/:id/frequency', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { frequencyHours } = req.body;

        if (!frequencyHours || frequencyHours < MIN_SEARCH_INTERVAL || frequencyHours > MAX_SEARCH_INTERVAL) {
            return res.status(400).json({
                error: `Frequency must be between ${MIN_SEARCH_INTERVAL} and ${MAX_SEARCH_INTERVAL} hours`
            });
        }

        const searchParty = await SearchParty.findOne({ _id: id, userId: req.user._id });

        if (!searchParty) {
            return res.status(404).json({ error: 'Search party not found' });
        }

        searchParty.searchFrequency = frequencyHours;
        await searchParty.save();

        res.json({
            message: `Search frequency updated to every ${frequencyHours} hours`,
            searchParty
        });
    } catch (error) {
        console.error('Update search frequency error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update search party details
app.put('/api/search-parties/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { itemName, maxPrice, preferences, isActive } = req.body;

        const searchParty = await SearchParty.findOne({ _id: id, userId: req.user._id });

        if (!searchParty) {
            return res.status(404).json({ error: 'Search party not found' });
        }

        if (itemName !== undefined) searchParty.itemName = itemName;
        if (maxPrice !== undefined) searchParty.maxPrice = maxPrice;
        if (preferences !== undefined) searchParty.preferences = preferences;
        if (isActive !== undefined) searchParty.isActive = isActive;

        await searchParty.save();

        res.json({
            message: 'Search party updated successfully',
            searchParty
        });
    } catch (error) {
        console.error('Update search party error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete search party
app.delete('/api/search-parties/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const searchParty = await SearchParty.findOne({ _id: id, userId: req.user._id });

        if (!searchParty) {
            return res.status(404).json({ error: 'Search party not found' });
        }

        await SearchParty.deleteOne({ _id: id });

        res.json({
            message: 'Search party deleted successfully'
        });
    } catch (error) {
        console.error('Delete search party error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Format display message
function formatDisplayMessage(message) {
    if (!message || message.trim() === '') {
        return "Let me search for that! 🔍";
    }
    return message;
}

// Search function
async function searchItem(itemName) {
    try {
        const response = await axios.get(SERP_BASE_URL, {
            params: {
                q: itemName,
                api_key: SERP_API_KEY,
                engine: 'google_shopping',
                num: 10
            }
        });
        return response.data;
    } catch (error) {
        console.error('Search error:', error.message);
        return null;
    }
}

// Function to generate a clean product URL slug from title
function generateProductSlug(title, source) {
    // Clean the title to create a URL-friendly slug
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-') // Replace multiple hyphens with single
        .substring(0, 60) // Limit length
        .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

    // Base URLs for different sources
    const baseUrls = {
        'amazon': 'https://amazon.com',
        'amazon.com': 'https://amazon.com',
        'ebay': 'https://ebay.com/itm',
        'ebay.com': 'https://ebay.com/itm',
        'walmart': 'https://walmart.com/ip',
        'walmart.com': 'https://walmart.com/ip',
        'best buy': 'https://bestbuy.com/site',
        'bestbuy': 'https://bestbuy.com/site',
        'bestbuy.com': 'https://bestbuy.com/site',
        'newegg': 'https://newegg.com/p',
        'newegg.com': 'https://newegg.com/p',
        'target': 'https://target.com/p',
        'target.com': 'https://target.com/p'
    };

    const sourceLower = source.toLowerCase().trim();

    // Find matching base URL
    let baseUrl = baseUrls[sourceLower];

    // If no exact match, check if source contains known retailer
    if (!baseUrl) {
        for (const [key, url] of Object.entries(baseUrls)) {
            if (sourceLower.includes(key)) {
                baseUrl = url;
                break;
            }
        }
    }

    // Default to a generic URL if no match found
    if (!baseUrl) {
        baseUrl = `https://${sourceLower.replace(/\s+/g, '')}.com`;
    }

    // Construct the full URL
    return `${baseUrl}/${slug}`;
}

// Function to validate and fix product links
function ensureValidProductLink(link, title, source) {
    // Check if link is missing, invalid, or just a placeholder
    if (!link || link === '#' || link.trim() === '' ||
        link.includes('placeholder') || link.length < 10) {
        console.log(`⚠️  Invalid link detected for "${title}" from ${source}, manufacturing new link...`);
        return generateProductSlug(title, source);
    }

    // Check if link is relative (doesn't start with http)
    if (!link.startsWith('http')) {
        console.log(`⚠️  Relative link detected for "${title}", converting to absolute...`);

        // Try to determine the domain from source
        const sourceLower = source.toLowerCase();
        let domain = 'amazon.com'; // default

        if (sourceLower.includes('ebay')) domain = 'ebay.com';
        else if (sourceLower.includes('walmart')) domain = 'walmart.com';
        else if (sourceLower.includes('best buy') || sourceLower.includes('bestbuy')) domain = 'bestbuy.com';
        else if (sourceLower.includes('newegg')) domain = 'newegg.com';
        else if (sourceLower.includes('target')) domain = 'target.com';
        else if (sourceLower.includes('amazon')) domain = 'amazon.com';

        return `https://${domain}${link}`;
    }

    return link;
}

// Find best deals with affiliate tracking
async function findBestDeals(results, searchQuery = '', userId = null, sessionId = null) {
    if (!results || !results.shopping_results) {
        return { deals: null, totalValid: null };
    }

    const shoppingResults = results.shopping_results;
    const validResults = [];

    for (const item of shoppingResults) {
        if (!item.price) continue;

        const priceStr = (typeof item.price === 'string') ? item.price.replace(/[$,]/g, '') : ('' + item.price);
        const price = parseFloat(priceStr);

        if (isNaN(price)) continue;

        const imageUrl = item.thumbnail || item.image || (item.images && item.images[0] && item.images[0].src) || (item.product && item.product.thumbnail) || null;
        const originalLink = item.link || item.url || (item.product && item.product.link) || '#';
        const source = item.source || item.merchant || item.store || 'Unknown';
        const title = item.title || 'Unknown Product';

        // ✅ ENSURE VALID LINK - manufacture if missing/invalid
        const validLink = ensureValidProductLink(originalLink, title, source);

        // ✅ ADD AFFILIATE CODE DIRECTLY TO THE VALID LINK
        const affiliateLink = addAffiliateLink(validLink, source);

        console.log(`🔗 Product: "${title.substring(0, 50)}..." → ${affiliateLink}`);

        // OPTIONAL: Still track clicks in database for analytics
        if (userId || sessionId) {
            try {
                const tracking = new ClickTracking({
                    userId: userId,
                    sessionId: sessionId,
                    productTitle: title,
                    originalLink: originalLink,
                    affiliateLink: affiliateLink,
                    source: source,
                    price: price,
                    searchQuery: searchQuery,
                    clicked: false
                });
                await tracking.save();
            } catch (error) {
                console.error('Error saving tracking data:', error);
            }
        }

        validResults.push({
            title: title,
            price: price,
            source: source,
            link: affiliateLink, // ✅ DIRECT AFFILIATE LINK WITH VALID URL
            image: imageUrl,
            rating: item.rating || 'N/A',
            reviews: item.reviews || 'N/A'
        });
    }

    if (validResults.length === 0) {
        return { deals: null, totalValid: null };
    }

    validResults.sort((a, b) => a.price - b.price);

    return {
        deals: validResults.slice(0, 10),
        totalValid: validResults.length
    };
}

// Get AI recommendation
async function getAIRecommendation(deals, searchQuery, user) {
    const dealsText = deals.map((deal, index) =>
        `${index + 1}. ${deal.title} - ${deal.price.toFixed(2)} from ${deal.source}${deal.rating !== 'N/A' ? ` (Rating: ${deal.rating}, ${deal.reviews} reviews)` : ''}`
    ).join('\n');

    const userContext = user ? `\n\nYou're making this recommendation for ${user.username}. Make it personal and friendly!` : '';

    const recommendPrompt = `Based on these search results for "${searchQuery}", recommend THE BEST SINGLE OPTION and explain why in a friendly, formatted way.${userContext}

${dealsText}

Consider: value for money (not just cheapest), ratings, reviews, and store reliability.

Format your response with:
- **Bold** for the key reasons
- Bullet points if listing multiple benefits
- Keep it enthusiastic and conversational
- Keep it SHORT - 2-3 sentences max
- ${user ? `Address ${user.username} personally if appropriate` : 'Be generally friendly'}

Respond with: RECOMMEND: [number]|[your formatted explanation]`;

    try {
        const response = await axios.post(
            `${GEMINI_URL}?key=${GOOGLE_API_KEY}`,
            {
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: recommendPrompt }]
                    }
                ]
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        let recommendation = response.data.candidates[0].content.parts[0].text;
        recommendation = recommendation.replace(/\*\*\*/g, '**');
        return recommendation;
    } catch (error) {
        console.error('Recommendation error:', error.message);
        return null;
    }
}

// Parse recommendation
function parseRecommendation(recommendation, deals) {
    if (!recommendation || !recommendation.includes('RECOMMEND:')) {
        return {
            deal: deals[0],
            reason: '**Great choice!** ✨\n\nThis option offers the **best value** based on:\n- Competitive pricing\n- Good availability\n- Reliable seller'
        };
    }

    const parts = recommendation.split('RECOMMEND:')[1].split('|');
    const recommendedIndex = parseInt(parts[0].trim()) - 1;
    let reason = parts[1]?.trim() || '**Great choice!** This is an excellent option! ✨';

    if (recommendedIndex >= 0 && recommendedIndex < deals.length) {
        return {
            deal: deals[recommendedIndex],
            reason: reason
        };
    }

    return {
        deal: deals[0],
        reason: reason
    };
}

// Function to add search party results to cart
async function addSearchPartyResultsToCart(userId, searchParty, deals) {
    try {
        let cart = await Cart.findOne({ userId: userId });

        if (!cart) {
            cart = new Cart({ userId: userId, items: [] });
        }

        let addedCount = 0;

        for (const deal of deals.slice(0, 3)) { // Add top 3 deals
            const productId = Buffer.from(`${deal.title}-${deal.source}`).toString('base64').slice(0, 20);

            // Check if already in cart
            const existingItem = cart.items.find(item =>
                item.productId === productId &&
                item.source === deal.source
            );

            if (!existingItem) {
                cart.items.push({
                    productId: productId,
                    title: deal.title,
                    price: deal.price,
                    quantity: 1,
                    source: deal.source,
                    link: deal.link,
                    image: deal.image,
                    rating: deal.rating,
                    reviews: deal.reviews,
                    inStock: true,
                    lastStockCheck: new Date(),
                    addedAt: new Date()
                });
                addedCount++;
            }
        }

        if (addedCount > 0) {
            cart.updatedAt = new Date();
            await cart.save();
            console.log(`🛒 Added ${addedCount} items from search party to cart`);

            // Notify user
            const user = await User.findById(userId);
            if (user && user.searchPreferences.notifyOnDeals) {
                await sendCartUpdateNotification(user, searchParty, addedCount);
            }
        }

        return addedCount;
    } catch (error) {
        console.error('Error adding search party results to cart:', error);
        return 0;
    }
}

// Reset session endpoint
app.post('/api/reset', authenticateToken, async (req, res) => {
    try {
        const { sessionId } = req.body;
        const user = req.user;

        if (user && sessionId) {
            await Conversation.deleteOne({ userId: user._id, sessionId: sessionId });
        } else if (sessionId) {
            activeSessions.delete(sessionId);
        }

        res.json({ message: 'Session reset successfully' });
    } catch (error) {
        console.error('Reset session error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Son of Anton API is running!',
        searchConfig: {
            frequency: SEARCH_FREQUENCY_MINUTES ?
                `${SEARCH_FREQUENCY_MINUTES} minutes` :
                `${SEARCH_FREQUENCY_HOURS} hours`,
            nextRunIn: `${VALIDATED_CRON_INTERVAL / (60 * 1000)} minutes`
        },
        affiliateConfig: {
            amazon: AFFILIATE_CONFIGS.amazon.enabled,
            ebay: AFFILIATE_CONFIGS.ebay.enabled,
            walmart: AFFILIATE_CONFIGS.walmart.enabled
        },
        features: {
            cart: true,
            stockChecking: true,
            searchParties: true,
            cartCommands: true
        }
    });
});

// Search Party Cron Job
async function runSearchParties() {
    try {
        console.log('🕐 CRON JOB: Starting Search Party execution...');

        const activeParties = await SearchParty.find({ isActive: true });

        console.log(`🔍 CRON JOB: Found ${activeParties.length} active search parties`);

        if (activeParties.length > 0) {
            console.log('📋 ACTIVE SEARCH PARTIES:');
            activeParties.forEach((party, index) => {
                const userFrequency = party.searchFrequency || SEARCH_FREQUENCY_HOURS;
                console.log(`   ${index + 1}. "${party.itemName}" - User: ${party.userId} - Frequency: ${userFrequency}h - Last Searched: ${party.lastSearched}`);
            });
        } else {
            console.log('   No active search parties found');
        }

        for (const party of activeParties) {
            const userFrequencyHours = party.searchFrequency || SEARCH_FREQUENCY_HOURS;
            const userFrequencyMs = userFrequencyHours * 60 * 60 * 1000;

            const timeSinceLastSearch = Date.now() - party.lastSearched.getTime();

            if (timeSinceLastSearch < userFrequencyMs) {
                const hoursSince = Math.round(timeSinceLastSearch / (60 * 60 * 1000));
                console.log(`⏭️  Skipping "${party.itemName}" - searched ${hoursSince}h ago (less than ${userFrequencyHours}h)`);
                continue;
            }

            console.log(`🔎 Searching for: "${party.itemName}" (User: ${party.userId}, Frequency: ${userFrequencyHours}h)`);

            const results = await searchItem(party.searchQuery);
            const { deals } = await findBestDeals(results, party.searchQuery, party.userId, null);

            if (deals && deals.length > 0) {
                const filteredDeals = party.maxPrice
                    ? deals.filter(deal => deal.price <= party.maxPrice)
                    : deals;

                console.log(`   Found ${deals.length} total deals, ${filteredDeals.length} after price filtering`);

                if (filteredDeals.length > 0) {
                    const user = await User.findById(party.userId);

                    // Add to cart automatically
                    const addedCount = await addSearchPartyResultsToCart(party.userId, party, filteredDeals);

                    if (addedCount > 0) {
                        console.log(`🛒 Automatically added ${addedCount} items to cart from search party`);
                    }

                    if (user && user.searchPreferences.notifyOnDeals) {
                        const emailSent = await sendDealEmail(user, party, filteredDeals.slice(0, 3));

                        if (emailSent) {
                            console.log(`📧 Email notification sent to ${user.email}`);
                        } else {
                            console.log(`❌ Failed to send email to ${user.email}`);
                        }
                    } else if (!user) {
                        console.log(`❌ User not found for ID: ${party.userId}`);
                    } else {
                        console.log(`📧 Email notifications disabled for user ${user.email}`);
                    }

                    const newResults = filteredDeals.slice(0, 3).map(deal => ({
                        title: deal.title,
                        price: deal.price,
                        source: deal.source,
                        link: deal.link,
                        image: deal.image,
                        rating: deal.rating,
                        reviews: deal.reviews,
                        foundAt: new Date()
                    }));

                    party.foundResults.push(...newResults);
                    party.lastSearched = new Date();
                    await party.save();

                    console.log(`✅ Saved ${newResults.length} new deals for "${party.itemName}"`);
                } else {
                    console.log(`❌ No deals found within price limit for "${party.itemName}"`);
                }
            } else {
                console.log(`❌ No deals found for "${party.itemName}"`);
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log('✅ CRON JOB: Search Party execution completed');
    } catch (error) {
        console.error('❌ CRON JOB: Search party cron error:', error);
    }
}

// Cart Stock Check Cron Job
async function checkCartItemsStock() {
    try {
        console.log('🔄 CRON JOB: Checking cart items stock...');

        const carts = await Cart.find({
            'items.0': { $exists: true } // Only carts with items
        }).populate('userId');

        console.log(`📦 Found ${carts.length} carts with items to check`);

        for (const cart of carts) {
            for (const item of cart.items) {
                // Check stock if it hasn't been checked in the last hour
                const timeSinceLastCheck = Date.now() - item.lastStockCheck.getTime();
                if (timeSinceLastCheck > 60 * 60 * 1000) { // 1 hour
                    const wasInStock = item.inStock;
                    const isInStock = await checkProductStock(item.link, item.source);

                    item.inStock = isInStock;
                    item.lastStockCheck = new Date();

                    // Record stock check
                    const stockCheck = new StockCheck({
                        cartItemId: item._id,
                        productTitle: item.title,
                        inStock: isInStock,
                        price: item.price,
                        source: item.source
                    });
                    await stockCheck.save();

                    // Notify user if stock status changed
                    if (wasInStock !== isInStock && cart.userId && cart.userId.searchPreferences.notifyOnDeals) {
                        await sendStockNotification(cart.userId, item, wasInStock, isInStock);
                    }

                    console.log(`📦 Stock check: "${item.title.substring(0, 30)}..." - ${isInStock ? 'IN STOCK' : 'OUT OF STOCK'}`);
                }
            }

            cart.updatedAt = new Date();
            await cart.save();
        }

        console.log('✅ CRON JOB: Cart stock check completed');
    } catch (error) {
        console.error('❌ CRON JOB: Cart stock check error:', error);
    }
}

module.exports = {
    sendDealEmail,
    formatDisplayMessage,
    searchItem,
    findBestDeals,
    getAIRecommendation,
    parseRecommendation,
    addAffiliateLink,
    createTrackedLink,
    generateProductSlug,
    ensureValidProductLink,
    Cart,
    StockCheck,
    checkProductStock,
    addSearchPartyResultsToCart,
    isCartManagementCommand,
    parseCartCommand
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Son of Anton API running on port ${PORT}`);
    displaySearchConfiguration();
    displayAffiliateConfiguration();
    console.log(`📡 Endpoints:`);
    console.log(`   POST /api/register - Create account`);
    console.log(`   POST /api/login - Login`);
    console.log(`   POST /api/chat - Send messages`);
    console.log(`   GET /api/conversations - Get conversation history`);
    console.log(`   GET /api/search-parties - Get search parties`);
    console.log(`   PUT /api/search-parties/:id/toggle - Toggle search party`);
    console.log(`   PUT /api/search-parties/:id/frequency - Update search frequency`);
    console.log(`   PUT /api/search-parties/:id - Update search party details`);
    console.log(`   DELETE /api/search-parties/:id - Delete search party`);
    console.log(`   PUT /api/user/preferences - Update user preferences`);
    console.log(`   GET /api/search-config - Get search configuration`);
    console.log(`   GET /api/redirect/:trackingId - Affiliate redirect (with tracking)`);
    console.log(`   GET /api/affiliate/stats - Get affiliate statistics`);
    console.log(`   POST /api/reset - Reset conversation`);
    console.log(`   GET /api/health - Health check`);
    console.log(`   🛒 CART ENDPOINTS:`);
    console.log(`   GET /api/cart - Get user cart`);
    console.log(`   POST /api/cart/add - Add item to cart`);
    console.log(`   PUT /api/cart/update/:itemId - Update cart item quantity`);
    console.log(`   DELETE /api/cart/remove/:itemId - Remove item from cart`);
    console.log(`   DELETE /api/cart/clear - Clear cart`);
    console.log(`   POST /api/cart/keep-only - Keep only specific items`);
    console.log(`   POST /api/cart/check-stock - Check stock for cart items`);
});

// Setup Search Party cron job
console.log(`⏰ Setting up Search Party cron job to run every ${VALIDATED_CRON_INTERVAL / (60 * 1000)} minutes`);

setInterval(() => {
    console.log(`\n🔄 CRON JOB: Scheduled Search Party execution started at ${new Date().toISOString()}`);
    runSearchParties();
}, VALIDATED_CRON_INTERVAL);

// Setup Cart Stock Check cron job
console.log(`⏰ Setting up Cart Stock Check cron job to run every hour`);

setInterval(() => {
    console.log(`\n🔄 CRON JOB: Scheduled Cart Stock Check at ${new Date().toISOString()}`);
    checkCartItemsStock();
}, 60 * 60 * 1000); // Check every hour

// Run immediately on startup
setTimeout(() => {
    console.log(`\n🚀 INITIAL CRON JOB: Running initial Search Party check at ${new Date().toISOString()}`);
    runSearchParties();

    console.log(`\n🚀 INITIAL CRON JOB: Running initial Cart Stock Check at ${new Date().toISOString()}`);
    checkCartItemsStock();
}, 5000);