// server.js - Complete with Cart Feature Implementation
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const chalk = require('chalk');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const whatsappService = require('./services/whatsapp');
const aiService = require('./services/ai');

// Configure Multer for memory storage (direct upload to Gemini)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB Limit
});

const app = express();

// CORS Configuration - Allow requests from frontend domains
const allowedOrigins = [
    'http://localhost:8080',
    'http://localhost:5173',
    'http://localhost:3000',
    'https://www.sonofanton.live',
    'https://sonofanton.live',
    'https://sonofanton.live/'
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps, Postman, etc.)
        if (!origin) return callback(null, true);

        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('⚠️ Blocked CORS request from:', origin);
            callback(null, true); // Still allow for now, but log it
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Base URL health check
app.get('/', (req, res) => {
    res.send('Shopping Bot Backend is running! 🚀');
});

// Load API keys and configuration from environment variables
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const EXCHANGE_RATE_API_KEY = process.env.EXCHANGE_RATE_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

// Base URL for SerpAPI - REMOVED
// const SERP_BASE_URL = 'https://serpapi.com/search';

// Gemini configuration moved to aiService



// MongoDB connection
// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/chat_app';

// Search frequency configuration
const SEARCH_FREQUENCY_HOURS = parseInt(process.env.SEARCH_FREQUENCY_HOURS, 10) || null;
const SEARCH_FREQUENCY_MINUTES = parseInt(process.env.SEARCH_FREQUENCY_MINUTES, 10) || 10;

// Exchange rate update frequency configuration
const EXCHANGE_RATE_UPDATE_HOURS = parseInt(process.env.EXCHANGE_RATE_UPDATE_HOURS, 10) || 6;


// Affiliate configuration
const AFFILIATE_CONFIGS = {
    amazon: {
        enabled: true,
        tag: 'sagato-20',
        domains: ['amazon.com', 'amzn.to']
    },
    ebay: {
        enabled: false,
        campaignId: '',
        domains: ['ebay.com']
    },
    walmart: {
        enabled: false,
        publisherId: '',
        domains: ['walmart.com']
    }
};

// Amazon Product Advertising API (PA-API) setup - REMOVED

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
    if (!SEARCH_FREQUENCY_HOURS && !SEARCH_FREQUENCY_MINUTES) {
        console.error("❌ ERROR: SEARCH_FREQUENCY_HOURS or SEARCH_FREQUENCY_MINUTES environment variable is NOT set.");
        console.error("   Please set either one appropriately in your environment:");
        console.error("   - SEARCH_FREQUENCY_HOURS: number of hours between each search (e.g., 6 for every 6 hours).");
        console.error("   - SEARCH_FREQUENCY_MINUTES: number of minutes between each search (e.g., 30 for every 30 minutes).");
        console.error("   Without this configuration, the scheduled search job cannot be started.");
        return false;
    }

    if (SEARCH_FREQUENCY_HOURS && SEARCH_FREQUENCY_MINUTES) {
        console.warn("⚠️ WARNING: Both SEARCH_FREQUENCY_HOURS and SEARCH_FREQUENCY_MINUTES are set.");
        console.warn("   SEARCH_FREQUENCY_MINUTES will take precedence over SEARCH_FREQUENCY_HOURS.");
    }

    if (SEARCH_FREQUENCY_HOURS && SEARCH_FREQUENCY_HOURS <= 0) {
        console.error("❌ ERROR: SEARCH_FREQUENCY_HOURS must be a positive number.");
        return false;
    }

    if (SEARCH_FREQUENCY_MINUTES && SEARCH_FREQUENCY_MINUTES <= 0) {
        console.error("❌ ERROR: SEARCH_FREQUENCY_MINUTES must be a positive number.");
        return false;
    }

    console.log(`✅ Search frequency validated. Running every ${SEARCH_FREQUENCY_MINUTES || (SEARCH_FREQUENCY_HOURS * 60)} minutes.`);
    return true;
}

// Validate on startup
validateSearchFrequency();

// Connect to MongoDB
mongoose.connect(MONGO_URI)
    .then(() => {
        console.log('MongoDB connected');
        // Initialize Exchange Rates
        fetchAndStoreExchangeRates();
        // Start Scheduler
        startScheduler();
    })
    .catch((err) => console.error('MongoDB connection error:', err));

// User Schema and Model
const { ClerkExpressWithAuth } = require('@clerk/clerk-sdk-node');

// User Schema and Model
const userSchema = new mongoose.Schema({
    username: { type: String },
    email: { type: String, required: true, unique: true },
    phoneNumber: { type: String }, // Contact number for Search Party notifications
    clerkId: { type: String, unique: true, sparse: true }, // Added for Clerk integration
    password: { type: String },
    preferences: {
        budget: { type: Number, default: null },
        favoriteStores: { type: [String], default: [] },
        dislikedStores: { type: [String], default: [] },
        categories: { type: [String], default: [] },
        shoppingStyle: {
            type: String,
            enum: ['Best Deal', 'Fast Shipping', 'Trusted Brands', 'Balanced', 'Quality First'],
            default: 'Balanced',
        },
        country: { type: String, default: 'NG' }, // Default to Nigeria
    },
    searchPreferences: {
        quickSearchMode: { type: Boolean, default: true },
        minPrice: { type: Number, default: 0 },
        maxPrice: { type: Number, default: null },
        preferredStores: { type: [String], default: [] },
        avoidStores: { type: [String], default: [] },
        resultLimit: { type: Number, default: 10 },
        autoSearchOnOpen: { type: Boolean, default: true }
    },
    createdAt: { type: Date, default: Date.now },
    role: { type: String, enum: ['user', 'vendor'], default: 'user' }
});

// Model
const User = mongoose.model('User', userSchema);

// Party Schema and Model (Scheduled Search Configuration)
const partySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    itemName: { type: String, required: true },
    searchQuery: { type: String, required: true },
    searchFrequencyHours: { type: Number, default: 12 },
    aiStyle: { type: String, default: 'Balanced' },
    stores: { type: [String], default: ['amazon', 'ebay', 'walmart', 'bestbuy'] },
    maxPrice: { type: Number, default: null },
    minPrice: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    lastRunAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    notificationChannel: {
        type: String,
        enum: ['in_app', 'email', 'sms'],
        default: 'in_app'
    }
});

const Party = mongoose.model('Party', partySchema);

// Click Tracking Schema and Model
const clickTrackingSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
    sessionId: { type: String, required: false },
    productTitle: { type: String, required: true },
    originalLink: { type: String, required: true },
    affiliateLink: { type: String },
    source: { type: String, required: true },
    price: { type: Number },
    searchQuery: { type: String },
    clicked: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

const ClickTracking = mongoose.model('ClickTracking', clickTrackingSchema);

// Cart Schema and Model
const cartItemSchema = new mongoose.Schema({
    title: { type: String, required: true },
    source: { type: String, required: true },
    price: { type: Number, required: true },
    image: { type: String },
    link: { type: String, required: true },
    quantity: { type: Number, default: 1 }
}, { _id: false });

const cartSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sessionId: { type: String },
    items: [cartItemSchema],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

cartSchema.index({ userId: 1, sessionId: 1 }, { unique: true, sparse: true });

const Cart = mongoose.model('Cart', cartSchema);

// Party Notification Schema and Model
const partyNotificationSchema = new mongoose.Schema({
    partyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Party', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deals: [
        {
            title: String,
            price: Number,
            source: String,
            link: String,
            image: String,
            rating: String,
            reviews: String
        }
    ],
    searchQuery: { type: String, required: true },
    notificationMessage: { type: String, required: true },
    notificationChannel: {
        type: String,
        enum: ['in_app', 'email', 'sms'],
        default: 'in_app'
    },
    aiSummary: { type: String },
    createdAt: { type: Date, default: Date.now },
    read: { type: Boolean, default: false }
});

const PartyNotification = mongoose.model('PartyNotification', partyNotificationSchema);

// Exchange Rate Schema and Model
const exchangeRateSchema = new mongoose.Schema({
    baseCurrency: { type: String, required: true, unique: true, default: 'USD' },
    rates: { type: Map, of: Number, required: true },
    lastUpdated: { type: Date, default: Date.now }
});

const ExchangeRate = mongoose.model('ExchangeRate', exchangeRateSchema);

// Feedback Schema and Model
const feedbackSchema = new mongoose.Schema({
    messageId: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    query: { type: String },
    isPositive: { type: Boolean, required: true },
    feedbackText: { type: String },
    createdAt: { type: Date, default: Date.now }
});

const Feedback = mongoose.model('Feedback', feedbackSchema);

// Conversation Schema and Model (Chat History)
const conversationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: String, required: true },
    title: { type: String },
    messages: [
        {
            role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
            content: { type: String, required: true }, // Can be text or JSON string for complex UI
            timestamp: { type: Date, default: Date.now },
            metadata: { type: mongoose.Schema.Types.Mixed } // For storing product details, etc.
        }
    ],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

conversationSchema.index({ userId: 1, sessionId: 1 });
const Conversation = mongoose.model('Conversation', conversationSchema);

// --- API Endpoints ---

// Submit Feedback
app.post('/api/feedback', async (req, res) => {
    try {
        const { messageId, query, isPositive, feedbackText } = req.body;
        const userId = req.userId; // Optional, from auth middleware if available

        const feedback = new Feedback({
            messageId,
            userId,
            query,
            isPositive,
            feedbackText
        });

        await feedback.save();
        res.status(201).json({ success: true, message: 'Feedback submitted' });
    } catch (error) {
        console.error('Error submitting feedback:', error);
        res.status(500).json({ error: 'Failed to submit feedback' });
    }
});

// Get all feedback (Admin)
app.get('/api/admin/feedback', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const totalCount = await Feedback.countDocuments();
        const totalPages = Math.ceil(totalCount / limit);

        const feedback = await Feedback.find()
            .populate('userId', 'username email')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        res.json({
            feedback,
            totalCount,
            totalPages,
            currentPage: page
        });
    } catch (error) {
        console.error('Error fetching feedback:', error);
        res.status(500).json({ error: 'Failed to fetch feedback' });
    }
});

// Track interest (clicks on View button)
app.post('/api/track-view', async (req, res) => {
    try {
        const { productTitle, source, price, originalLink, affiliateLink, searchQuery, sessionId } = req.body;
        const userId = req.userId || req.body.userId;

        const tracking = new ClickTracking({
            userId,
            sessionId,
            productTitle,
            source,
            price,
            originalLink,
            affiliateLink,
            searchQuery,
            clicked: true // Mark as clicked immediately
        });

        await tracking.save();
        res.status(201).json({ success: true, message: 'View tracked' });
    } catch (error) {
        console.error('Track view error:', error);
        res.status(500).json({ error: 'Failed to track view' });
    }
});

// Get all clicks (Admin)
app.get('/api/admin/clicks', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const totalCount = await ClickTracking.countDocuments({ clicked: true });
        const totalPages = Math.ceil(totalCount / limit);

        const clicks = await ClickTracking.find({ clicked: true })
            .populate('userId', 'username email')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        res.json({
            clicks,
            totalCount,
            totalPages,
            currentPage: page
        });
    } catch (error) {
        console.error('Error fetching clicks:', error);
        res.status(500).json({ error: 'Failed to fetch click data' });
    }
});
// Product Schema and Model (Vendor Uploaded)
const productSchema = new mongoose.Schema({
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    description: { type: String },
    price: { type: Number, required: true },
    category: { type: String },
    image: { type: String }, // URL or base64
    stock: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});

productSchema.index({ title: 'text', description: 'text' });
const Product = mongoose.model('Product', productSchema);

// --- LEGACY AUTH ENDPOINTS (Restored) ---

// Register Endpoint
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, username, preferences } = req.body;

        // Check if user exists
        let user = await User.findOne({ email });
        if (user) {
            return res.status(400).json({ error: 'User already exists' });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create new user
        user = new User({
            username: username || email.split('@')[0],
            email,
            password: hashedPassword,
            preferences: preferences || {}
        });

        await user.save();

        // Create JWT token
        const token = jwt.sign(
            { userId: user._id, email: user.email },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.status(201).json({
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                preferences: user.preferences
            }
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Server error during registration' });
    }
});

