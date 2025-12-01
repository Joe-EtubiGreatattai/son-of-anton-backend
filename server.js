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
    origin: true, // Accept all origins
    credentials: true,
    optionsSuccessStatus: 200
};

app.use(express.json());
app.use(cors(corsOptions));

// Load API keys and configuration from environment variables
const SERP_API_KEY = process.env.SERP_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const EXCHANGE_RATE_API_KEY = process.env.EXCHANGE_RATE_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

// Base URL for SerpAPI
const SERP_BASE_URL = 'https://serpapi.com/search';

// Gemini configuration
const GEMINI_MODEL = 'models/gemini-2.5-pro'; // stable, supports generateContent
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1/${GEMINI_MODEL}:generateContent`;



// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/chat_app';

// Search frequency configuration
const SEARCH_FREQUENCY_HOURS = parseInt(process.env.SEARCH_FREQUENCY_HOURS, 10) || null;
const SEARCH_FREQUENCY_MINUTES = parseInt(process.env.SEARCH_FREQUENCY_MINUTES, 10) || 10;

// Exchange rate update frequency configuration
const EXCHANGE_RATE_UPDATE_HOURS = parseInt(process.env.EXCHANGE_RATE_UPDATE_HOURS, 10) || 6;


// Affiliate configuration
const AFFILIATE_CONFIGS = {
    amazon: {
        // Amazon is ON by default – only turn off by explicitly setting AMAZON_AFFILIATE_ENABLED=false
        enabled: process.env.AMAZON_AFFILIATE_ENABLED === 'false' ? false : true,
        // Your affiliate code as the default tag
        tag: process.env.AMAZON_AFFILIATE_TAG || 'sagato-20',
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

// Amazon Product Advertising API (PA-API) setup
let ProductAdvertisingAPIv1 = null;
let amazonApi = null;
let AMAZON_API_ENABLED = false;

try {
    ProductAdvertisingAPIv1 = require('paapi5-nodejs-sdk');

    const defaultClient = ProductAdvertisingAPIv1.ApiClient.instance;
    defaultClient.accessKey = process.env.AMAZON_PAAPI_ACCESS_KEY || '';
    defaultClient.secretKey = process.env.AMAZON_PAAPI_SECRET_KEY || '';
    defaultClient.host = process.env.AMAZON_PAAPI_HOST || 'webservices.amazon.com';
    defaultClient.region = process.env.AMAZON_PAAPI_REGION || 'us-east-1';

    amazonApi = new ProductAdvertisingAPIv1.DefaultApi();
    AMAZON_API_ENABLED = !!(defaultClient.accessKey && defaultClient.secretKey);

    if (!AMAZON_API_ENABLED) {
        console.warn('⚠️ Amazon PA-API credentials not set. Set AMAZON_PAAPI_ACCESS_KEY and AMAZON_PAAPI_SECRET_KEY to enable direct Amazon search.');
    } else {
        console.log('✅ Amazon PA-API client configured.');
    }
} catch (error) {
    console.warn('⚠️ Amazon PA-API SDK not installed. Run "npm install paapi5-nodejs-sdk" to enable direct Amazon search.');
}

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
mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
    .then(() => console.log('MongoDB connected'))
    .catch((err) => console.error('MongoDB connection error:', err));

// User Schema and Model
const userSchema = new mongoose.Schema({
    username: { type: String },
    email: { type: String, required: true, unique: true },
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

// Middleware to authenticate and retrieve user from token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;

    // Allow unauthenticated access but attach userId if token is valid
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        req.userId = null; // no userId for unauthenticated requests
        return next();
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
    } catch (err) {
        console.error('JWT verification failed:', err.message);
        req.userId = null;
    }

    next();
};

app.use(authenticateToken);

// Search Amazon via SerpAPI (Fallback)
async function searchAmazonViaSerpApi(searchQuery) {
    try {
        console.log(`⚠️ Using SerpAPI fallback for Amazon search: "${searchQuery}"`);
        const params = {
            q: searchQuery,
            api_key: SERP_API_KEY,
            engine: 'amazon',
            type: 'search',
            amazon_domain: 'amazon.com'
        };

        const response = await axios.get(SERP_BASE_URL, { params });
        const results = response.data.search_results || [];

        return results.map(item => ({
            asin: item.asin,
            title: item.title,
            price: item.price ? item.price.value : null,
            thumbnail: item.thumbnail,
            link: item.link,
            source: 'Amazon',
            rating: item.rating,
            reviews: item.reviews
        })).filter(p => p.price !== null);

    } catch (error) {
        console.error('Error searching Amazon via SerpAPI:', error.message);
        return [];
    }
}

// Search products directly from Amazon Product Advertising API
async function searchAmazonProducts(searchQuery) {
    if (!AMAZON_API_ENABLED || !amazonApi || !ProductAdvertisingAPIv1) {
        console.warn('Amazon PA-API not enabled or SDK not available, using SerpAPI fallback.');
        return searchAmazonViaSerpApi(searchQuery);
    }

    const partnerTag = AFFILIATE_CONFIGS.amazon.tag;

    const searchItemsRequest = new ProductAdvertisingAPIv1.SearchItemsRequest();
    searchItemsRequest['PartnerTag'] = partnerTag;
    searchItemsRequest['PartnerType'] = 'Associates';
    searchItemsRequest['Keywords'] = searchQuery;
    searchItemsRequest['SearchIndex'] = 'All';
    searchItemsRequest['ItemCount'] = 10;
    searchItemsRequest['Resources'] = [
        'Images.Primary.Medium',
        'ItemInfo.Title',
        'Offers.Listings.Price',
        'CustomerReviews.Count',
        'CustomerReviews.StarRating',
        'ItemInfo.ByLineInfo',
        'ItemInfo.ProductInfo'
    ];

    return new Promise((resolve) => {
        amazonApi.searchItems(searchItemsRequest, function (error, data, response) {
            if (error) {
                console.error('Error calling Amazon PA-API:', error.message || error);
                console.log('🔄 Switching to SerpAPI fallback for Amazon...');
                return resolve(searchAmazonViaSerpApi(searchQuery));
            }

            try {
                const searchItemsResponse = ProductAdvertisingAPIv1.SearchItemsResponse.constructFromObject(data);
                const items = (searchItemsResponse.SearchResult && searchItemsResponse.SearchResult.Items) || [];

                const mapped = items
                    .map((item) => {
                        const asin = item.ASIN;
                        const title =
                            item.ItemInfo &&
                                item.ItemInfo.Title &&
                                item.ItemInfo.Title.DisplayValue
                                ? item.ItemInfo.Title.DisplayValue
                                : 'Unknown Amazon Product';

                        const image =
                            item.Images &&
                                item.Images.Primary &&
                                item.Images.Primary.Medium &&
                                item.Images.Primary.Medium.URL
                                ? item.Images.Primary.Medium.URL
                                : null;

                        let price = null;
                        if (
                            item.Offers &&
                            item.Offers.Listings &&
                            item.Offers.Listings[0] &&
                            item.Offers.Listings[0].Price &&
                            typeof item.Offers.Listings[0].Price.Amount === 'number'
                        ) {
                            price = item.Offers.Listings[0].Price.Amount;
                        }

                        const rating =
                            item.CustomerReviews &&
                                item.CustomerReviews.StarRating &&
                                item.CustomerReviews.StarRating.DisplayValue
                                ? item.CustomerReviews.StarRating.DisplayValue
                                : 'N/A';

                        const reviewsCount =
                            item.CustomerReviews &&
                                typeof item.CustomerReviews.Count === 'number'
                                ? item.CustomerReviews.Count
                                : 'N/A';

                        const detailUrl = item.DetailPageURL || null;

                        return {
                            asin,
                            title,
                            price,
                            thumbnail: image,
                            link: detailUrl,
                            source: 'Amazon',
                            rating,
                            reviews: reviewsCount
                        };
                    })
                    .filter((p) => p.price !== null && p.link);

                return resolve(mapped);
            } catch (parseError) {
                console.error('Error parsing Amazon PA-API response:', parseError.message || parseError);
                return resolve(searchAmazonViaSerpApi(searchQuery));
            }
        });
    });
}

// Search Jumia Nigeria
async function searchJumiaNigeria(searchQuery) {
    try {
        console.log(`🇳🇬 Searching Jumia Nigeria for: "${searchQuery}"`);
        const params = {
            q: `site:jumia.com.ng ${searchQuery}`,
            api_key: SERP_API_KEY,
            engine: 'google',
            num: 20, // Increased to get more results
            gl: 'ng',
            hl: 'en'
        };

        const response = await axios.get(SERP_BASE_URL, { params });
        const organicResults = response.data.organic_results || [];

        const jumiaProducts = organicResults
            .filter(result => result.link && result.link.includes('jumia.com.ng'))
            .map(result => {
                // Extract price from snippet or title
                const priceMatch = result.snippet?.match(/₦\s?([\d,]+)/);
                const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null;

                return {
                    title: result.title || 'Unknown Product',
                    price: price,
                    source: 'Jumia Nigeria',
                    link: result.link,
                    thumbnail: result.thumbnail || null,
                    rating: 'N/A',
                    reviews: 'N/A'
                };
            })
            .filter(p => p.price !== null);

        console.log(`✅ Found ${jumiaProducts.length} products on Jumia Nigeria`);
        return jumiaProducts;
    } catch (error) {
        console.error('Error searching Jumia Nigeria:', error.message);
        return [];
    }
}

// Search Konga Nigeria
async function searchKongaNigeria(searchQuery) {
    try {
        console.log(`🇳🇬 Searching Konga for: "${searchQuery}"`);
        const params = {
            q: `site:konga.com ${searchQuery}`,
            api_key: SERP_API_KEY,
            engine: 'google',
            num: 20, // Increased to get more results
            gl: 'ng',
            hl: 'en'
        };

        const response = await axios.get(SERP_BASE_URL, { params });
        const organicResults = response.data.organic_results || [];

        const kongaProducts = organicResults
            .filter(result => result.link && result.link.includes('konga.com'))
            .map(result => {
                // Extract price from snippet or title
                const priceMatch = result.snippet?.match(/₦\s?([\d,]+)/);
                const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null;

                return {
                    title: result.title || 'Unknown Product',
                    price: price,
                    source: 'Konga',
                    link: result.link,
                    thumbnail: result.thumbnail || null,
                    rating: 'N/A',
                    reviews: 'N/A'
                };
            })
            .filter(p => p.price !== null);

        console.log(`✅ Found ${kongaProducts.length} products on Konga`);
        return kongaProducts;
    } catch (error) {
        console.error('Error searching Konga:', error.message);
        return [];
    }
}

// Unified search: Nigerian platforms (Jumia, Konga) + Amazon + Google Shopping
async function searchAllSources(searchQuery, user = null) {
    // Default to Nigeria for all searches
    const country = user?.preferences?.country || 'NG';

    console.log(`🌍 Searching with country preference: ${country}`);

    // For Nigerian users, prioritize Nigerian platforms
    if (country === 'NG') {
        const [jumiaProducts, kongaProducts, amazonProducts, serpResults] = await Promise.all([
            searchJumiaNigeria(searchQuery).catch(err => {
                console.error('Jumia search error:', err.message);
                return [];
            }),
            searchKongaNigeria(searchQuery).catch(err => {
                console.error('Konga search error:', err.message);
                return [];
            }),
            searchAmazonProducts(searchQuery).catch(err => {
                console.error('Amazon search error:', err.message);
                return [];
            }),
            searchItem(searchQuery, country).catch((err) => {
                console.error('SerpAPI search error:', err.message || err);
                return null;
            })
        ]);

        console.log(`📊 Nigerian Search Results: Jumia=${jumiaProducts.length}, Konga=${kongaProducts.length}, Amazon=${amazonProducts.length}, Google Shopping=${serpResults?.shopping_results?.length || 0}`);

        const nigerianResults = [];
        const foreignResults = [];

        // Collect Jumia Results (Nigerian)
        for (const p of jumiaProducts) {
            nigerianResults.push({
                price: p.price,
                thumbnail: p.thumbnail,
                link: p.link,
                source: p.source,
                title: p.title,
                rating: p.rating,
                reviews: p.reviews,
                isNigerian: true
            });
        }

        // Collect Konga Results (Nigerian)
        for (const p of kongaProducts) {
            nigerianResults.push({
                price: p.price,
                thumbnail: p.thumbnail,
                link: p.link,
                source: p.source,
                title: p.title,
                rating: p.rating,
                reviews: p.reviews,
                isNigerian: true
            });
        }

        // Collect Google Shopping Results (Check for Nigerian vs Foreign)
        if (serpResults && serpResults.shopping_results) {
            for (const item of serpResults.shopping_results) {
                const source = item.source || item.merchant || item.store || '';
                // Skip if already added from Jumia/Konga
                if (source && (source.toLowerCase().includes('jumia') || source.toLowerCase().includes('konga'))) {
                    continue;
                }

                // Check if it's a Nigerian source (basic check + currency check if available)
                // For now, we assume Google Shopping NG returns mostly NG results, but let's be safe
                // If the currency is NGN, it's definitely Nigerian.
                // Since we don't have currency field easily here without parsing, we'll assume based on the search context 'NG'
                // But let's treat them as Nigerian for now as they come from the NG gl parameter.
                nigerianResults.push({
                    ...item,
                    isNigerian: true
                });
            }
        }

        // Collect Amazon Results (Foreign)
        for (const p of amazonProducts) {
            foreignResults.push({
                price: p.price,
                thumbnail: p.thumbnail,
                link: p.link,
                source: p.source,
                title: p.title,
                rating: p.rating,
                reviews: p.reviews,
                isNigerian: false
            });
        }

        // Blend Results: Favour Nigerian (2:1 ratio)
        const blendedResults = [];
        let ngIndex = 0;
        let foreignIndex = 0;

        while (ngIndex < nigerianResults.length || foreignIndex < foreignResults.length) {
            // Add up to 2 Nigerian items
            for (let i = 0; i < 2; i++) {
                if (ngIndex < nigerianResults.length) {
                    blendedResults.push(nigerianResults[ngIndex++]);
                }
            }
            // Add 1 Foreign item
            if (foreignIndex < foreignResults.length) {
                blendedResults.push(foreignResults[foreignIndex++]);
            }
        }

        return { shopping_results: blendedResults };
    }

    // For non-Nigerian users, use original logic
    const [amazonProducts, serpResults] = await Promise.all([
        searchAmazonProducts(searchQuery),
        searchItem(searchQuery, country).catch((err) => {
            console.error('SerpAPI search error:', err.message || err);
            return null;
        })
    ]);

    console.log(`📊 Search results debug: Amazon=${amazonProducts.length} items, SerpAPI=${serpResults ? 'success' : 'failed'}`);
    if (serpResults && serpResults.shopping_results) {
        console.log(`📊 SerpAPI found ${serpResults.shopping_results.length} shopping results`);
    } else if (serpResults) {
        console.log('📊 SerpAPI returned data but no shopping_results:', Object.keys(serpResults));
    }

    const shoppingResults = [];

    // Add Amazon products from Amazon PA-API as primary source
    for (const p of amazonProducts) {
        shoppingResults.push({
            price: p.price,
            thumbnail: p.thumbnail,
            link: p.link,
            source: p.source,
            title: p.title,
            rating: p.rating,
            reviews: p.reviews
        });
    }

    // Add non-Amazon products from SerpAPI as secondary
    if (serpResults && serpResults.shopping_results) {
        for (const item of serpResults.shopping_results) {
            const source = item.source || item.merchant || item.store || '';
            if (source && source.toLowerCase().includes('amazon')) {
                // Skip any Amazon items from Google – we only want direct Amazon API data
                continue;
            }
            shoppingResults.push(item);
        }
    }

    // We return an object that matches what findBestDeals expects
    return { shopping_results: shoppingResults };
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
        const { username, email, password, preferences } = req.body;

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
            preferences
        });

        const savedUser = await user.save();

        const token = generateToken(savedUser);

        res.status(201).json({
            message: 'User registered successfully',
            user: {
                id: savedUser._id,
                username: savedUser.username,
                email: savedUser.email,
                preferences: savedUser.preferences,
                searchPreferences: savedUser.searchPreferences
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

        const { preferences } = req.body;

        const user = await User.findByIdAndUpdate(
            req.userId,
            { $set: { preferences } },
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
You are a shopping assistant AI that helps users find the best deals and products.

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
Response: I'm doing great, ready to help you shop! What are you looking for today?

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
async function callGeminiAPI(prompt) {
    try {
        const response = await axios.post(
            `${GEMINI_URL}?key=${GOOGLE_API_KEY}`,
            {
                contents: [
                    {
                        parts: [
                            {
                                text: prompt,
                            },
                        ],
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

startScheduler();

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
console.log('🚀 Initializing exchange rates on server startup...');
fetchAndStoreExchangeRates().then((success) => {
    if (success) {
        console.log('✅ Initial exchange rates loaded successfully.');
    } else {
        console.warn('⚠️ Failed to load initial exchange rates. Will retry on next scheduled update.');
    }
});

// Schedule periodic updates
setInterval(async () => {
    console.log(`⏰ Running scheduled exchange rate update (every ${EXCHANGE_RATE_UPDATE_HOURS} hours)...`);
    await fetchAndStoreExchangeRates();
}, EXCHANGE_RATE_INTERVAL);

console.log(`✅ Exchange rate cron job scheduled to run every ${EXCHANGE_RATE_UPDATE_HOURS} hours.`);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
