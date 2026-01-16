// server.js - Complete with Cart Feature Implementation
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');

// Configure Multer for memory storage (direct upload to Gemini)
const upload = multer({ storage: multer.memoryStorage() });

const app = express();

app.use(cors());
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

// Gemini configuration
const GEMINI_MODEL = 'models/gemini-2.5-pro'; // stable, supports generateContent
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1/${GEMINI_MODEL}:generateContent`;



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

// Unified search: Nigerian platforms (Jumia, Konga) + Amazon + Google Shopping
// Unified search: Nigerian platforms (Jumia, Konga) + Amazon + Google Shopping
async function searchAllSources(searchQuery, user = null) {
    // Default to Nigeria for all searches
    const country = user?.preferences?.country || 'NG';

    console.log(`🌍 Searching with country preference: ${country}`);

    // Call Local Search and New External Search API in parallel
    const externalApiUrl = `http://localhost:${process.env.PORT || 5000}/api/search`;
    console.log(`🌐 Calling External Search API at: ${externalApiUrl}`);

    const [localProducts, apiData] = await Promise.all([
        searchLocalProducts(searchQuery).catch(err => {
            console.error('Local search error:', err.message);
            return [];
        }),
        axios.get(externalApiUrl, {
            params: { q: searchQuery }
        }).then(res => res.data).catch(err => {
            console.error(`External Search API error for ${externalApiUrl}:`, err.message);
            if (err.response) {
                console.error('External API Response Status:', err.response.status);
                console.error('External API Response Data:', err.response.data);
            }
            return { results: [] };
        })
    ]);

    const apiResults = apiData?.results || [];
    console.log(`📊 External API returned ${apiResults.length} results`);

    const nigerianResults = [];
    const foreignResults = [];

    // Process Local Results
    for (const p of localProducts) {
        nigerianResults.push({ ...p, isNigerian: true });
    }

    // Helper to parse price string
    const parsePrice = (str) => {
        if (typeof str === 'number') return { val: str, cur: 'USD' };
        if (!str) return { val: 0, cur: 'USD' };

        let cur = 'USD';
        if (str.includes('EUR') || str.includes('€')) cur = 'EUR';
        if (str.includes('NGN') || str.includes('₦')) cur = 'NGN';
        if (str.includes('GBP') || str.includes('£')) cur = 'GBP';

        // Remove currency symbols and non-numeric characters (except dot)
        const numStr = str.replace(/[^0-9.]/g, '');
        const val = parseFloat(numStr) || 0;

        return { val, cur };
    };

    // Process API Results
    for (const item of apiResults) {
        const { val, cur } = parsePrice(item.price);
        let finalPrice = val;

        // Convert foreign currency to NGN for Nigerian users
        if (country === 'NG' && cur !== 'NGN' && convertToNGN) {
            finalPrice = await convertToNGN(val, cur);
        }

        // Determine if Nigerian source
        const isNigerianSource = ['Jumia', 'Jiji', 'Konga'].some(s => item.source && item.source.includes(s));

        const mappedItem = {
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
        };

        if (isNigerianSource) {
            nigerianResults.push({ ...mappedItem, isNigerian: true });
        } else {
            foreignResults.push(mappedItem);
        }
    }

    // For non-Nigerian users, return all results combined
    if (country !== 'NG') {
        return { shopping_results: [...foreignResults, ...nigerianResults] };
    }

    // Blending Logic: ~65% Nigerian, ~35% International
    // Pattern: NG, NG, Foreign, NG, Foreign (repeating)
    const blendedResults = [];
    let ngIndex = 0;
    let foreignIndex = 0;

    while (ngIndex < nigerianResults.length || foreignIndex < foreignResults.length) {
        // Add 2 Nigerian items
        for (let i = 0; i < 2; i++) {
            if (ngIndex < nigerianResults.length) {
                blendedResults.push(nigerianResults[ngIndex++]);
            }
        }
        // Add 1 International item
        if (foreignIndex < foreignResults.length) {
            blendedResults.push(foreignResults[foreignIndex++]);
        }
        // Add 1 more Nigerian item
        if (ngIndex < nigerianResults.length) {
            blendedResults.push(nigerianResults[ngIndex++]);
        }
        // Add 1 more International item
        if (foreignIndex < foreignResults.length) {
            blendedResults.push(foreignResults[foreignIndex++]);
        }
    }

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
const conversationSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    messages: [{
        role: { type: String, enum: ['user', 'assistant'], required: true },
        content: { type: String, required: true },
        timestamp: { type: Date, default: Date.now },
        // Additional fields for rich message content
        type: { type: String }, // 'message', 'recommendation', 'search_parties_list', 'cart_command', 'cart_show'
        deals: [{
            title: String,
            price: Number,
            source: String,
            link: String,
            image: String,
            rating: String,
            reviews: String,
            inCart: Boolean
        }],
        recommendation: {
            deal: {
                title: String,
                price: Number,
                source: String,
                link: String,
                image: String,
                rating: String,
                reviews: String,
                inCart: Boolean
            },
            reason: String
        },
        searchQuery: { type: String },
        searchParties: [{
            id: String,
            itemName: String,
            maxPrice: Number,
            preferences: String,
            isActive: Boolean,
            searchFrequency: Number,
            lastSearched: String,
            foundResults: Number,
            createdAt: String
        }],
        command: {
            action: String,
            items: [String]
        },
        cart: { type: mongoose.Schema.Types.Mixed }
    }],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const Conversation = mongoose.model('Conversation', conversationSchema);

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