// Login Endpoint
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Check if user exists
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        // Check password (only if user has a password set - i.e. not just a Clerk user)
        if (!user.password) {
            return res.status(400).json({ error: 'Please login using your social account (Clerk)' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        // Create JWT token
        const token = jwt.sign(
            { userId: user._id, email: user.email },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                preferences: user.preferences,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error during login' });
    }
});

// ----------------------------------------


// Middleware to authenticate and retrieve user from token
// Updated to support Clerk authentication
const authenticateToken = async (req, res, next) => {
    // Exclude auth routes from token verification
    if (req.path.startsWith('/api/auth')) {
        return next();
    }

    // 1. Try Clerk Authentication first
    ClerkExpressWithAuth({ loose: true })(req, res, async (err) => {
        if (err) {
            console.error('Clerk auth error:', err);
            return next(); // Continue, potentially as unauthenticated or try legacy
        }

        if (req.auth && req.auth.userId) {
            console.log('✅ Clerk Verified User:', req.auth.userId);

            // Try to find the user in our DB by clerkId
            let user = await User.findOne({ clerkId: req.auth.userId });

            if (user) {
                req.userId = user._id;
                req.user = user;
                return next();
            } else {
                console.log('⚠️ Clerk User verified but not found in MongoDB via clerkId.');
                // Optional: You could look up by email match here if you had the email claim
                // For now, we allow the request to proceed, but req.userId is null (or we could set req.clerkId)
                // This means protected routes depending on req.userId might fail, which is expected until sync.
            }
        }

        // 2. Fallback to Legacy JWT Authentication (for existing users/tokens)
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            try {
                // If it's a short legacy token, this might work. 
                // Clerk tokens are also JWTs, so verify() might fail with "invalid signature" if using LOCAL secret vs Clerk Key.
                const decoded = jwt.verify(token, JWT_SECRET);
                req.userId = decoded.userId;
                console.log('✅ Legacy JWT Verified User:', req.userId);
            } catch (err) {
                // Quietly fail legacy check if it was intended for Clerk
                if (!req.auth?.userId) {
                    console.log('Legacy JWT verification failed (and no Clerk session).');
                }
                req.userId = null;
            }
        } else {
            if (!req.auth?.userId) {
                req.userId = null;
            }
        }

        next();
    });
};

app.use(authenticateToken);

// Legacy Search Functions (SerpAPI/Amazon/eBay/Jumia/Konga) - REMOVED
// Please rely on /api/search which calls the external Custom Search API.


// Search Local Vendor Products
async function searchLocalProducts(searchQuery) {
    try {
        console.log(`🏠 Searching Local Vendor Products for: "${searchQuery}"`);
        // Basic text search using regex for now, or text index if configured
        const products = await Product.find({
            $or: [
                { title: { $regex: searchQuery, $options: 'i' } },
                { description: { $regex: searchQuery, $options: 'i' } }
            ]
        }).limit(20);

        const mappedProducts = products.map(p => ({
            title: p.title,
            price: p.price,
            source: 'Vendor', // Or specific vendor name if we populate it
            link: `/product/${p._id}`, // Frontend route for details
            thumbnail: p.image || null,
            rating: 'N/A',
            reviews: 'N/A',
            isLocal: true,
            id: p._id,
            description: p.description
        }));

        console.log(`✅ Found ${mappedProducts.length} local products`);
        return mappedProducts;
    } catch (error) {
        console.error('Error searching local products:', error.message);
        return [];
    }
}

// Helper to prioritize Jumia and interleave other Nigerian results
async function prioritizeResults(allResults, country = 'NG') {
    if (!allResults || allResults.length === 0) return [];

    const nigerianResults = allResults.filter(r => r.isNigerian);
    const foreignResults = allResults.filter(r => !r.isNigerian);

    // For non-Nigerian users, return all results combined
    if (country !== 'NG') {
        return [...foreignResults, ...nigerianResults];
    }

    const jumiaResults = nigerianResults.filter(r => r.source && r.source.toLowerCase().includes('jumia'));
    const kongaResults = nigerianResults.filter(r => r.source && r.source.toLowerCase().includes('konga'));
    const ajeboResults = nigerianResults.filter(r => r.source && r.source.toLowerCase().includes('ajebo'));
    const dexResults = nigerianResults.filter(r => r.source && r.source.toLowerCase().includes('dexstitches'));
    const jijiResults = nigerianResults.filter(r => r.source && r.source.toLowerCase().includes('jiji'));
    const slotResults = nigerianResults.filter(r => r.source && r.source.toLowerCase().includes('slot'));
    const otherNGResults = nigerianResults.filter(r => !jumiaResults.includes(r) && !kongaResults.includes(r) && !ajeboResults.includes(r) && !dexResults.includes(r) && !jijiResults.includes(r) && !slotResults.includes(r));

    const interleavedNigerian = [];
    const maxNG = Math.max(kongaResults.length, ajeboResults.length, dexResults.length, jijiResults.length, slotResults.length, otherNGResults.length);
    for (let i = 0; i < maxNG; i++) {
        if (kongaResults[i]) interleavedNigerian.push(kongaResults[i]);
        if (ajeboResults[i]) interleavedNigerian.push(ajeboResults[i]);
        if (dexResults[i]) interleavedNigerian.push(dexResults[i]);
        if (jijiResults[i]) interleavedNigerian.push(jijiResults[i]);
        if (slotResults[i]) interleavedNigerian.push(slotResults[i]);
        if (otherNGResults[i]) interleavedNigerian.push(otherNGResults[i]);
    }

    // Blending Logic: Jumia first, then 90% other Nigerian (interleaved), 10% International
    const blendedResults = [...jumiaResults]; // Prioritize ALL Jumia results at the top
    let ngIndex = 0;
    let foreignIndex = 0;

    while (ngIndex < interleavedNigerian.length || foreignIndex < foreignResults.length) {
        // Add up to 9 Nigerian items
        for (let i = 0; i < 9; i++) {
            if (ngIndex < interleavedNigerian.length) {
                blendedResults.push(interleavedNigerian[ngIndex++]);
            }
        }
        // Add 1 International item
        if (foreignIndex < foreignResults.length) {
            blendedResults.push(foreignResults[foreignIndex++]);
        }
    }

    return blendedResults;
}

// Unified search: Nigerian platforms (Jumia, Konga) + Amazon + Google Shopping
async function searchAllSources(searchQuery, user = null, category = 'other') {
    // Default to Nigeria for all searches
    const country = user?.preferences?.country || 'NG';

    console.log(`🌍 Searching with country preference: ${country}`);

    // Call Local Search and New External Search API in parallel
    const externalApiUrl = `http://localhost:${process.env.PORT || 3000}/api/search`;
    console.log(`🌐 Calling External Search API at: ${externalApiUrl}`);

    const [localProducts, apiData] = await Promise.all([
        searchLocalProducts(searchQuery).catch(err => {
            console.error('Local search error:', err.message);
            return [];
        }),
        axios.get(externalApiUrl, {
            params: { q: searchQuery, category: category || 'other' }
        }).then(res => res.data).catch(err => {
            console.error(`External Search API error for ${externalApiUrl}:`, err.message);
            return { results: [] };
        })
    ]);

    const apiResults = apiData?.results || [];
    const processedResults = [];

    // Process Local Results
    for (const p of localProducts) {
        processedResults.push({ ...p, isNigerian: true });
    }

    // Helper to parse price string
    const parsePrice = (str) => {
        if (typeof str === 'number') return { val: str, cur: 'USD' };
        if (!str) return { val: 0, cur: 'USD' };
        let cur = 'USD';
        if (str.includes('EUR') || str.includes('€')) cur = 'EUR';
        if (str.includes('NGN') || str.includes('₦')) cur = 'NGN';
        if (str.includes('GBP') || str.includes('£')) cur = 'GBP';
        const numStr = str.replace(/[^0-9.]/g, '');
        const val = parseFloat(numStr) || 0;
        return { val, cur };
    };

    for (const item of apiResults) {
        const { val, cur: detectedCur } = parsePrice(item.price);
        const isNigerianSource = ['Jumia', 'Jiji', 'Konga', 'Slot', 'Ajebo', 'DexStitches'].some(s => item.source && item.source.includes(s));
        const cur = (isNigerianSource && (!item.price || (!item.price.includes('$') && !item.price.includes('€') && !item.price.includes('£')))) ? 'NGN' : detectedCur;

        let finalPrice = val;
        if (country === 'NG' && cur !== 'NGN' && typeof convertToNGN === 'function') {
            finalPrice = await convertToNGN(val, cur);
        }

        processedResults.push({
            price: finalPrice,
            thumbnail: item.thumbnail || item.img,
            link: item.link,
            source: item.source,
            title: item.title,
            rating: item.rating,
            reviews: 'N/A',
            isNigerian: isNigerianSource,
            originalPrice: val,
            originalCurrency: cur
        });
    }

    const blendedResults = await prioritizeResults(processedResults, country);
    return { shopping_results: blendedResults };
}

