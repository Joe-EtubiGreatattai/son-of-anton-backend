// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(cors());

// Load API keys and configuration from environment variables
const SERP_API_KEY = process.env.SERP_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sonofanton';
const SERP_BASE_URL = 'https://serpapi.com/search';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// Search frequency configuration - user configurable via environment variables
const SEARCH_FREQUENCY_HOURS = parseInt(process.env.SEARCH_FREQUENCY_HOURS) || 6; // Default to 6 hours
const SEARCH_FREQUENCY_MINUTES = parseInt(process.env.SEARCH_FREQUENCY_MINUTES) || null; // Optional minutes configuration
const MIN_SEARCH_INTERVAL = 0.0667; // Minimum 1 hour between searches for the same party
const MAX_SEARCH_INTERVAL = 24 * 7; // Maximum 1 week between searches

// Calculate the cron interval in milliseconds
function getCronInterval() {
    if (SEARCH_FREQUENCY_MINUTES) {
        return SEARCH_FREQUENCY_MINUTES * 60 * 1000; // Convert minutes to milliseconds
    }
    return SEARCH_FREQUENCY_HOURS * 60 * 60 * 1000; // Convert hours to milliseconds
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

// Email configuration - use the shared module
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
        quickSearchMode: { type: Boolean, default: true } // New preference for quick search mode
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
    searchFrequency: { type: Number, default: null }, // User-specific frequency override
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

const User = mongoose.model('User', userSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);
const SearchParty = mongoose.model('SearchParty', searchPartySchema);

// Store active sessions in memory (for temporary sessions)
const activeSessions = new Map();

// Display search frequency configuration
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

// Dynamic SYSTEM_PROMPT that includes user information
const getSystemPrompt = (user) => {
    const basePrompt = `You are "Son of Anton" - a super friendly, upbeat, and enthusiastic shopping assistant with tons of personality! 

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
- Only use SEARCH: when doing immediate single searches
- Keep all responses concise and friendly

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

    // Add personalized section if user is logged in
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
                currentInterval: VALIDATED_CRON_INTERVAL / (60 * 60 * 1000) // Convert to hours
            },
            user: userConfig
        });
    } catch (error) {
        console.error('Get search config error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

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
    
    // Check if message contains search triggers
    const hasSearchTrigger = searchTriggers.some(trigger => 
        lowerMessage.includes(trigger)
    );
    
    // Check if message contains product categories
    const hasProductCategory = productCategories.some(category =>
        lowerMessage.includes(category)
    );
    
    // Check for specific product patterns
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
    const lowerMessage = message.toLowerCase();
    
    // Remove common conversational phrases
    const cleanedMessage = message.replace(
        /(can you |please |could you |i |want to |looking to |need to )?(find|search for|look for|get|buy|purchase)?\s*/gi, 
        ''
    ).trim();
    
    // Add "deals" or "best price" for better shopping results
    if (cleanedMessage.length > 0) {
        return `${cleanedMessage} deals today`;
    }
    
    // Fallback to original message with shopping context
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
        
        let conversationHistory = [];
        let conversationDoc = null;

        // Get conversation history from DB if user is logged in
        if (user) {
            conversationDoc = await Conversation.findOne({ userId: user._id, sessionId: session });
            if (conversationDoc) {
                conversationHistory = conversationDoc.messages.map(msg => ({
                    role: msg.role,
                    parts: [{ text: msg.content }]
                }));
            }
        } else {
            // Use in-memory session for guests
            if (!activeSessions.has(session)) {
                activeSessions.set(session, []);
            }
            conversationHistory = activeSessions.get(session) || [];
        }

        // Add user message to history (for Gemini API format)
        conversationHistory.push({
            role: 'user',
            parts: [{ text: message }]
        });

        // Save user message to DB
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

        // Get personalized system prompt
        const systemPrompt = getSystemPrompt(user);

        // Call Gemini API with system prompt as first user message
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
        
        // Clean up excessive asterisks (***) to proper markdown (**)
        aiResponse = aiResponse.replace(/\*\*\*/g, '**');
        
        // Add AI response to history (for next API call)
        conversationHistory.push({
            role: 'model',
            parts: [{ text: aiResponse }]
        });

        // Save AI response to DB
        if (user && conversationDoc) {
            const assistantMessage = { role: 'model', content: aiResponse };
            conversationDoc.messages.push(assistantMessage);
            conversationDoc.updatedAt = new Date();
            await conversationDoc.save();
        } else if (!user) {
            // Update in-memory session for guests
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
            
            // Parse maxPrice safely
            let maxPrice = null;
            if (partyData[1]) {
                const priceStr = partyData[1].trim().replace(/[$,]/g, '');
                const parsedPrice = parseFloat(priceStr);
                if (!isNaN(parsedPrice) && parsedPrice > 0) {
                    maxPrice = parsedPrice;
                }
            }
            
            const preferences = partyData[2]?.trim() || '';
            
            // Parse frequency (default to user preference if not specified)
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

                const priceMsg = maxPrice ? ` under $${maxPrice}` : '';
                const frequencyMsg = ` (searches every ${frequency} hours)`;
                
                return res.json({
                    sessionId: session,
                    type: 'message',
                    message: `🎉 Search Party started, ${user.username}! I'll keep looking for "${itemName}"${priceMsg}${frequencyMsg} and notify you when I find great deals!`
                });
            }
        }

        // NEW: Check if this is a product search query and AI didn't trigger search
        const shouldSearch = isProductSearchQuery(message) && !aiResponse.includes('SEARCH:');
        
        if (shouldSearch) {
            const searchQuery = generateSearchQuery(message);
            const displayMessage = `Searching for "${searchQuery}"... 🔍\n\nHere are some quick results! Want to specify your budget, brand, or other preferences for more tailored options?`;
            
            // Check user preference for quick search mode
            const useQuickSearch = user ? user.searchPreferences.quickSearchMode : true;

            if (useQuickSearch) {
                // Perform search
                const searchResults = await searchItem(searchQuery);
                const { deals, totalValid } = findBestDeals(searchResults);

                if (deals && deals.length > 0) {
                    const recommendation = await getAIRecommendation(deals, searchQuery, user);
                    const recommendationData = parseRecommendation(recommendation, deals);

                    return res.json({
                        sessionId: session,
                        type: 'recommendation',
                        message: displayMessage,
                        searchQuery,
                        deals: deals.slice(0, 3),
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

            // Perform search
            const searchResults = await searchItem(searchQuery);
            const { deals, totalValid } = findBestDeals(searchResults);

            if (deals && deals.length > 0) {
                const recommendation = await getAIRecommendation(deals, searchQuery, user);
                const recommendationData = parseRecommendation(recommendation, deals);

                return res.json({
                    sessionId: session,
                    type: 'recommendation',
                    message: formatDisplayMessage(displayMessage),
                    searchQuery,
                    deals: deals.slice(0, 3),
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

// Find best deals
function findBestDeals(results) {
    if (!results || !results.shopping_results) {
        return { deals: null, totalValid: null };
    }

    const shoppingResults = results.shopping_results;
    const validResults = [];

    for (const item of shoppingResults) {
        if (!item.price) continue;

        // Extract price number robustly
        const priceStr = (typeof item.price === 'string') ? item.price.replace(/[$,]/g, '') : ('' + item.price);
        const price = parseFloat(priceStr);

        if (isNaN(price)) continue;

        // Try common image fields SerpApi may return for shopping results
        const imageUrl = item.thumbnail || item.image || (item.images && item.images[0] && item.images[0].src) || (item.product && item.product.thumbnail) || null;

        validResults.push({
            title: item.title || 'Unknown',
            price: price,
            source: item.source || item.merchant || item.store || 'Unknown',
            link: item.link || item.url || (item.product && item.product.link) || '#',
            image: imageUrl,
            rating: item.rating || 'N/A',
            reviews: item.reviews || 'N/A'
        });
    }

    if (validResults.length === 0) {
        return { deals: null, totalValid: null };
    }

    // Sort by price (lowest first)
    validResults.sort((a, b) => a.price - b.price);

    return {
        deals: validResults.slice(0, 10),
        totalValid: validResults.length
    };
}

// Get AI recommendation (updated to include user info)
async function getAIRecommendation(deals, searchQuery, user) {
    const dealsText = deals.map((deal, index) => 
        `${index + 1}. ${deal.title} - $${deal.price.toFixed(2)} from ${deal.source}${deal.rating !== 'N/A' ? ` (Rating: ${deal.rating}, ${deal.reviews} reviews)` : ''}`
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
        }
    });
});

// Search Party Cron Job
async function runSearchParties() {
    try {
        console.log('🕒 CRON JOB: Starting Search Party execution...');
        
        const activeParties = await SearchParty.find({ isActive: true });
        
        console.log(`🔍 CRON JOB: Found ${activeParties.length} active search parties`);
        
        // Log all active search parties
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
            // Use user-specific frequency if set, otherwise use system default
            const userFrequencyHours = party.searchFrequency || SEARCH_FREQUENCY_HOURS;
            const userFrequencyMs = userFrequencyHours * 60 * 60 * 1000;
            
            // Only search based on user's preferred frequency
            const timeSinceLastSearch = Date.now() - party.lastSearched.getTime();
            
            if (timeSinceLastSearch < userFrequencyMs) {
                const hoursSince = Math.round(timeSinceLastSearch / (60 * 60 * 1000));
                console.log(`⏭️  Skipping "${party.itemName}" - searched ${hoursSince}h ago (less than ${userFrequencyHours}h)`);
                continue;
            }

            console.log(`🔎 Searching for: "${party.itemName}" (User: ${party.userId}, Frequency: ${userFrequencyHours}h)`);
            
            const results = await searchItem(party.searchQuery);
            const { deals } = findBestDeals(results);

            if (deals && deals.length > 0) {
                // Filter by max price if set
                const filteredDeals = party.maxPrice 
                    ? deals.filter(deal => deal.price <= party.maxPrice)
                    : deals;

                console.log(`   Found ${deals.length} total deals, ${filteredDeals.length} after price filtering`);

                if (filteredDeals.length > 0) {
                    // Get user info for email
                    const user = await User.findById(party.userId);
                    
                    if (user && user.searchPreferences.notifyOnDeals) {
                        // Send email notification
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

                    // Add new results to database
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

            // Prevent API rate limiting
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        console.log('✅ CRON JOB: Search Party execution completed');
    } catch (error) {
        console.error('❌ CRON JOB: Search party cron error:', error);
    }
}

module.exports = {
    sendDealEmail,
    formatDisplayMessage,
    searchItem,
    findBestDeals,
    getAIRecommendation,
    parseRecommendation
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Son of Anton API running on port ${PORT}`);
    displaySearchConfiguration();
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
    console.log(`   POST /api/reset - Reset conversation`);
    console.log(`   GET /api/health - Health check`);
});

// Setup Search Party cron job
console.log(`⏰ Setting up Search Party cron job to run every ${VALIDATED_CRON_INTERVAL / (60 * 1000)} minutes`);

setInterval(() => {
    console.log(`\n🔄 CRON JOB: Scheduled Search Party execution started at ${new Date().toISOString()}`);
    runSearchParties();
}, VALIDATED_CRON_INTERVAL);

// Run immediately on startup to show current state
setTimeout(() => {
    console.log(`\n🚀 INITIAL CRON JOB: Running initial Search Party check at ${new Date().toISOString()}`);
    runSearchParties();
}, 5000);