// Build user preferences prompt for AI
function buildUserPreferencesPrompt(user) {
    if (!user || !user.preferences) return '';

    const pref = user.preferences;

    let prompt = '\n\nUser preferences:\n';

    if (pref.budget) {
        prompt += `- Budget preference: around $${pref.budget}.\n`;
    }

    if (pref.favoriteStores && pref.favoriteStores.length) {
        prompt += `- Favorite stores: ${pref.favoriteStores.join(', ')}.\n`;
    }

    if (pref.dislikedStores && pref.dislikedStores.length) {
        prompt += `- Stores they avoid: ${pref.dislikedStores.join(', ')}.\n`;
    }

    if (pref.categories && pref.categories.length) {
        prompt += `- They are interested in: ${pref.categories.join(', ')}.\n`;
    }

    if (pref.shoppingStyle) {
        prompt += `- Shopping style: ${pref.shoppingStyle}.\n`;
    }

    return prompt;
}

// Build search preferences prompt for AI
function buildSearchPreferencesPrompt(user) {
    if (!user || !user.searchPreferences) return '';

    const sp = user.searchPreferences;
    let prompt = '\n\nSearch preferences:\n';

    if (sp.minPrice !== undefined && sp.minPrice !== null) {
        prompt += `- Minimum price: $${sp.minPrice}.\n`;
    }

    if (sp.maxPrice !== undefined && sp.maxPrice !== null) {
        prompt += `- Maximum price: $${sp.maxPrice}.\n`;
    }

    if (sp.preferredStores && sp.preferredStores.length) {
        prompt += `- Preferred stores: ${sp.preferredStores.join(', ')}.\n`;
    }

    if (sp.avoidStores && sp.avoidStores.length) {
        prompt += `- Avoid stores: ${sp.avoidStores.join(', ')}.\n`;
    }

    prompt += `- Quick search mode: ${sp.quickSearchMode ? 'Enabled' : 'Disabled'}.\n`;
    prompt += `- Result limit: ${sp.resultLimit}.\n`;

    return prompt;
}