// Helper function to generate JWT token
function generateToken(user) {
    return jwt.sign(
        { userId: user._id, email: user.email },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

// Base Route
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>Welcome to the Shopping Bot API 🛒</h1>
            <p>Your AI-powered shopping assistant backend is running smoothly.</p>
            <p>Time: ${new Date().toLocaleString()}</p>
        </div>
    `);
});

// Register Route
app.post('/api/register', async (req, res) => {
    try {
        console.log('➡️ Register request received:', req.body ? req.body.email : 'No body');
        const { username, email, password, preferences, role } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: 'User with that email already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const user = new User({
            username,
            email,
            password: hashedPassword,
            preferences,
            role: role || 'user'
        });

        console.log('💾 Attempting to save user to database...');
        const savedUser = await user.save();
        console.log('✅ User saved successfully:', savedUser._id, savedUser.email, 'Role:', savedUser.role);

        const token = generateToken(savedUser);

        res.status(201).json({
            message: 'User registered successfully',
            user: {
                id: savedUser._id,
                username: savedUser.username,
                email: savedUser.email,
                preferences: savedUser.preferences,
                searchPreferences: savedUser.searchPreferences,
                role: savedUser.role
            },
            token
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login Route
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const user = await User.findOne({ email });
        if (!user || !user.password) {
            return res.status(400).json({ error: 'Invalid credentials or user registered with OAuth' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const token = generateToken(user);

        res.json({
            message: 'Login successful',
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                preferences: user.preferences,
                searchPreferences: user.searchPreferences
            },
            token
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Google OAuth Registration/Login
app.post('/api/google-auth', async (req, res) => {
    try {
        const { email, name } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        let user = await User.findOne({ email });

        if (!user) {
            user = new User({
                username: name || email.split('@')[0],
                email,
                preferences: {
                    shoppingStyle: 'Balanced'
                }
            });
            await user.save();
        }

        const token = generateToken(user);

        res.json({
            message: 'Authentication successful',
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                preferences: user.preferences,
                searchPreferences: user.searchPreferences
            },
            token
        });
    } catch (error) {
        console.error('Google auth error:', error);
        res.status(500).json({ error: 'Google authentication failed' });
    }
});

// --- User Data Sync Endpoints ---

// Sync Local Data (Cart, Messages) to Backend
app.post('/api/user/sync', authenticateToken, async (req, res) => {
    try {
        const userId = req.userId;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const { cart, messages, preferences, sessionId, conversationTitle } = req.body;

        console.log(`🔄 Syncing data for user ${userId}...`);

        // 1. Sync Preferences
        if (preferences) {
            await User.findByIdAndUpdate(userId, { $set: { preferences } });
        }

        // 2. Sync Cart
        if (cart && cart.length > 0) {
            let userCart = await Cart.findOne({ userId });
            if (!userCart) {
                userCart = new Cart({ userId, items: cart });
            } else {
                // Effective merge:
                // Map existing cloud items by link/id
                const cloudItemsMap = new Map(userCart.items.map(i => [i.link, i]));

                cart.forEach(localItem => {
                    if (!cloudItemsMap.has(localItem.link)) {
                        userCart.items.push(localItem);
                    }
                });
            }
            userCart.updatedAt = Date.now();
            await userCart.save();
        }

        // 3. Sync Conversation/Messages
        if (sessionId && messages && messages.length > 0) {
            // Helper to handle various date formats (including "14:03" strings)
            const parseTimestamp = (ts) => {
                if (!ts) return new Date();
                if (ts instanceof Date) return ts;

                // If it's a string like "14:03" or "2:30 PM", convert to today's date
                if (typeof ts === 'string') {
                    const timeMatch = ts.match(/^(\d{1,2}):(\d{2})(\s?[APap][Mm])?$/);
                    if (timeMatch) {
                        const now = new Date();
                        let hours = parseInt(timeMatch[1]);
                        const minutes = parseInt(timeMatch[2]);
                        const period = timeMatch[3];

                        if (period) {
                            if (period.toLowerCase().includes('pm') && hours < 12) hours += 12;
                            if (period.toLowerCase().includes('am') && hours === 12) hours = 0;
                        }

                        now.setHours(hours, minutes, 0, 0);
                        return now;
                    }
                    // Try standard date parse
                    const parsed = new Date(ts);
                    if (!isNaN(parsed.getTime())) return parsed;
                }

                return new Date(); // Fallback
            };

            // Prepare messages
            const formattedMessages = messages.map(m => ({
                role: m.role || (m.isBot ? 'assistant' : 'user'),
                content: m.text || m.content,
                timestamp: parseTimestamp(m.timestamp),
                metadata: m
            }));

            // Use findOneAndUpdate with upsert to avoid duplicate key errors
            await Conversation.findOneAndUpdate(
                { sessionId }, // Find by sessionId (unique index)
                {
                    $set: {
                        userId,
                        messages: formattedMessages,
                        updatedAt: new Date(),
                        ...(conversationTitle && { title: conversationTitle })
                    },
                    $setOnInsert: {
                        title: conversationTitle || 'New Conversation',
                        createdAt: new Date()
                    }
                },
                { upsert: true, new: true }
            );
        }

        res.json({ success: true, message: 'Data synced successfully' });
    } catch (error) {
        console.error('Sync error:', error);
        res.status(500).json({ error: 'Sync failed' });
    }
});

// Get User Data (Cart, History)
app.get('/api/user/data', authenticateToken, async (req, res) => {
    try {
        const userId = req.userId;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const [user, cart, conversations] = await Promise.all([
            User.findById(userId).select('preferences searchPreferences'),
            Cart.findOne({ userId }),
            Conversation.find({ userId }).sort({ updatedAt: -1 }).limit(10) // Get last 10 convos
        ]);

        res.json({
            preferences: user?.preferences || {},
            searchPreferences: user?.searchPreferences || {},
            cart: cart?.items || [],
            conversations: conversations.map(c => ({
                sessionId: c.sessionId,
                title: c.title,
                messages: c.messages,
                updatedAt: c.updatedAt
            }))
        });
    } catch (error) {
        console.error('Fetch user data error:', error);
        res.status(500).json({ error: 'Failed to fetch user data' });
    }
});

// Get Current User Profile
app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        if (!req.userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const user = await User.findById(req.userId).select('-password');

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ user });
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({ error: 'Failed to fetch user profile' });
    }
});

// Update User Preferences
app.put('/api/user/preferences', authenticateToken, async (req, res) => {
    try {
        if (!req.userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { preferences, phoneNumber } = req.body;

        const updateData = { $set: { preferences } };

        if (phoneNumber !== undefined) {
            updateData.$set.phoneNumber = phoneNumber;
        }

        const user = await User.findByIdAndUpdate(
            req.userId,
            updateData,
            { new: true }
        ).select('-password');

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            message: 'Preferences updated successfully',
            user
        });
    } catch (error) {
        console.error('Update preferences error:', error);
        res.status(500).json({ error: 'Failed to update preferences' });
    }
});

// Update Search Preferences
app.put('/api/user/search-preferences', authenticateToken, async (req, res) => {
    try {
        if (!req.userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { searchPreferences } = req.body;

        const user = await User.findByIdAndUpdate(
            req.userId,
            { $set: { searchPreferences } },
            { new: true }
        ).select('-password');

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            message: 'Search preferences updated successfully',
            user
        });
    } catch (error) {
        console.error('Update search preferences error:', error);
        res.status(500).json({ error: 'Failed to update search preferences' });
    }
});

// Save Cart (Create or Update)
app.post('/api/cart', async (req, res) => {
    try {
        const { userId, sessionId, items } = req.body;

        if (!userId && !sessionId) {
            return res.status(400).json({ error: 'Either userId or sessionId is required' });
        }

        let cart = await Cart.findOne({ $or: [{ userId }, { sessionId }] });

        if (!cart) {
            cart = new Cart({
                userId: userId || undefined,
                sessionId: sessionId || undefined,
                items,
                createdAt: new Date(),
                updatedAt: new Date()
            });
        } else {
            cart.items = items;
            cart.updatedAt = new Date();
        }

        await cart.save();
        res.json({ message: 'Cart saved successfully', cart });
    } catch (error) {
        console.error('Save cart error:', error);
        res.status(500).json({ error: 'Failed to save cart' });
    }
});

// Get Cart
app.get('/api/cart', async (req, res) => {
    try {
        const { userId, sessionId } = req.query;

        if (!userId && !sessionId) {
            return res.status(400).json({ error: 'Either userId or sessionId is required' });
        }

        const cart = await Cart.findOne({ $or: [{ userId }, { sessionId }] });

        if (!cart) {
            return res.json({ items: [] });
        }

        res.json({ items: cart.items });
    } catch (error) {
        console.error('Get cart error:', error);
        res.status(500).json({ error: 'Failed to retrieve cart' });
    }
});

// Clear Cart
app.delete('/api/cart', async (req, res) => {
    try {
        const { userId, sessionId } = req.query;

        if (!userId && !sessionId) {
            return res.status(400).json({ error: 'Either userId or sessionId is required' });
        }

        await Cart.findOneAndDelete({ $or: [{ userId }, { sessionId }] });
        res.json({ message: 'Cart cleared successfully' });
    } catch (error) {
        console.error('Clear cart error:', error);
        res.status(500).json({ error: 'Failed to clear cart' });
    }
});

// Create a scheduled search (Party)
app.post('/api/party', authenticateToken, async (req, res) => {
    try {
        const { itemName, searchQuery, searchFrequencyHours, aiStyle, stores, maxPrice, minPrice, notificationChannel } = req.body;

        if (!req.userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        if (!itemName || !searchQuery) {
            return res.status(400).json({ error: 'Item name and search query are required' });
        }

        const party = new Party({
            userId: req.userId,
            itemName,
            searchQuery,
            searchFrequencyHours: searchFrequencyHours || 12,
            aiStyle: aiStyle || 'Balanced',
            stores: stores && stores.length ? stores : ['amazon', 'ebay', 'walmart', 'bestbuy'],
            maxPrice: maxPrice || null,
            minPrice: minPrice || 0,
            notificationChannel: notificationChannel || 'in_app'
        });

        await party.save();

        res.status(201).json({
            message: 'Party created successfully',
            party
        });
    } catch (error) {
        console.error('Create party error:', error);
        res.status(500).json({ error: 'Failed to create party' });
    }
});

// Get user's scheduled searches (Parties)
app.get('/api/party', authenticateToken, async (req, res) => {
    try {
        if (!req.userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const parties = await Party.find({ userId: req.userId });

        res.json({ parties });
    } catch (error) {
        console.error('Get parties error:', error);
        res.status(500).json({ error: 'Failed to retrieve parties' });
    }
});

// Update a scheduled search (Party)
app.put('/api/party/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { itemName, searchQuery, searchFrequencyHours, aiStyle, stores, maxPrice, minPrice, active, notificationChannel } = req.body;

        if (!req.userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const party = await Party.findOneAndUpdate(
            { _id: id, userId: req.userId },
            {
                $set: {
                    itemName,
                    searchQuery,
                    searchFrequencyHours,
                    aiStyle,
                    stores,
                    maxPrice,
                    minPrice,
                    active,
                    notificationChannel
                }
            },
            { new: true }
        );

        if (!party) {
            return res.status(404).json({ error: 'Party not found' });
        }

        res.json({
            message: 'Party updated successfully',
            party
        });
    } catch (error) {
        console.error('Update party error:', error);
        res.status(500).json({ error: 'Failed to update party' });
    }
});

// Delete a scheduled search (Party)
app.delete('/api/party/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        if (!req.userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const result = await Party.findOneAndDelete({ _id: id, userId: req.userId });

        if (!result) {
            return res.status(404).json({ error: 'Party not found' });
        }

        res.json({ message: 'Party deleted successfully' });
    } catch (error) {
        console.error('Delete party error:', error);
        res.status(500).json({ error: 'Failed to delete party' });
    }
});

// Alias endpoint for frontend compatibility - Get search parties
app.get('/api/search-parties', authenticateToken, async (req, res) => {
    try {
        if (!req.userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const parties = await Party.find({ userId: req.userId })
            .sort({ createdAt: -1 });

        // Transform data to match frontend expectations
        const transformedParties = parties.map(party => ({
            _id: party._id,
            itemName: party.itemName,
            searchQuery: party.searchQuery,
            maxPrice: party.maxPrice,
            preferences: party.aiStyle || '', // Map aiStyle to preferences
            isActive: party.active, // Map active to isActive
            lastSearched: party.lastRunAt || party.createdAt, // Map lastRunAt to lastSearched
            foundResults: [], // Initialize empty array for foundResults
            createdAt: party.createdAt
        }));

        res.json(transformedParties);
    } catch (error) {
        console.error('Get search parties error:', error);
        res.status(500).json({ error: 'Failed to retrieve search parties' });
    }
});

// Toggle search party active status
app.put('/api/search-parties/:id/toggle', authenticateToken, async (req, res) => {
    try {
        if (!req.userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { id } = req.params;
        const party = await Party.findOne({ _id: id, userId: req.userId });

        if (!party) {
            return res.status(404).json({ error: 'Party not found' });
        }

        party.active = !party.active;
        await party.save();

        res.json({
            message: 'Party status updated',
            party
        });
    } catch (error) {
        console.error('Toggle party error:', error);
        res.status(500).json({ error: 'Failed to toggle party status' });
    }
});


// Get notifications for a user
app.get('/api/party-notifications', authenticateToken, async (req, res) => {
    try {
        if (!req.userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const notifications = await PartyNotification.find({ userId: req.userId })
            .sort({ createdAt: -1 })
            .limit(50);

        res.json({ notifications });
    } catch (error) {
        console.error('Get notifications error:', error);
        res.status(500).json({ error: 'Failed to retrieve notifications' });
    }
});

// Mark notification as read
app.put('/api/party-notifications/:id/read', authenticateToken, async (req, res) => {
    try {
        if (!req.userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { id } = req.params;

        const notification = await PartyNotification.findOneAndUpdate(
            { _id: id, userId: req.userId },
            { $set: { read: true } },
            { new: true }
        );

        if (!notification) {
            return res.status(404).json({ error: 'Notification not found' });
        }

        res.json({ message: 'Notification marked as read', notification });
    } catch (error) {
        console.error('Mark notification as read error:', error);
        res.status(500).json({ error: 'Failed to update notification' });
    }
});

// Get user's conversation history
app.get('/api/conversations', authenticateToken, async (req, res) => {
    try {
        if (!req.userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const conversations = await Conversation.find({ userId: req.userId })
            .sort({ updatedAt: -1 })
            .limit(50);

        res.json(conversations);
    } catch (error) {
        console.error('Get conversations error:', error);
        res.status(500).json({ error: 'Failed to retrieve conversations' });
    }
});

// Get specific conversation by sessionId
app.get('/api/conversations/:sessionId', authenticateToken, async (req, res) => {
    try {
        if (!req.userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { sessionId } = req.params;
        const conversation = await Conversation.findOne({
            sessionId,
            userId: req.userId
        });

        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        res.json(conversation);
    } catch (error) {
        console.error('Get conversation error:', error);
        res.status(500).json({ error: 'Failed to retrieve conversation' });
    }
});

// Create a shared link
app.post('/api/share/create', async (req, res) => {
    try {
        const { type, data } = req.body;

        console.log('📤 Share link creation request:', { type, data: typeof data === 'string' ? data.substring(0, 50) : data });

        if (!['conversation', 'product', 'comparison_winner'].includes(type)) {
            return res.status(400).json({ error: 'Invalid share type' });
        }

        // Validate conversation exists if sharing a conversation
        if (type === 'conversation') {
            if (!data || typeof data !== 'string') {
                console.error('❌ Invalid conversation data:', data);
                return res.status(400).json({ error: 'Invalid conversation data. SessionId is required.' });
            }

            const conversation = await Conversation.findOne({ sessionId: data });
            if (!conversation) {
                console.error('❌ Conversation not found for sessionId:', data);
                return res.status(404).json({ error: 'Conversation not found. Please ensure you have sent at least one message.' });
            }
            console.log('✅ Conversation found:', conversation._id);
        }

        // Generate a short random ID (8 chars)
        const shareId = Math.random().toString(36).substring(2, 10);

        // Get userId if authenticated (optional)
        let userId = null;
        const authHeader = req.headers['authorization'];
        if (authHeader) {
            const token = authHeader.split(' ')[1];
            if (token) {
                jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
                    if (!err) userId = user.userId;
                });
            }
        }

        const sharedLink = new SharedLink({
            shareId,
            type,
            data,
            userId
        });

        await sharedLink.save();

        const shareUrl = `https://sonofanton.live/share/${shareId}`;
        console.log('✅ Share link created:', shareUrl);

        res.json({ shareId, url: shareUrl });
    } catch (error) {
        console.error('Create share link error:', error);
        res.status(500).json({ error: 'Failed to create share link' });
    }
});

// Get shared content
app.get('/api/share/:shareId', async (req, res) => {
    try {
        const { shareId } = req.params;

        console.log('🔍 Share link request for:', shareId);

        const sharedLink = await SharedLink.findOne({ shareId });

        if (!sharedLink) {
            console.error('❌ Share link not found:', shareId);
            return res.status(404).json({ error: 'Share link not found or has expired' });
        }

        console.log('✅ Share link found:', { type: sharedLink.type, createdAt: sharedLink.createdAt });

        // Increment views
        sharedLink.views += 1;
        await sharedLink.save();

        let content = sharedLink.data;

        // If it's a conversation, fetch the actual conversation data
        if (sharedLink.type === 'conversation' && typeof sharedLink.data === 'string') {
            console.log('📖 Fetching conversation with sessionId:', sharedLink.data);
            const conversation = await Conversation.findOne({ sessionId: sharedLink.data });
            if (conversation) {
                console.log('✅ Conversation found with', conversation.messages.length, 'messages');
                content = conversation;
            } else {
                console.error('❌ Original conversation not found for sessionId:', sharedLink.data);
                return res.status(404).json({ error: 'Original conversation has been deleted or is no longer available' });
            }
        }

        res.json({
            type: sharedLink.type,
            data: content,
            createdAt: sharedLink.createdAt
        });
    } catch (error) {
        console.error('Get shared content error:', error);
        res.status(500).json({ error: 'Failed to retrieve shared content' });
    }
});


// Generate a contextual session ID (simplified)
function generateSessionId(req) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown-ip';
    const userAgent = req.headers['user-agent'] || 'unknown-ua';
    // Basic hashing
    return Buffer.from(`${ip}-${userAgent}-${Date.now()}`).toString('base64').slice(0, 32);
}

// Store conversation history (per session or user)
const conversationHistory = new Map();

// Search Result Schema for persistent caching
const searchResultSchema = new mongoose.Schema({
    query: { type: String, required: true, unique: true, index: true },
    deals: [
        {
            title: String,
            price: Number,
            source: String,
            link: String,
            image: String,
            rating: String,
            reviews: String
        }
    ],
    totalValid: Number,
    aiDealSummary: String,
    lastUpdated: { type: Date, default: Date.now }
});

const SearchResult = mongoose.model('SearchResult', searchResultSchema);

// Conversation Schema for persistent storage


// Shared Link Schema for sharing content
const sharedLinkSchema = new mongoose.Schema({
    shareId: { type: String, unique: true, required: true, index: true },
    type: { type: String, enum: ['conversation', 'product'], required: true },
    data: { type: mongoose.Schema.Types.Mixed, required: true }, // sessionId for conversation, product object for product
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Optional, if user is logged in
    createdAt: { type: Date, default: Date.now },
    views: { type: Number, default: 0 }
});

const SharedLink = mongoose.model('SharedLink', sharedLinkSchema);

// Database cache configuration
const DB_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

async function getCachedSearch(query) {
    try {
        const normalizedQuery = query.toLowerCase().trim();
        const cached = await SearchResult.findOne({ query: normalizedQuery });

        if (cached && Date.now() - cached.lastUpdated.getTime() < DB_CACHE_TTL) {
            console.log(`✅ DB Cache hit for query: "${query}"`);
            return {
                deals: cached.deals,
                totalValid: cached.totalValid,
                aiDealSummary: cached.aiDealSummary
            };
        }

        if (cached) {
            console.log(`⏰ DB Cache expired for query: "${query}"`);
            // We don't delete immediately, we'll just overwrite it when we get new results
        }
        return null;
    } catch (error) {
        console.error('Cache read error:', error);
        return null;
    }
}

async function setCachedSearch(query, data) {
    try {
        const normalizedQuery = query.toLowerCase().trim();

        await SearchResult.findOneAndUpdate(
            { query: normalizedQuery },
            {
                deals: data.deals,
                totalValid: data.totalValid,
                aiDealSummary: data.aiDealSummary,
                lastUpdated: new Date()
            },
            { upsert: true, new: true }
        );
        console.log(`💾 Saved search results to DB for: "${query}"`);
    } catch (error) {
        console.error('Cache write error:', error);
    }
}



// Product search and AI helper functions moved to aiService

// Product search and AI helper functions moved to aiService

// Search function (SerpAPI / Google Shopping)
async function searchItem(itemName, country = 'US') {
    try {
        const params = {
            q: itemName,
            api_key: SERP_API_KEY,
            engine: 'google_shopping',
            num: 20 // Increased to get more results
        };

        if (country === 'NG') {
            params.gl = 'ng';
            params.google_domain = 'google.com.ng';
            params.currency = 'NGN';
            // Removed 'location' parameter as it can cause 400 errors if not exact
        }

        const response = await axios.get(SERP_BASE_URL, { params });
        return response.data;
    } catch (error) {
        console.error('Search error:', error.message);
        return null;
    }
}

// Validate and enhance product link
function ensureValidProductLink(originalLink, title, source) {
    try {
        if (!originalLink || typeof originalLink !== 'string' || originalLink.trim() === '' || originalLink === '#') {
            console.warn(`⚠️ Invalid or empty product link for "${title}". Attempting to manufacture a valid URL for ${source}.`);

            if (!source) {
                console.warn(`⚠️ No source provided for product "${title}", returning '#' as fallback.`);
                return '#';
            }

            const sourceLower = source.toLowerCase();

            const baseUrls = {
                'amazon': 'https://amazon.com',
                'amazon.com': 'https://amazon.com',
                'ebay': 'https://ebay.com/sch/i.html',
                'ebay.com': 'https://ebay.com/sch/i.html',
                'walmart': 'https://walmart.com/search',
                'walmart.com': 'https://walmart.com/search',
                'best buy': 'https://bestbuy.com/site/searchpage.jsp',
                'bestbuy': 'https://bestbuy.com/site/searchpage.jsp',
                'bestbuy.com': 'https://bestbuy.com/site/searchpage.jsp',
                'newegg': 'https://newegg.com/p',
                'newegg.com': 'https://newegg.com/p'
            };

            let baseUrl = baseUrls[sourceLower];

            if (!baseUrl) {
                for (const [key, url] of Object.entries(baseUrls)) {
                    if (sourceLower.includes(key)) {
                        baseUrl = url;
                        break;
                    }
                }
            }

            if (!baseUrl) {
                console.warn(`⚠️ Could not determine base URL for source "${source}". Using '#' as fallback.`);
                return '#';
            }

            const formattedQuery = encodeURIComponent(title.trim());
            let manufacturedUrl;

            if (sourceLower.includes('amazon')) {
                manufacturedUrl = `${baseUrl}/s?k=${formattedQuery}`;
            } else if (sourceLower.includes('ebay')) {
                manufacturedUrl = `${baseUrl}?_nkw=${formattedQuery}`;
            } else if (sourceLower.includes('walmart')) {
                manufacturedUrl = `${baseUrl}?query=${formattedQuery}`;
            } else if (sourceLower.includes('best')) {
                manufacturedUrl = `${baseUrl}?st=${formattedQuery}`;
            } else {
                manufacturedUrl = `${baseUrl}/${formattedQuery}`;
            }

            console.log(`✅ Manufactured new product link for "${title}": ${manufacturedUrl}`);
            return manufacturedUrl;
        }

        const url = new URL(originalLink);

        if (!url.protocol || !url.hostname) {
            console.warn(`⚠️ Invalid URL structure detected for "${title}". Attempting to repair.`);
            const hostname = url.hostname || 'example.com';
            const protocol = url.protocol || 'https:';
            url.protocol = protocol;
            if (!url.hostname) {
                url.hostname = hostname;
            }
            console.log(`✅ Repaired URL: ${url.toString()}`);
            return url.toString();
        }

        console.log(`✅ Valid product link for "${title}": ${originalLink}`);
        return originalLink;
    } catch (error) {
        console.error(`❌ Error validating product link for "${title}":`, error.message);

        if (!source) {
            return '#';
        }

        const sourceLower = source.toLowerCase();
        const formattedQuery = encodeURIComponent(title.trim());

        if (sourceLower.includes('amazon')) {
            return `https://amazon.com/s?k=${formattedQuery}`;
        } else if (sourceLower.includes('ebay')) {
            return `https://ebay.com/sch/i.html?_nkw=${formattedQuery}`;
        } else if (sourceLower.includes('walmart')) {
            return `https://walmart.com/search?query=${formattedQuery}`;
        } else if (sourceLower.includes('best')) {
            return `https://bestbuy.com/site/searchpage.jsp?st=${formattedQuery}`;
        }

        return '#';
    }
}

// Fetch and Store Exchange Rates in Database (Cron Job Function)
async function fetchAndStoreExchangeRates() {
    try {
        console.log('💱 Fetching fresh exchange rates from API...');
        const response = await axios.get(`https://v6.exchangerate-api.com/v6/${EXCHANGE_RATE_API_KEY}/latest/USD`);

        if (response.data && response.data.result === 'success') {
            const rates = response.data.conversion_rates;

            // Store in database
            await ExchangeRate.findOneAndUpdate(
                { baseCurrency: 'USD' },
                {
                    baseCurrency: 'USD',
                    rates: rates,
                    lastUpdated: new Date()
                },
                { upsert: true, new: true }
            );

            console.log('✅ Exchange rates fetched and stored in database successfully.');
            return true;
        } else {
            console.error('❌ Failed to fetch exchange rates from API:', response.data);
            return false;
        }
    } catch (error) {
        console.error('❌ Error fetching and storing exchange rates:', error.message);
        return false;
    }
}

// Get Exchange Rates from Database
async function getExchangeRates() {
    try {
        const exchangeRateDoc = await ExchangeRate.findOne({ baseCurrency: 'USD' });

        if (!exchangeRateDoc) {
            console.warn('⚠️ No exchange rates found in database. Fetching now...');
            await fetchAndStoreExchangeRates();
            // Try again after fetching
            const newDoc = await ExchangeRate.findOne({ baseCurrency: 'USD' });
            if (newDoc) {
                return Object.fromEntries(newDoc.rates);
            }
            return null;
        }

        // Convert Map to plain object for compatibility
        const rates = Object.fromEntries(exchangeRateDoc.rates);
        console.log('✅ Retrieved exchange rates from database.');
        return rates;
    } catch (error) {
        console.error('❌ Error retrieving exchange rates from database:', error.message);
        return null;
    }
}


// Detect Currency from Price String
function detectCurrency(priceStr, source) {
    if (typeof priceStr !== 'string') {
        // Amazon PA-API returns numbers, usually in the marketplace currency.
        // Assuming US/Global for now unless we check marketplace.
        // For this implementation, we'll default to USD for Amazon if number.
        return 'USD';
    }

    const upper = priceStr.toUpperCase();
    if (upper.includes('₦') || upper.includes('NGN')) return 'NGN';
    if (upper.includes('£') || upper.includes('GBP')) return 'GBP';
    if (upper.includes('€') || upper.includes('EUR')) return 'EUR';
    if (upper.includes('$') || upper.includes('USD')) return 'USD';

    // Fallback based on source if possible, otherwise USD
    if (source && source.toLowerCase().includes('amazon.co.uk')) return 'GBP';

    return 'USD'; // Default
}

// Convert Price to NGN
async function convertToNGN(price, currency) {
    if (currency === 'NGN') return price;

    const rates = await getExchangeRates();
    if (!rates) return price; // Fallback to original if no rates

    const ngnRate = rates['NGN'];
    const fromRate = rates[currency];

    if (!ngnRate || !fromRate) return price;

    // Convert to USD first (base), then to NGN
    // Rate is "How much of X for 1 USD"
    // Amount in USD = Amount / Rate(X)
    // Amount in NGN = Amount in USD * Rate(NGN)

    const priceInUSD = price / fromRate;
    const priceInNGN = priceInUSD * ngnRate;

    return Math.round(priceInNGN); // Round to nearest Naira
}

// Add affiliate code to product links
function addAffiliateLink(link, source) {
    try {
        if (!link || link === '#') {
            console.warn('⚠️ Cannot add affiliate to invalid link:', link);
            return link;
        }

        const url = new URL(link);
        const hostname = url.hostname.toLowerCase();

        if (AFFILIATE_CONFIGS.amazon.enabled &&
            AFFILIATE_CONFIGS.amazon.domains.some(domain => hostname.includes(domain))) {
            url.searchParams.set('tag', AFFILIATE_CONFIGS.amazon.tag);
            console.log(`🔗 Added Amazon affiliate tag to link`);
            return url.toString();
        }

        if (AFFILIATE_CONFIGS.ebay.enabled &&
            AFFILIATE_CONFIGS.ebay.domains.some(domain => hostname.includes(domain))) {
            url.searchParams.set('campid', AFFILIATE_CONFIGS.ebay.campaignId);
            console.log(`🔗 Added eBay affiliate campaign ID to link`);
            return url.toString();
        }

        if (AFFILIATE_CONFIGS.walmart.enabled &&
            AFFILIATE_CONFIGS.walmart.domains.some(domain => hostname.includes(domain))) {
            url.searchParams.set('publisherId', AFFILIATE_CONFIGS.walmart.publisherId);
            console.log(`🔗 Added Walmart publisher ID to link`);
            return url.toString();
        }

        console.log(`ℹ️ No affiliate configuration matched for host: ${hostname}`);
        return link;
    } catch (error) {
        console.error('Error adding affiliate to link:', error.message);
        return link;
    }
}

/**
 * Check relevance of a product title against the search query.
 * Returns a score from 0 to 1.
 */