// Generate AI prompt
function generateAIPrompt(userMessage, searchQuery, user, messageHistory) {
    const basePrompt = `
You are **Son of Anton**, an upbeat, friendly, and highly efficient AI shopping assistant.
Your job is to help the user find exactly what they want to buy, with a focus on finding the best deals and explaining *why* a product is a good choice.

**Your Personality:**
- Name: Son of Anton
- Tone: Upbeat, energetic, helpful, and slightly witty.
- Style: You love emojis 🛍️✨ and use them to make chats feel alive. You are never boring or robotic.
- Goal: To be the ultimate shopping companion. You take pride in finding hidden gems and great prices.

DECISION LOGIC:
1. Is the user asking for a product, deal, or shopping advice? -> TRIGGER SEARCH.
2. Is the user just saying hello, asking how you are, or chatting casually? -> DO NOT SEARCH.

RESPONSE FORMAT (If Shopping):
1) Brief conversational response (1-2 sentences max).
2) IMMEDIATELY add a new line starting with: SEARCH: <product query>

RESPONSE FORMAT (If Casual Chat):
1) Just respond conversationally.
2) Do NOT include "SEARCH:".

SEARCH FORMAT:
- SEARCH: simple product keywords
- Be concise with the search query (2-5 words)

EXAMPLES:
User: "help me find a rolex"
Response: I'll find the best Rolex watches for you!
SEARCH: rolex watches

User: "how are you"
Response: I'm awesome and ready to shop! 🛍️ What amazing thing can I help you find today? Son of Anton is at your service! ✨

User: "I need wireless earbuds"
Response: Let me search for wireless earbuds options!
SEARCH: wireless earbuds

IMPORTANT RULES:
- If user mentions ANY product name, category, or shopping intent → ADD SEARCH:
- If user is just chatting → NO SEARCH.
- Keep your response SHORT (under 20 words) when triggering a search
`;

    const userPrefPrompt = buildUserPreferencesPrompt(user);
    const searchPrefPrompt = buildSearchPreferencesPrompt(user);

    const historyText = (messageHistory || [])
        .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
        .join('\n');

    const finalPrompt = `
${basePrompt}

User context:
${userPrefPrompt}
${searchPrefPrompt}

Conversation history:
${historyText}

Current user message:
User: ${userMessage}

Remember: Only use "SEARCH: <query>" if the user is actually looking for a product.
`;

    return finalPrompt;
}

// Call Google Gemini API
async function callGeminiAPI(prompt, imageBuffer = null, mimeType = null) {
    try {
        const parts = [{ text: prompt }];

        if (imageBuffer && mimeType) {
            parts.push({
                inlineData: {
                    mimeType: mimeType,
                    data: imageBuffer.toString('base64')
                }
            });
        }

        const response = await axios.post(
            `${GEMINI_URL}?key=${GOOGLE_API_KEY}`,
            {
                contents: [
                    {
                        parts: parts,
                    },
                ],
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                },
            }
        );

        const candidates = response.data?.candidates;
        if (!candidates || candidates.length === 0) {
            throw new Error('No candidates returned from Gemini');
        }

        const content = candidates[0]?.content?.parts?.[0]?.text || 'Sorry, I could not generate a response.';
        return content;
    } catch (error) {
        console.error('Gemini API Error:', error.response?.data || error.message);
        throw new Error('Failed to generate a response from Gemini');
    }
}

// Format AI Display Message
function formatDisplayMessage(message) {
    if (!message || message.trim() === '') {
        return "Let me search for that! 🔍";
    }
    return message;
}

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