function checkRelevance(title, searchQuery) {
    if (!title || !searchQuery) return 0;

    const titleWords = title.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
    const queryWords = searchQuery.toLowerCase().split(/\s+/).filter(w => w.length >= 2);

    if (queryWords.length === 0) return 1; // Generic match

    let matchCount = 0;
    for (const qWord of queryWords) {
        // Strict match for short words/numbers (e.g. "15", "Pro", "Max")
        if (qWord.length <= 3) {
            const regex = new RegExp(`\\b${qWord}\\b`, 'i');
            if (regex.test(title)) matchCount++;
        } else if (title.toLowerCase().includes(qWord)) {
            matchCount++;
        }
    }

    const score = matchCount / queryWords.length;

    // Special check: If query contains "airpod" and title contains "case" or "cover" or "strap"
    // but the query does NOT contain those accessory words, it's probably irrelevant.
    const accessoryWords = [
        'case', 'cover', 'strap', 'silicone', 'sleeve', 'pouch', 'protector', 'skin', 'holder', 'shell',
        'guard', 'glass', 'charger', 'cable', 'adapter', 'plug', 'lead', 'converter', 'earbud tips', 'ear tips'
    ];

    const hasAccessoryInTitle = accessoryWords.some(word => title.toLowerCase().includes(word));
    const hasAccessoryInQuery = accessoryWords.some(word => searchQuery.toLowerCase().includes(word));

    if (hasAccessoryInTitle && !hasAccessoryInQuery) {
        // If query is for the main device but result is an accessory, drastically reduce score
        return score * 0.2;
    }

    return score;
}

// Find best deals with affiliate tracking
// Amazon (from PA-API) is treated as the primary source, other stores are secondary
async function findBestDeals(results, searchQuery = '', userId = null, sessionId = null, category = null, onProgress = null) {
    if (!results || !results.shopping_results) {
        return { deals: null, totalValid: null };
    }

    const shoppingResults = results.shopping_results;
    const validResults = [];
    const trackingData = []; // Collect tracking data for batch save
    const seenItems = new Set(); // START DEDUPLICATION

    console.log(`🔍 findBestDeals: Input results count: ${shoppingResults.length}`);

    for (const item of shoppingResults) {
        if (!item.price) continue;

        const priceStr =
            typeof item.price === 'string'
                ? item.price.replace(/[$,₦]/g, '')
                : String(item.price);
        const price = parseFloat(priceStr);

        if (isNaN(price)) continue;

        // DEDUPLICATION: Create a unique key
        const source = item.source || item.merchant || item.store || 'Unknown';
        const title = item.title || 'Unknown Product';

        // Normalize title for better matching (lowercase, remove excess spaces)
        const normalizedTitle = title.toLowerCase().trim().replace(/\s+/g, ' ');
        // Unique key: Source + Title + Price (approx)
        const uniqueKey = `${source.toLowerCase()}-${normalizedTitle}-${price}`;

        if (seenItems.has(uniqueKey)) {
            // console.log(`Start skipping duplicate: ${uniqueKey}`);
            continue;
        }
        seenItems.add(uniqueKey);

        const imageUrl =
            item.thumbnail ||
            item.image ||
            (item.images && item.images[0] && item.images[0].src) ||
            (item.product && item.product.thumbnail) ||
            null;

        const originalLink =
            item.link ||
            item.url ||
            (item.product && item.product.link) ||
            '#';

        const validLink = ensureValidProductLink(originalLink, title, source);

        const affiliateLink = addAffiliateLink(validLink, source);

        console.log(`🔗 Product: "${title.substring(0, 50)}..." → ${affiliateLink}`);

        if (userId || sessionId) {
            trackingData.push({
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
        }

        // Check if source is Nigerian platform (prices already in NGN)
        const isNigerianSource = source && (
            source.toLowerCase().includes('jumia') ||
            source.toLowerCase().includes('konga') ||
            source.toLowerCase().includes('jiji') ||
            source.toLowerCase().includes('slot') ||
            source.toLowerCase().includes('ajebo') ||
            source.toLowerCase().includes('dexstitches')
        );

        let convertedPrice;
        if (isNigerianSource) {
            // Nigerian platforms already have NGN prices, no conversion needed
            convertedPrice = price;
            console.log(`💚 Nigerian source detected (${source}): Price already in NGN: ₦${price}`);
        } else {
            // International sources need conversion
            const currency = detectCurrency(item.price, source);
            convertedPrice = await convertToNGN(price, currency);
            console.log(`🔄 Converting ${currency} ${price} to NGN: ₦${convertedPrice}`);
        }

        const relevance = checkRelevance(title, searchQuery);

        // Filter out very low relevance results (only if we have a search query)
        if (searchQuery && relevance < 0.4) {
            console.log(`🗑️ Filtering low relevance item: "${title}" (Score: ${relevance})`);
            continue;
        }

        validResults.push({
            title,
            price: convertedPrice,
            originalPrice: price,
            originalCurrency: isNigerianSource ? 'NGN' : detectCurrency(item.price, source),
            source,
            link: affiliateLink,
            image: imageUrl,
            rating: item.rating || 'N/A',
            reviews: item.reviews || 'N/A',
            relevance: relevance
        });
    }

    // Batch save tracking data
    if (trackingData.length > 0) {
        ClickTracking.insertMany(trackingData, { ordered: false })
            .then(() => console.log(`💾 Batch saved ${trackingData.length} tracking records`))
            .catch(err => console.error('Error batch saving tracking data:', err.message));
    }

    if (onProgress) onProgress(`Cleaning and standardizing ${validResults.length} potential deals...`, validResults.length);

    if (validResults.length === 0) {
        return { deals: null, totalValid: null };
    }

    // Filter out items without valid links (excluding '#', empty, null, or undefined)
    let resultsWithValidLinks = validResults.filter((d) =>
        d.link && d.link !== '#' && d.link.trim() !== ''
    );

    console.log(`📊 Filtered ${validResults.length} items → ${resultsWithValidLinks.length} items with valid links`);

    // AI Pass: Filter results using Gemini for high accuracy
    if (searchQuery && resultsWithValidLinks.length > 0) {
        if (onProgress) onProgress(`Analyzing ${resultsWithValidLinks.length} results with AI to ensure maximum relevance...`, resultsWithValidLinks.length);
        console.log(`🤖 Starting AI relevance pass for: "${searchQuery}"`);
        // Limit to top 20 for AI to keep it fast and token-efficient
        const batchForAI = resultsWithValidLinks.slice(0, 20);
        const remaining = resultsWithValidLinks.slice(20);

        const aiFilteredBatch = await aiService.rankResultsWithAI(searchQuery, batchForAI);
        resultsWithValidLinks = [...aiFilteredBatch, ...remaining];
        console.log(`✅ AI Pass complete: Kept ${resultsWithValidLinks.length} results`);
        if (onProgress) onProgress(`AI analysis complete! Curated ${resultsWithValidLinks.length} prime deals.`, resultsWithValidLinks.length);
    }

    if (resultsWithValidLinks.length === 0) {
        return { deals: null, totalValid: null };
    }

    // Detect if this is a gadget or fashion query
    let isGadgetQuery = false;
    let isFashionQuery = false;

    if (category) {
        isGadgetQuery = category === 'gadget';
        isFashionQuery = category === 'fashion';
    } else {
        // Fallback to keyword detection if category not provided
        const gadgetKeywords = ['phone', 'laptop', 'tablet', 'headphone', 'earphone', 'airpod', 'watch', 'smartwatch',
            'speaker', 'computer', 'monitor', 'keyboard', 'mouse', 'camera', 'tv', 'television',
            'console', 'playstation', 'xbox', 'gadget', 'electronic', 'charger', 'cable', 'adapter', 'power bank', 'powerbank'];
        isGadgetQuery = gadgetKeywords.some(keyword =>
            searchQuery.toLowerCase().includes(keyword)
        );

        const fashionKeywords = ['shirt', 'pant', 'shoe', 'sneaker', 'dress', 'jacket', 'cloth', 'wear', 'bag', 'fashion', 'jean', 'jeans', 'hoodie', 'sweater', 'boutique'];
        isFashionQuery = fashionKeywords.some(keyword =>
            searchQuery.toLowerCase().includes(keyword)
        );
    }

    const amazonResults = resultsWithValidLinks.filter((d) =>
        d.source && d.source.toLowerCase().includes('amazon')
    );
    const jumiaResults = resultsWithValidLinks.filter((d) =>
        d.source && d.source.toLowerCase().includes('jumia')
    );
    const slotResults = resultsWithValidLinks.filter((d) =>
        d.source && d.source.toLowerCase().includes('slot')
    );
    const kongaResults = resultsWithValidLinks.filter((d) =>
        d.source && d.source.toLowerCase().includes('konga')
    );
    const jijiResults = resultsWithValidLinks.filter((d) =>
        d.source && d.source.toLowerCase().includes('jiji')
    );
    const ajeboResults = resultsWithValidLinks.filter((d) =>
        d.source && d.source.toLowerCase().includes('ajebo')
    );
    const dexStitchesResults = resultsWithValidLinks.filter((d) =>
        d.source && d.source.toLowerCase().includes('dexstitches')
    );
    const otherResults = resultsWithValidLinks.filter(
        (d) => !d.source ||
            (!d.source.toLowerCase().includes('amazon') &&
                !d.source.toLowerCase().includes('jumia') &&
                !d.source.toLowerCase().includes('slot') &&
                !d.source.toLowerCase().includes('konga') &&
                !d.source.toLowerCase().includes('jiji') &&
                !d.source.toLowerCase().includes('ajebo') &&
                !d.source.toLowerCase().includes('dexstitches'))
    );

    // Sort each source by relevance (desc) then price (asc)
    const sortResults = (list) => {
        return list.sort((a, b) => {
            // High relevance (e.g. >= 0.8) items always come first
            if (a.relevance >= 0.8 && b.relevance < 0.8) return -1;
            if (a.relevance < 0.8 && b.relevance >= 0.8) return 1;

            // If both are high relevance or both are low, sort by relevance score first
            if (Math.abs(a.relevance - b.relevance) > 0.2) {
                return b.relevance - a.relevance;
            }

            // If relevance is similar, sort by price
            return a.price - b.price;
        });
    };

    sortResults(amazonResults);
    sortResults(jumiaResults);
    sortResults(slotResults);
    sortResults(kongaResults);
    sortResults(jijiResults);
    sortResults(ajeboResults);
    sortResults(dexStitchesResults);
    sortResults(otherResults);

    // Helper to interleave lists for better source variety
    const interleave = (...lists) => {
        const result = [];
        const maxLen = Math.max(...lists.map(l => l.length));
        for (let i = 0; i < maxLen; i++) {
            for (const list of lists) {
                if (list[i]) result.push(list[i]);
            }
        }
        return result;
    };

    // Prioritization logic: Jumia ALWAYS first.
    // - Gadgets: Jumia, then Slot.ng, then Amazon, then others
    // - Others: Jumia, then Amazon, then local interleaved
    let orderedResults;
    if (isGadgetQuery) {
        // Gadgets: Prioritize Jumia, then Slot, then Amazon, then others interleaved
        const localInterleaved = interleave(kongaResults, jijiResults, ajeboResults, dexStitchesResults, otherResults);
        orderedResults = [...jumiaResults, ...slotResults, ...amazonResults, ...localInterleaved];
    } else {
        // Non-gadgets: Jumia first, then Amazon, then typical local mix
        const localInterleaved = interleave(kongaResults, ajeboResults, dexStitchesResults, jijiResults, slotResults, otherResults);
        orderedResults = [...jumiaResults, ...amazonResults, ...localInterleaved];
    }

    return {
        deals: orderedResults.slice(0, 15), // Show more top deals
        totalValid: resultsWithValidLinks.length
    };
}

// Get AI recommendation
async function getAIRecommendation(deals, searchQuery, user) {
    const dealsText = deals.map((deal, index) =>
        `${index + 1}. ${deal.title} - ${deal.price.toFixed(2)} ${deal.source ? `from ${deal.source}` : ''}${deal.rating && deal.rating !== 'N/A' ? ` (Rating: ${deal.rating}, ${deal.reviews} reviews)` : ''}`
    ).join('\n');

    const userContext = user ? `\n\nYou're making this recommendation for ${user.username || user.email}. Consider their preferences:\n${aiService.buildUserPreferencesPrompt(user)}\n${aiService.buildSearchPreferencesPrompt(user)}` : '';

    const prompt = `
You are a shopping assistant AI. The user searched for: "${searchQuery}"

Here are the top deals found:
${dealsText}

${userContext}

TASK: Recommend the best option in 2-3 SHORT sentences.
- Be extremely concise and direct.
- Pick the single best value option and say why.
- Mention one alternative if necessary.
- NO fluff, NO long introductions, NO bullet points unless absolutely needed.
- Keep the entire response under 50 words if possible.
`;


    try {
        const aiResponse = await aiService.callGeminiAPI(prompt);
        return aiResponse;
    } catch (error) {
        console.error('AI recommendation error:', error);
        return 'I tried to analyze the deals, but there was an error generating a detailed recommendation. You can still review the top deals above.';
    }
}

// Transcribe audio using Gemini
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No audio file provided' });
        }

        console.log('🎤 Received audio file:', req.file.mimetype, req.file.size);

        // Convert buffer to base64
        const base64Audio = req.file.buffer.toString('base64');

        const prompt = 'Transcribe this audio file verbatim. return JUST the text.';

        // Call Gemini
        const response = await axios.post(
            `${GEMINI_URL}?key=${GOOGLE_API_KEY}`,
            {
                contents: [{
                    parts: [
                        {
                            text: prompt
                        },
                        {
                            inline_data: {
                                mime_type: req.file.mimetype, // e.g. 'audio/webm' or 'audio/mp3'
                                data: base64Audio
                            }
                        }
                    ]
                }]
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        const candidates = response.data?.candidates;
        if (!candidates || candidates.length === 0) {
            throw new Error('No transcription returned from Gemini');
        }

        const transcription = candidates[0]?.content?.parts?.[0]?.text || '';
        console.log('📝 Transcription:', transcription);

        res.json({ text: transcription.trim() });

    } catch (error) {
        console.error('Transcription error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to transcribe audio' });
    }
});

// Compare products using Gemini
app.post('/api/compare', async (req, res) => {
    try {
        const { products } = req.body;

        if (!products || !Array.isArray(products) || products.length < 2) {
            return res.status(400).json({ error: 'Please select at least 2 products to compare.' });
        }

        console.log(`⚖️ Comparing ${products.length} products`);

        const productsDescription = products.map((p, i) =>
            `Product ${i}: ${p.title}
             Price: ${p.price}
             Source: ${p.source}
             Rating: ${p.rating} (${p.reviews} reviews)
             Link: ${p.link}`
        ).join('\n\n');

        const prompt = `Compare the following products and identify the best option for the user.
        
        ${productsDescription}
        
        You must strictly return valid JSON in the following format (no markdown code blocks, just raw JSON).
        IMPORTANT: In the 'summary', 'keyDifferences', and 'verdict', NEVER refer to products as "Product 0" or "Product 1". ALWAYS use their actual truncated titles (e.g., "AirPods Pro").

        {
          "winnerIndex": 0, // Index of the winning product in the provided list (0-based)
          "runnerUpIndex": 1, // Index of the runner-up product (optional, null if none)
          "summary": "Values-based summary of why the winner was chosen. Use actual product names, not indices. (max 2 sentences).",
          "keyDifferences": [
            { "feature": "Price", "value1": "₦450,000", "value2": "₦480,000", "note": "AirPods Pro is cheaper" },
            { "feature": "Rating", "value1": "4.5", "value2": "4.0", "note": "Sony XM5 has higher rating" }
          ],
          "verdict": "Final short verdict (e.g. 'Best Value', 'Premium Choice')"
        }`;

        // Call Gemini
        const response = await axios.post(
            `${GEMINI_URL}?key=${GOOGLE_API_KEY}`,
            {
                contents: [{
                    parts: [{ text: prompt }]
                }]
            },
            {
                headers: { 'Content-Type': 'application/json' }
            }
        );

        const candidates = response.data?.candidates;
        let comparisonText = candidates?.[0]?.content?.parts?.[0]?.text || '{}';

        // Clean up markdown code blocks if present
        comparisonText = comparisonText.replace(/```json\n?|\n?```/g, "").trim();

        let comparisonData;
        try {
            comparisonData = JSON.parse(comparisonText);
        } catch (e) {
            console.error("Failed to parse Gemini JSON:", comparisonText);
            // Fallback to text if JSON fails
            return res.json({
                error: true,
                rawText: comparisonText
            });
        }

        res.json({ comparison: comparisonData });

    } catch (error) {
        console.error('Comparison error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to compare products' });
    }
});

// Vision Chat Route
app.post('/api/chat/vision', upload.single('image'), authenticateToken, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image uploaded' });
        }

        // Validate MIME type
        const allowedMimeTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];
        if (!allowedMimeTypes.includes(req.file.mimetype)) {
            return res.status(400).json({
                error: `Unsupported image format (${req.file.mimetype}). Please upload PNG, JPEG, WEBP, or HEIC.`
            });
        }

        const { sessionId: clientSessionId, message } = req.body;
        const sessionId = clientSessionId || Date.now().toString();
        const userId = req.userId;

        console.log('📸 Processing vision request for session:', sessionId);
        console.log('💬 User caption:', message || 'No caption');

        // 1. Analyze Image with Gemini
        let userInstruction = "";
        if (message) {
            userInstruction = `The user also provided this specific instruction/caption: "${message}". Ensure your analysis and search query address this directly.`;
        }

        const prompt = `Identify this product from the image. providing the product name, brand, model, and key visual features.
        ${userInstruction}
        Then, generate a specific search query to find this exact product and its variations.
        Return the result as a strict JSON object with these fields:
        {
            "productName": "Name of the product",
            "searchQuery": "Best search query for Amazon/Shopping",
            "variations": "Description of potential variations (color, size, etc.)",
            "description": "Brief description of the item"
        }
        Do not include markdown formatting (like \`\`\`json). Just the raw JSON string.`;

        const analysisResponse = await aiService.callGeminiAPI(prompt, req.file.buffer, req.file.mimetype);

        let analysis;
        try {
            // Clean markdown code blocks if present
            const cleanJson = analysisResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            analysis = JSON.parse(cleanJson);
        } catch (e) {
            console.warn('Failed to parse Gemini vision JSON, falling back to raw text', e);
            analysis = {
                productName: 'Unknown Product',
                searchQuery: analysisResponse.split('\n')[0], // Guess first line is relevant
                description: analysisResponse
            };
        }

        console.log('🔍 Generated Search Query from Image:', analysis.searchQuery);

        // 2. Perform Search using the unified search function
        const searchResults = await searchAllSources(analysis.searchQuery, null);
        const allResults = searchResults.shopping_results || [];

        // 3. Generate AI Response about the results
        const resultCount = allResults.length;
        const summaryPrompt = `User uploaded an image of: ${analysis.productName}.
        User's Caption/Instruction: "${message || 'None'}".
        Description: ${analysis.description}.
        We found ${resultCount} products using query: "${analysis.searchQuery}".
        
        You are the shopping assistant. Reply directly to the user.
        Address their specific instruction ("${message}") if provided.
        Confirm what is in the image and mention the results found.
        Mention if you accessed "variations" if relevant.
        Keep it to 2-3 sentences. Friendly tone.
        DO NOT say "Here is a message" or "I would say". Just say the message directly.`;

        const aiMessage = await aiService.callGeminiAPI(summaryPrompt);

        // 4. Save to Database (Create a "User Message" that represents the image upload)
        // We'll rely on the frontend to display the uploaded image, handling the "User" side of the UI.
        // We just return the "AI" response.

        if (clientSessionId) {
            try {
                // Find or create conversation
                let conversation = await Conversation.findOne({ sessionId });
                if (!conversation && userId) {
                    conversation = new Conversation({
                        userId: userId,
                        sessionId: sessionId,
                        messages: []
                    });
                }

                // Add Image Message (User)
                conversation.messages.push({
                    role: 'user',
                    content: `[Uploaded Image] ${analysis.productName}`,
                    type: 'image',
                    image: req.file.originalname // Or save to cloud and store URL if needed
                });

                // Add AI Response
                conversation.messages.push({
                    role: 'assistant',
                    content: aiMessage,
                    type: 'product_search',
                    deals: allResults,
                    searchQuery: analysis.searchQuery
                });

                if (conversation && conversation.userId) {
                    await conversation.save();
                }
            } catch (dbError) {
                console.error('Error saving vision conversation:', dbError);
            }
        }

        res.json({
            message: aiMessage,
            results: allResults,
            searchQuery: analysis.searchQuery,
            productDetails: analysis,
            type: 'product_search'
        });

    } catch (error) {
        console.error('Vision API Error:', error);
        res.status(500).json({ error: 'Failed to process image' });
    }
});

// AI-powered chat route
app.post('/api/chat', async (req, res) => {
    try {
        const { message, searchQuery, sessionId: clientSessionId } = req.body;
        const userId = req.userId;

        if (!message && !searchQuery) {
            return res.status(400).json({ error: 'Message or search query is required' });
        }

        let user = null;
        if (userId) {
            user = await User.findById(userId).select('-password');
        }

        let session = clientSessionId;
        if (!session) {
            session = generateSessionId(req);
        }

        if (!conversationHistory.has(session)) {
            conversationHistory.set(session, []);
        }

        const sessionHistory = conversationHistory.get(session);

        sessionHistory.push({ role: 'user', content: message });

        const aiPrompt = aiService.generateAIPrompt(message, searchQuery, user, sessionHistory);

        let aiResponse = await aiService.callGeminiAPI(aiPrompt);

        let extractedSearchQuery = searchQuery;
        let extractedCategory = 'other';
        let shouldSearch = false;

        if (aiResponse.includes('SEARCH:')) {
            shouldSearch = true;
            const searchLines = aiResponse.split('\n');
            const searchLine = searchLines.find(line => line.includes('SEARCH:'));
            extractedSearchQuery = searchLine.split('SEARCH:')[1].trim();

            const categoryLine = searchLines.find(line => line.includes('CATEGORY:'));
            if (categoryLine) {
                extractedCategory = categoryLine.split('CATEGORY:')[1].trim().toLowerCase();
            }

            // Clean AI response from markers
            aiResponse = aiResponse.replace(/SEARCH:.*(\n?)/, '').replace(/CATEGORY:.*(\n?)/, '').trim();
        }

        sessionHistory.push({ role: 'assistant', content: aiResponse });
        conversationHistory.set(session, sessionHistory);

        // Save conversation to database
        try {
            await Conversation.findOneAndUpdate(
                { sessionId: session },
                {
                    sessionId: session,
                    userId: userId || null,
                    messages: sessionHistory,
                    updatedAt: new Date()
                },
                { upsert: true, new: true }
            );
            console.log(`💾 Conversation saved to database: ${session}`);
        } catch (dbError) {
            console.error('Error saving conversation to database:', dbError);
            // Don't fail the request if database save fails
        }

        const displayMessage = aiService.formatDisplayMessage(aiResponse);

        res.json({
            aiResponse: displayMessage,
            sessionId: session,
            shouldSearch,
            searchQuery: extractedSearchQuery || searchQuery,
            category: extractedCategory,
            deals: null, // Frontend will fetch these if shouldSearch is true
            totalValid: 0,
            aiDealSummary: null
        });
    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({ error: 'Chat processing failed' });
    }
});

// Separate quick search endpoint
app.post('/api/search', async (req, res) => {
    try {
        const { searchQuery } = req.body;
        const userId = req.userId;

        if (!searchQuery) {
            return res.status(400).json({ error: 'Search query is required' });
        }

        let user = null;
        if (userId) {
            user = await User.findById(userId).select('-password');
        }

        const message = `User wants to search for: "${searchQuery}". Provide a short helpful response explaining what you're going to look for and what kind of deals you'll try to find. Use "SEARCH: ${searchQuery}" if appropriate.`;

        const session = generateSessionId(req);

        const aiPrompt = aiService.generateAIPrompt(message, searchQuery, user, []);

        let aiResponse = await aiService.callGeminiAPI(aiPrompt);

        let shouldSearch = aiResponse.includes('SEARCH:');

        let extractedSearchQuery = searchQuery;
        let extractedCategory = 'other';

        if (shouldSearch) {
            const searchLines = aiResponse.split('\n');
            const searchLine = searchLines.find(line => line.includes('SEARCH:'));
            extractedSearchQuery = searchLine.split('SEARCH:')[1].trim();

            const categoryLine = searchLines.find(line => line.includes('CATEGORY:'));
            if (categoryLine) {
                extractedCategory = categoryLine.split('CATEGORY:')[1].trim().toLowerCase();
            }

            aiResponse = aiResponse.replace(/SEARCH:.*(\n?)/, '').replace(/CATEGORY:.*(\n?)/, '').trim();
        }

        if (!shouldSearch) {
            shouldSearch = true;
        }

        let deals = null;
        let totalValid = 0;
        let aiDealSummary = null;

        if (shouldSearch && extractedSearchQuery) {
            // Check cache first
            const cacheKey = extractedSearchQuery.toLowerCase().trim();
            const cachedResult = await getCachedSearch(cacheKey);

            if (cachedResult) {
                deals = cachedResult.deals;
                totalValid = cachedResult.totalValid;
                aiDealSummary = cachedResult.aiDealSummary;
            } else {
                console.log(`🔍 Performing fresh search for: "${extractedSearchQuery}" in category: ${extractedCategory}`);
                const searchResults = await searchAllSources(extractedSearchQuery, user, extractedCategory);
                const result = await findBestDeals(searchResults, extractedSearchQuery, user?._id, session, extractedCategory);
                deals = result.deals;
                totalValid = result.totalValid;

                // Skip AI recommendation for faster response
                aiDealSummary = null;

                // Cache the results ONLY if we found something
                if (deals && deals.length > 0) {
                    await setCachedSearch(cacheKey, { deals, totalValid, aiDealSummary: null });
                }
            }
        }

        const displayMessage = aiService.formatDisplayMessage(aiResponse);

        // Debug: Log deals to verify link field is included
        if (deals && deals.length > 0) {
            console.log('📦 Sending deals to frontend (search endpoint):', JSON.stringify(deals.map(d => ({
                title: d.title.substring(0, 30) + '...',
                hasLink: !!d.link,
                link: d.link ? d.link.substring(0, 50) + '...' : 'NO LINK'
            })), null, 2));
        }

        res.json({
            aiResponse: displayMessage,
            deals,
            totalValid,
            aiDealSummary
        });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Search failed' });
    }
});