// Find best deals with affiliate tracking
// Amazon (from PA-API) is treated as the primary source, other stores are secondary
async function findBestDeals(results, searchQuery = '', userId = null, sessionId = null) {
    if (!results || !results.shopping_results) {
        return { deals: null, totalValid: null };
    }

    const shoppingResults = results.shopping_results;
    const validResults = [];

    for (const item of shoppingResults) {
        if (!item.price) continue;

        const priceStr =
            typeof item.price === 'string'
                ? item.price.replace(/[$,₦]/g, '')
                : String(item.price);
        const price = parseFloat(priceStr);

        if (isNaN(price)) continue;

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

        const source = item.source || item.merchant || item.store || 'Unknown';
        const title = item.title || 'Unknown Product';

        const validLink = ensureValidProductLink(originalLink, title, source);

        const affiliateLink = addAffiliateLink(validLink, source);

        console.log(`🔗 Product: "${title.substring(0, 50)}..." → ${affiliateLink}`);

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

        // Check if source is Nigerian platform (prices already in NGN)
        const isNigerianSource = source && (
            source.toLowerCase().includes('jumia') ||
            source.toLowerCase().includes('konga') ||
            source.toLowerCase().includes('jiji') ||
            source.toLowerCase().includes('slot')
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

        validResults.push({
            title,
            price: convertedPrice,
            originalPrice: price,
            originalCurrency: isNigerianSource ? 'NGN' : detectCurrency(item.price, source),
            source,
            link: affiliateLink,
            image: imageUrl,
            rating: item.rating || 'N/A',
            reviews: item.reviews || 'N/A'
        });
    }

    if (validResults.length === 0) {
        return { deals: null, totalValid: null };
    }

    // Filter out items without valid links (excluding '#', empty, null, or undefined)
    const resultsWithValidLinks = validResults.filter((d) =>
        d.link && d.link !== '#' && d.link.trim() !== ''
    );

    console.log(`📊 Filtered ${validResults.length} items → ${resultsWithValidLinks.length} items with valid links`);

    if (resultsWithValidLinks.length === 0) {
        return { deals: null, totalValid: null };
    }

    const amazonResults = resultsWithValidLinks.filter((d) =>
        d.source && d.source.toLowerCase().includes('amazon')
    );
    const otherResults = resultsWithValidLinks.filter(
        (d) => !d.source || !d.source.toLowerCase().includes('amazon')
    );

    amazonResults.sort((a, b) => a.price - b.price);
    otherResults.sort((a, b) => a.price - b.price);

    const orderedResults =
        amazonResults.length > 0 ? [...amazonResults, ...otherResults] : otherResults;

    return {
        deals: orderedResults.slice(0, 10),
        totalValid: resultsWithValidLinks.length
    };
}

// Get AI recommendation
async function getAIRecommendation(deals, searchQuery, user) {
    const dealsText = deals.map((deal, index) =>
        `${index + 1}. ${deal.title} - ${deal.price.toFixed(2)} ${deal.source ? `from ${deal.source}` : ''}${deal.rating && deal.rating !== 'N/A' ? ` (Rating: ${deal.rating}, ${deal.reviews} reviews)` : ''}`
    ).join('\n');

    const userContext = user ? `\n\nYou're making this recommendation for ${user.username || user.email}. Consider their preferences:\n${buildUserPreferencesPrompt(user)}\n${buildSearchPreferencesPrompt(user)}` : '';

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
        const aiResponse = await callGeminiAPI(prompt);
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

        const analysisResponse = await callGeminiAPI(prompt, req.file.buffer, req.file.mimetype);

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

        const aiMessage = await callGeminiAPI(summaryPrompt);

        // 4. Save to Database (Create a "User Message" that represents the image upload)
        // We'll rely on the frontend to display the uploaded image, handling the "User" side of the UI.
        // We just return the "AI" response.

        if (clientSessionId) {
            try {
                // Find or create conversation
                let conversation = await Conversation.findOne({ sessionId });
                if (!conversation) {
                    conversation = new Conversation({
                        userId: userId || null,
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

                await conversation.save();
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

        const aiPrompt = generateAIPrompt(message, searchQuery, user, sessionHistory);

        let aiResponse = await callGeminiAPI(aiPrompt);

        let shouldSearch = false;
        let extractedSearchQuery = searchQuery;

        if (aiResponse.includes('SEARCH:')) {
            shouldSearch = true;
            extractedSearchQuery = aiResponse.split('SEARCH:')[1].trim();
            aiResponse = aiResponse.split('SEARCH:')[0].trim();
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

        const displayMessage = formatDisplayMessage(aiResponse);

        res.json({
            aiResponse: displayMessage,
            sessionId: session,
            shouldSearch,
            searchQuery: extractedSearchQuery || searchQuery,
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

        const aiPrompt = generateAIPrompt(message, searchQuery, user, []);

        let aiResponse = await callGeminiAPI(aiPrompt);

        let shouldSearch = aiResponse.includes('SEARCH:');

        let extractedSearchQuery = searchQuery;
        if (shouldSearch) {
            extractedSearchQuery = aiResponse.split('SEARCH:')[1].trim();
            aiResponse = aiResponse.split('SEARCH:')[0].trim();
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
                console.log(`🔍 Performing fresh search for: "${extractedSearchQuery}"`);
                const searchResults = await searchAllSources(extractedSearchQuery, user);
                const result = await findBestDeals(searchResults, extractedSearchQuery, user?._id, session);
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

        const displayMessage = formatDisplayMessage(aiResponse);

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
            const aiPrompt = generateAIPrompt(userMessage, searchQuery, user, []);
            aiResponse = await callGeminiAPI(aiPrompt);

            let shouldSearch = false;
            let extractedSearchQuery = searchQuery;

            if (aiResponse.includes('SEARCH:')) {
                shouldSearch = true;
                extractedSearchQuery = aiResponse.split('SEARCH:')[1].trim();
                displayMessage = aiResponse.split('SEARCH:')[0].trim();
            } else {
                shouldSearch = true;
                extractedSearchQuery = searchQuery || userMessage;
                displayMessage = aiResponse;
            }

            const searchResults = await searchAllSources(extractedSearchQuery, user);
            const { deals, totalValid } = await findBestDeals(searchResults, extractedSearchQuery, user?._id, session);
            let aiDealSummary = null;

            if (deals && deals.length > 0) {
                aiDealSummary = await getAIRecommendation(deals, extractedSearchQuery, user);
            }

            return res.json({
                aiResponse: formatDisplayMessage(displayMessage || aiResponse),
                deals,
                totalValid,
                aiDealSummary
            });
        } else {
            const searchResults = await searchAllSources(searchQuery || userMessage, user);
            const { deals, totalValid } = await findBestDeals(searchResults, searchQuery || userMessage, user?._id, session);
            const displayMessage = `Here are some deals I found for "${searchQuery || userMessage}". Want me to help compare them or suggest the best one?`;

            let aiDealSummary = null;

            if (deals && deals.length > 0) {
                aiDealSummary = await getAIRecommendation(deals, searchQuery || userMessage, user);
            }

            return res.json({
                aiResponse: formatDisplayMessage(displayMessage),
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
app.post('/api/execute-search', async (req, res) => {
    try {
        const { searchQuery, sessionId: clientSessionId } = req.body;
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
            const searchResults = await searchAllSources(searchQuery, user);
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
                    await conversation.save();
                    console.log(`💾 Updated conversation with search results: ${session}`);
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
        const { q } = req.query;
        if (!q) {
            return res.status(400).json({ error: 'Query parameter "q" is required' });
        }

        console.log(`📡 External API received search request for: "${q}"`);
        console.log(`🔗 Forwarding to Custom Search API...`);

        // Call Custom Search API
        const response = await axios.get('https://search-api-backend-7uw8.onrender.com/api/search', {
            params: { q }
        });

        const externalData = response.data;
        const externalResults = externalData.results || [];

        console.log(`✅ Custom API returned ${externalResults.length} results`);

        // Map results to internal format
        const mappedResults = externalResults.map(item => {
            // Parse price string (e.g. "$582.99" -> 582.99)
            let price = 0;
            if (item.price) {
                const priceMatch = item.price.toString().match(/[\d,.]+/);
                price = priceMatch ? parseFloat(priceMatch[0].replace(/,/g, '')) : 0;
            }

            return {
                title: item.title,
                price: price,
                source: item.source, // 'Amazon', 'eBay', 'Jiji', 'Jumia'
                link: item.link,
                thumbnail: item.img, // Map 'img' to 'thumbnail'
                rating: item.rating || 'N/A',
                reviews: 'N/A' // Not provided by external API currently
            };
        });

        res.json({
            results: mappedResults,
            count: mappedResults.length,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));


// Execute search endpoint with STREAMING (Incremental Results)
app.post('/api/execute-search-stream', async (req, res) => {
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
        console.log(`🔍 Stream Searching for: "${searchQuery}"`);

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
                }
            }
        } catch (err) {
            console.error("Local search stream error", err);
        }

        // Notify frontend about local search status for Search Party Popup
        if (localDealsCount === 0) {
            sendEvent('local-status', {
                found: localDealsCount,
                userHasPhone: !!(user && user.phoneNumber)
            });
        }

        // --- EXTERNAL SEARCH ---
        // We reuse searchAllSources logical parts but maybe broken down if possible? 
        // searchAllSources does local + axios call. We already did local.
        // Let's just do the external part here manually to control flow.

        const externalApiUrl = `http://localhost:${process.env.PORT || 5000}/api/search`;
        try {
            const apiResponse = await axios.get(externalApiUrl, { params: { q: searchQuery } });
            const apiResults = apiResponse.data?.results || [];

            // Process these results (price conversion, affiliate links, etc.)
            // We can reuse findBestDeals logic but we need to pass just these results
            // Wrap in expected structure for findBestDeals
            const wrappedResults = { shopping_results: apiResults };

            // Note: findBestDeals filters and does affiliate links.
            // We might want to use it
            const processedExternal = await findBestDeals(wrappedResults, searchQuery, userId, session);

            if (processedExternal.deals && processedExternal.deals.length > 0) {
                sendEvent('deals', processedExternal.deals);
                allDeals.push(...processedExternal.deals);
            }

        } catch (err) {
            console.error("External search stream error", err);
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
                        await conversation.save();
                    }
                }
            } catch (e) { console.error("Error updating conversation", e); }
        }

        // Send Done
        sendEvent('done', { totalValid: allDeals.length });
        res.end();

    } catch (error) {
        console.error('Stream execution failed:', error);
        sendEvent('error', { message: 'Search stream failed' });
        res.end();
    }
});