// Lazy-load AI recommendation endpoint
app.post('/api/recommendation', async (req, res) => {
    try {
        const { deals, searchQuery } = req.body;
        const userId = req.userId;

        if (!deals || !Array.isArray(deals) || deals.length === 0) {
            return res.status(400).json({ error: 'Deals array is required' });
        }

        if (!searchQuery) {
            return res.status(400).json({ error: 'Search query is required' });
        }

        let user = null;
        if (userId) {
            user = await User.findById(userId).select('-password');
        }

        console.log(`🤖 Generating AI recommendation for: "${searchQuery}"`);
        const recommendation = await getAIRecommendation(deals, searchQuery, user);

        res.json({
            aiDealSummary: recommendation,
            searchQuery
        });
    } catch (error) {
        console.error('Recommendation error:', error);
        res.status(500).json({ error: 'Failed to generate recommendation' });
    }
});


// Route to handle direct shopping search via UI
app.post('/api/shopping-search', async (req, res) => {
    try {
        const { searchQuery, userMessage, aiEnabled } = req.body;
        const userId = req.userId;

        if (!searchQuery && !userMessage) {
            return res.status(400).json({ error: 'Either search query or user message is required' });
        }

        let user = null;
        if (userId) {
            user = await User.findById(userId).select('-password');
        }

        const session = generateSessionId(req);

        let aiResponse = null;
        let displayMessage = null;

        if (aiEnabled && userMessage) {
            const aiPrompt = aiService.generateAIPrompt(userMessage, searchQuery, user, []);
            aiResponse = await aiService.callGeminiAPI(aiPrompt);

            let shouldSearch = false;
            let extractedSearchQuery = searchQuery;
            let extractedCategory = 'other';

            if (aiResponse.includes('SEARCH:')) {
                shouldSearch = true;
                const searchLines = aiResponse.split('\n');
                const searchLine = searchLines.find(line => line.includes('SEARCH:'));
                extractedSearchQuery = searchLine.split('SEARCH:')[1].trim();

                const categoryLine = searchLines.find(line => line.includes('CATEGORY:'));
                if (categoryLine) {
                    extractedCategory = categoryLine.split('CATEGORY:')[1].trim().toLowerCase();
                }

                displayMessage = aiResponse.replace(/SEARCH:.*(\n?)/, '').replace(/CATEGORY:.*(\n?)/, '').trim();
            } else {
                shouldSearch = true;
                extractedSearchQuery = searchQuery || userMessage;
                displayMessage = aiResponse;
            }

            const searchResults = await searchAllSources(extractedSearchQuery, user, extractedCategory);
            const { deals, totalValid } = await findBestDeals(searchResults, extractedSearchQuery, user?._id, session);
            let aiDealSummary = null;

            if (deals && deals.length > 0) {
                aiDealSummary = await getAIRecommendation(deals, extractedSearchQuery, user);
            }

            return res.json({
                aiResponse: aiService.formatDisplayMessage(displayMessage || aiResponse),
                deals,
                totalValid,
                aiDealSummary
            });
        } else {
            const searchResults = await searchAllSources(searchQuery || userMessage, user, 'other');
            const { deals, totalValid } = await findBestDeals(searchResults, searchQuery || userMessage, user?._id, session);
            const displayMessage = `Here are some deals I found for "${searchQuery || userMessage}". Want me to help compare them or suggest the best one?`;

            let aiDealSummary = null;

            if (deals && deals.length > 0) {
                aiDealSummary = await getAIRecommendation(deals, searchQuery || userMessage, user);
            }

            return res.json({
                aiResponse: aiService.formatDisplayMessage(displayMessage),
                deals,
                totalValid,
                aiDealSummary
            });
        }
    } catch (error) {
        console.error('Shopping search error:', error);
        res.status(500).json({ error: 'Shopping search failed' });
    }
});

// Track clicks on product links
app.post('/api/click', async (req, res) => {
    try {
        const { trackingId } = req.body;

        if (!trackingId) {
            return res.status(400).json({ error: 'Tracking ID is required' });
        }

        await ClickTracking.findByIdAndUpdate(trackingId, {
            $set: { clicked: true }
        });

        res.json({ message: 'Click tracked successfully' });
    } catch (error) {
        console.error('Click tracking error:', error);
        res.status(500).json({ error: 'Failed to track click' });
    }
});

// Scheduled search job
async function runScheduledSearches() {
    try {
        console.log('⏰ Running scheduled searches...');

        const now = new Date();

        const activeParties = await Party.find({ active: true });

        for (const party of activeParties) {
            const lastRun = party.lastRunAt || party.createdAt;
            const hoursSinceLastRun = (now - lastRun) / (1000 * 60 * 60);

            const userFrequencyHours = party.searchFrequencyHours || 12;

            if (hoursSinceLastRun < userFrequencyHours) {
                continue;
            }

            console.log(`🔎 Searching for: "${party.itemName}" (User: ${party.userId}, Frequency: ${userFrequencyHours}h)`);

            const user = await User.findById(party.userId).select('-password');
            const searchResults = await searchAllSources(party.searchQuery, user);
            const { deals } = await findBestDeals(searchResults, party.searchQuery, party.userId, null);

            if (deals && deals.length > 0) {
                const aiSummary = await getAIRecommendation(deals, party.searchQuery, user);

                const notification = new PartyNotification({
                    partyId: party._id,
                    userId: party.userId,
                    deals: deals,
                    searchQuery: party.searchQuery,
                    notificationMessage: `We found new deals for your party: "${party.itemName}"`,
                    notificationChannel: party.notificationChannel || 'in_app',
                    aiSummary: aiSummary
                });

                await notification.save();

                console.log(`✅ Notification created for user ${party.userId} and party "${party.itemName}".`);
            }

            party.lastRunAt = now;
            await party.save();
        }
    } catch (error) {
        console.error('Scheduled search error:', error);
    }
}

// Start the scheduler
function startScheduler() {
    if (!validateSearchFrequency()) {
        console.error("❌ Scheduler not started due to invalid search frequency configuration.");
        return;
    }

    console.log(`⏰ Starting scheduled search job. Frequency: every ${SEARCH_FREQUENCY_MINUTES || (SEARCH_FREQUENCY_HOURS * 60)} minutes.`);

    runScheduledSearches();

    setInterval(runScheduledSearches, CRON_INTERVAL);
}



// Execute search endpoint (called by frontend after chat determines intent)
app.post('/api/execute-search', authenticateToken, async (req, res) => {
    try {
        const { searchQuery, category, sessionId: clientSessionId } = req.body;
        const userId = req.userId;

        if (!searchQuery) {
            return res.status(400).json({ error: 'Search query is required' });
        }

        let user = null;
        if (userId) {
            user = await User.findById(userId).select('-password');
        }

        const session = clientSessionId || generateSessionId(req);

        console.log(`🔍 Executing search for: "${searchQuery}"`);

        // Notify client that search has started
        res.write(`event: search-start\n`);
        res.write(`data: "start"\n\n`);

        // Check cache first
        const cacheKey = searchQuery.toLowerCase().trim();
        const cachedResult = await getCachedSearch(cacheKey);

        let deals = null;
        let totalValid = 0;
        let aiDealSummary = null;

        if (cachedResult) {
            deals = cachedResult.deals;
            totalValid = cachedResult.totalValid;
            aiDealSummary = cachedResult.aiDealSummary;
        } else {
            const searchResults = await searchAllSources(searchQuery, user, category || 'other');
            const result = await findBestDeals(searchResults, searchQuery, user?._id, session);
            deals = result.deals;
            totalValid = result.totalValid;

            // Cache the results ONLY if we found something
            if (deals && deals.length > 0) {
                await setCachedSearch(cacheKey, { deals, totalValid, aiDealSummary: null });
            }
        }

        // Auto-create search party if no results found and user is authenticated
        let partyCreated = false;
        let partyDetails = null;
        let creativeMessage = null;

        if ((!deals || deals.length === 0) && userId) {
            try {
                console.log(`🎉 No results found. Creating search party for user ${userId}...`);

                // Check if a party already exists for this query
                const existingParty = await Party.findOne({
                    userId: userId,
                    searchQuery: searchQuery,
                    active: true
                });

                if (!existingParty) {
                    // Create new search party
                    const party = new Party({
                        userId: userId,
                        itemName: searchQuery,
                        searchQuery: searchQuery,
                        searchFrequencyHours: SEARCH_FREQUENCY_HOURS || 6,
                        aiStyle: user?.preferences?.shoppingStyle || 'Balanced',
                        stores: ['amazon', 'ebay', 'walmart', 'bestbuy'],
                        maxPrice: user?.searchPreferences?.maxPrice || null,
                        minPrice: user?.searchPreferences?.minPrice || 0,
                        active: true,
                        notificationChannel: 'in_app'
                    });

                    await party.save();
                    partyCreated = true;
                    partyDetails = {
                        id: party._id,
                        itemName: party.itemName,
                        searchFrequencyHours: party.searchFrequencyHours
                    };

                    console.log(`✅ Search party created successfully: ${party._id}`);
                } else {
                    console.log(`ℹ️ Search party already exists for this query: ${existingParty._id}`);
                    partyDetails = {
                        id: existingParty._id,
                        itemName: existingParty.itemName,
                        searchFrequencyHours: existingParty.searchFrequencyHours
                    };
                }

                // Generate creative message
                const messages = [
                    `🔍 No luck this time, but I've got your back! I've set up a Search Party to hunt down "${searchQuery}" for you. I'll keep my eyes peeled 24/7 and ping you the moment I find a great deal! 🎯`,
                    `🕵️ Hmm, "${searchQuery}" is playing hard to get! Don't worry - I've assembled a dedicated Search Party that'll scour the web every ${partyDetails.searchFrequencyHours} hours. You'll be the first to know when we strike gold! 💎`,
                    `🚀 "${searchQuery}" isn't available right now, but your personal Search Party is on the case! I'll be checking top stores around the clock and will notify you the instant something pops up! 🎁`,
                    `🎯 Couldn't find "${searchQuery}" at the moment, but I'm not giving up! Your Search Party is now active and will keep hunting. Sit back, relax, and I'll alert you when the perfect deal appears! ✨`,
                    `🔎 "${searchQuery}" is currently out of sight, but not out of mind! I've deployed a Search Party to track it down. You'll get a notification as soon as we find what you're looking for! 🎊`
                ];

                creativeMessage = messages[Math.floor(Math.random() * messages.length)];

            } catch (partyError) {
                console.error('Error creating search party:', partyError);
                // Don't fail the request if party creation fails
            }
        }

        // Update conversation with search results
        try {
            const conversation = await Conversation.findOne({ sessionId: session });
            if (conversation && conversation.messages.length > 0) {
                // Find the last assistant message and update it with search results
                const lastAssistantIndex = conversation.messages.map((m, i) => ({ role: m.role, index: i }))
                    .reverse()
                    .find(m => m.role === 'assistant')?.index;

                if (lastAssistantIndex !== undefined) {
                    const messageUpdate = {
                        type: deals && deals.length > 0 ? 'recommendation' : 'message',
                        deals: deals || [],
                        searchQuery: searchQuery
                    };

                    // Add recommendation if we have deals
                    if (deals && deals.length > 0) {
                        const bestDeal = [...deals].sort((a, b) => a.price - b.price)[0];
                        messageUpdate.recommendation = {
                            deal: bestDeal,
                            reason: aiDealSummary || "Here are the best deals I found!"
                        };
                    }

                    // Update the message
                    Object.assign(conversation.messages[lastAssistantIndex], messageUpdate);
                    conversation.updatedAt = new Date();

                    // Only save if we have a userId to satisfy schema validation
                    if (conversation.userId) {
                        await conversation.save();
                        console.log(`💾 Updated conversation with search results: ${session}`);
                    }
                }
            }
        } catch (dbError) {
            console.error('Error updating conversation with search results:', dbError);
            // Don't fail the request if database update fails
        }

        res.json({
            deals,
            totalValid,
            aiDealSummary,
            sessionId: session,
            partyCreated,
            partyDetails,
            noResultsMessage: creativeMessage
        });

    } catch (error) {
        console.error('Execute search error:', error);
        res.status(500).json({ error: 'Search execution failed' });
    }
});


// Initialize Exchange Rate Cron Job
const EXCHANGE_RATE_INTERVAL = EXCHANGE_RATE_UPDATE_HOURS * 60 * 60 * 1000; // Convert hours to milliseconds

// Fetch exchange rates immediately on startup


// Schedule periodic updates
setInterval(async () => {
    console.log(`⏰ Running scheduled exchange rate update (every ${EXCHANGE_RATE_UPDATE_HOURS} hours)...`);
    await fetchAndStoreExchangeRates();
}, EXCHANGE_RATE_INTERVAL);

console.log(`✅ Exchange rate cron job scheduled to run every ${EXCHANGE_RATE_UPDATE_HOURS} hours.`);


// Vendor Product Routes
// ----------------------------------------
// PUBLIC SEARCH API ENDPOINT
// ----------------------------------------
app.get('/api/search', async (req, res) => {
    try {
        const { q, category } = req.query;
        if (!q) {
            return res.status(400).json({ error: 'Query parameter "q" is required' });
        }

        console.log(chalk.green(`\nNew web search request: "${q}" (Category: ${category})`));
        console.log(`🔗 Forwarding to Custom Search API...`);

        // Call Custom Search API
        // Use environment variable or default to new VPS, avoids hardcoded Render issues
        const scrapperUrl = process.env.SCRAPPER_URL || 'http://46.175.147.124:3001/api/search';
        console.log(`🔗 Calling Scrapper at: ${scrapperUrl}`);

        const response = await axios.get(scrapperUrl, {
            params: { q, category }
        });

        console.log(`✅ Scrapper responded with status: ${response.status}`);
        const externalData = response.data;
        const externalResults = externalData.results || [];
        console.log(`🔍 External Data Received: ${externalResults.length} items`);
        console.log(`🗂️  Result breakdown:`, externalData.counts || 'No counts provided');

        console.log(`✅ Custom API returned ${externalResults.length} results`);

        // Map results to internal format
        const mappedResults = externalResults.map(item => ({
            title: item.title,
            price: item.price,
            source: item.source,
            link: item.link,
            thumbnail: item.img || item.thumbnail,
            rating: item.rating || 'N/A',
            reviews: 'N/A',
            isNigerian: ['Jumia', 'Jiji', 'Konga', 'Slot', 'Ajebo', 'DexStitches'].some(s => item.source && item.source.includes(s))
        }));

        const prioritized = await prioritizeResults(mappedResults);

        res.json({
            results: prioritized,
            count: prioritized.length,
            meta: externalData.counts || {}
        });

    } catch (error) {
        console.error('Search API Error:', error.message);
        if (error.response) {
            console.error('External API Status:', error.response.status);
            console.error('External API Data:', error.response.data);
        }
        // Fallback to empty results instead of crashing
        res.json({ results: [], count: 0, meta: {} });
    }
});

// 1. Get Vendor's Products
app.get('/api/vendor/products', authenticateToken, async (req, res) => {
    try {
        if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

        // Verify user is a vendor
        const user = await User.findById(req.userId);
        if (!user || user.role !== 'vendor') {
            return res.status(403).json({ error: 'Access denied. Vendor role required.' });
        }

        const products = await Product.find({ vendorId: req.userId }).sort({ createdAt: -1 });
        res.json({ products });
    } catch (error) {
        console.error('Error fetching vendor products:', error);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

// 2. Add New Product
app.post('/api/vendor/products', authenticateToken, async (req, res) => {
    try {
        if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

        const user = await User.findById(req.userId);
        if (!user || user.role !== 'vendor') {
            return res.status(403).json({ error: 'Access denied. Vendor role required.' });
        }

        const { title, description, price, category, image, stock } = req.body;

        if (!title || !price) {
            return res.status(400).json({ error: 'Title and price are required' });
        }

        const newProduct = new Product({
            vendorId: req.userId,
            title,
            description,
            price,
            category,
            image,
            stock
        });

        await newProduct.save();
        res.status(201).json({ message: 'Product added successfully', product: newProduct });
    } catch (error) {
        console.error('Error adding product:', error);
        res.status(500).json({ error: 'Failed to add product' });
    }
});

// 3. Delete Product
app.delete('/api/vendor/products/:id', authenticateToken, async (req, res) => {
    try {
        if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

        const product = await Product.findOne({ _id: req.params.id, vendorId: req.userId });

        if (!product) {
            return res.status(404).json({ error: 'Product not found or unauthorized' });
        }

        await Product.findByIdAndDelete(req.params.id);
        res.json({ message: 'Product deleted successfully' });
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ error: 'Failed to delete product' });
    }
});




// Execute search endpoint with STREAMING (Incremental Results)
app.post('/api/execute-search-stream', authenticateToken, async (req, res) => {
    const { searchQuery, sessionId: clientSessionId } = req.body;
    const userId = req.userId;

    if (!searchQuery) {
        return res.status(400).json({ error: 'Search query is required' });
    }

    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let user = null;
    if (userId) {
        try {
            user = await User.findById(userId).select('-password');
        } catch (e) { console.error('Error fetching user:', e); }
    }

    const session = clientSessionId || generateSessionId(req);

    // Accumulate all deals to save at end
    let allDeals = [];

    try {
        const country = user?.preferences?.country || 'NG';
        console.log(`🔍 Stream Searching for: "${searchQuery}" in ${country}`);

        // 1. Check Cache First (if you want fast response, but maybe skip for streaming demo?)
        // Let's check cache. If hit, we can just stream it all at once.
        const cacheKey = searchQuery.toLowerCase().trim();
        const cachedResult = await getCachedSearch(cacheKey);

        if (cachedResult) {
            sendEvent('deals', cachedResult.deals);
            allDeals = cachedResult.deals;
            sendEvent('done', { totalValid: cachedResult.totalValid, aiDealSummary: cachedResult.aiDealSummary });
            res.end();
            return;
        }

        // 2. Start Local Search (Fastest) AND External Search (Parallel but streamed as they finish)

        // --- LOCAL SEARCH ---
        sendEvent('search-progress', { message: 'Checking local vendor inventory...' });
        let localDealsCount = 0;
        try {
            const localProducts = await searchLocalProducts(searchQuery);
            if (localProducts && localProducts.length > 0) {
                // Process them similar to findBestDeals but just for local
                const localDeals = localProducts.map(p => ({
                    ...p,
                    source: 'Vendor',
                    isLocal: true,
                    // Ensure price format matches expected
                    originalPrice: p.price,
                    originalCurrency: 'NGN', // Assuming local is NGN
                    link: `/product/${p.id}`
                }));

                if (localDeals.length > 0) {
                    sendEvent('deals', localDeals);
                    allDeals.push(...localDeals);
                    localDealsCount = localDeals.length;
                    sendEvent('search-progress', { message: `Found ${localDealsCount} items in local store.`, resultsFound: allDeals.length });
                }
            }
        } catch (err) {
            console.error("Local search stream error", err);
        }

        // Note: We'll check local-status AFTER all searches complete (see before 'done' event)

        // Detect category with AI
        sendEvent('search-progress', { message: 'Analyzing query intent with AI...', resultsFound: allDeals.length });
        const aiCategory = await aiService.detectCategoryWithAI(searchQuery);
        console.log(`🧠 AI determined category for "${searchQuery}": ${aiCategory}`);
        sendEvent('search-progress', { message: `Intent detected: ${aiCategory.toUpperCase()}. Deep searching relevant stores...`, resultsFound: allDeals.length });

        // --- EXTERNAL SEARCH ---

        const externalApiUrl = `http://localhost:${process.env.PORT || 3000}/api/search`;
        try {
            sendEvent('search-progress', { message: 'Contacting external search engine...', resultsFound: allDeals.length });
            const apiResponse = await axios.get(externalApiUrl, { params: { q: searchQuery, category: aiCategory } });
            const apiResults = apiResponse.data?.results || [];

            sendEvent('search-progress', { message: `Retrieved ${apiResults.length} raw results. Processing...`, resultsFound: allDeals.length });

            // Process these results (price conversion, affiliate links, etc.)
            // We can reuse findBestDeals logic but we need to pass just these results
            const wrappedResults = { shopping_results: apiResults };

            const processedExternal = await findBestDeals(
                wrappedResults,
                searchQuery,
                userId,
                session,
                aiCategory,
                (msg, count) => sendEvent('search-progress', { message: msg, resultsFound: allDeals.length + (count || 0) })
            );

            if (processedExternal.deals && processedExternal.deals.length > 0) {
                // Apply global prioritization (Jumia first) to this batch
                const prioritizedBatch = await prioritizeResults(processedExternal.deals, country);
                sendEvent('deals', prioritizedBatch);
                allDeals.push(...prioritizedBatch);
                sendEvent('search-progress', { message: `Optimized results from ${prioritizedBatch.length} sources.`, resultsFound: allDeals.length });
            }

        } catch (err) {
            console.error("External search stream error", err);
            sendEvent('search-progress', { message: 'Search engine returned an error. Moving to alternatives...' });
        }

        // 3. Cache and cleanup
        if (allDeals.length > 0) {
            // Update Cache
            await setCachedSearch(cacheKey, { deals: allDeals, totalValid: allDeals.length, aiDealSummary: null });

            // Update Conversation (Database)
            // Similar logic to existing execute-search
            try {
                const conversation = await Conversation.findOne({ sessionId: session });
                if (conversation && conversation.messages.length > 0) {
                    const lastAssistantIndex = conversation.messages.map((m, i) => ({ role: m.role, index: i }))
                        .reverse()
                        .find(m => m.role === 'assistant')?.index;
                    if (lastAssistantIndex !== undefined) {
                        // We probably want to update it with the FULL list
                        Object.assign(conversation.messages[lastAssistantIndex], {
                            type: 'recommendation', // or message
                            deals: allDeals,
                            searchQuery: searchQuery
                        });
                        conversation.updatedAt = new Date();

                        // Only save if we have a userId to satisfy schema validation
                        if (conversation.userId) {
                            await conversation.save();
                            console.log(`💾 Updated conversation with stream results: ${session}`);
                        }
                    }
                }
            } catch (e) { console.error("Error updating conversation", e); }
        }


        // Check if we have any results from local Nigerian stores (slot, jumia, jiji, konga)
        const localStoreDeals = allDeals.filter(deal => {
            const source = deal.source?.toLowerCase() || '';
            return source.includes('slot') || source.includes('jumia') ||
                source.includes('jiji') || source.includes('konga') ||
                source.includes('ajebo');
        });

        // Only send local-status if no local store results found
        // This triggers the Search Party modal AFTER all searches are complete
        if (localStoreDeals.length === 0) {
            sendEvent('local-status', {
                found: localStoreDeals.length,
                userHasPhone: !!(user && user.phoneNumber)
            });
        }

        // Send Done
        sendEvent('search-progress', { message: `Search complete! Found ${allDeals.length} high-quality deals.`, resultsFound: allDeals.length });
        sendEvent('done', { totalValid: allDeals.length });
        res.end();

    } catch (error) {
        console.error('Stream execution failed:', error);
        sendEvent('error', { message: 'Search stream failed' });
        res.end();
    }
});

// Reset conversation endpoint
app.post('/api/reset', (req, res) => {
    const { sessionId } = req.body;
    // In a real app, we might mark the session as inactive or deleted
    // For now, we just acknowledge the reset
    console.log(`[Reset] Resetting session: ${sessionId}`);
    res.json({ success: true, message: 'Conversation reset successfully' });
});

// WhatsApp API Endpoints
app.get('/api/whatsapp/qr', (req, res) => {
    const qr = whatsappService.getQR();
    if (qr) {
        res.json({ qr });
    } else {
        res.status(404).json({ message: 'QR code not available. Client might be connected or initializing.' });
    }
});

app.get('/api/whatsapp/status', (req, res) => {
    res.json(whatsappService.getStatus());
});

app.post('/api/whatsapp/send', authenticateToken, async (req, res) => {
    // Basic security for now: only allow admin or specific users if needed
    const { phoneNumber, message } = req.body;
    if (!phoneNumber || !message) {
        return res.status(400).json({ error: 'Phone number and message are required' });
    }

    try {
        await whatsappService.sendMessage(phoneNumber, message);
        res.json({ success: true, message: 'WhatsApp message sent' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);

    // Log initial memory usage
    const used = process.memoryUsage();
    console.log(`📊 Initial Memory Usage:
      RSS: ${Math.round(used.rss / 1024 / 1024 * 100) / 100} MB
      Heap Total: ${Math.round(used.heapTotal / 1024 / 1024 * 100) / 100} MB
      Heap Used: ${Math.round(used.heapUsed / 1024 / 1024 * 100) / 100} MB
      External: ${Math.round(used.external / 1024 / 1024 * 100) / 100} MB`);

    // Initialize WhatsApp service conditionally
    if (process.env.ENABLE_WHATSAPP !== 'false') {
        console.log('📱 Starting WhatsApp Service...');
        whatsappService.initialize();
    } else {
        console.log('🚫 WhatsApp Service disabled by environment variable.');
    }
});

// Handle graceful shutdown
const gracefulShutdown = async () => {
    console.log('🛑 Graceful shutdown initiated...');
    await whatsappService.destroy();
    server.close(() => {
        console.log('👋 Server closed.');
        process.exit(0);
    });
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
