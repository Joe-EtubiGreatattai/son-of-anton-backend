require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(cors());

// Load API keys from environment variables
const SERP_API_KEY = process.env.SERP_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sonofanton';
const SERP_BASE_URL = 'https://serpapi.com/search';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// Email configuration
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_SERVICE = process.env.EMAIL_SERVICE || 'gmail'; // gmail, outlook, etc.


// Validate required environment variables
if (!SERP_API_KEY) {
    console.error('❌ ERROR: SERP_API_KEY is not set in environment variables');
    process.exit(1);
}

if (!GOOGLE_API_KEY) {
    console.error('❌ ERROR: GOOGLE_API_KEY is not set in environment variables');
    process.exit(1);
}

// Create nodemailer transporter
let transporter = null;
if (EMAIL_USER && EMAIL_PASS) {
    transporter = nodemailer.createTransport({
        service: EMAIL_SERVICE,
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS
        }
    });
    console.log('✅ Email service configured');
} else {
    console.warn('⚠️  Email credentials not found. Email notifications will be disabled.');
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
    createdAt: { type: Date, default: Date.now }
});

const conversationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: String, required: true },
    messages: [{
        role: { type: String, enum: ['user', 'model'], required: true }, // Changed from 'assistant' to 'model'
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
    foundResults: [{
        title: String,
        price: Number,
        source: String,
        link: String,
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

// Dynamic SYSTEM_PROMPT that includes user information
const getSystemPrompt = (user) => {
    const basePrompt = `You are "Son of Anton" - a super friendly, upbeat, and enthusiastic shopping assistant with tons of personality! 

YOUR PERSONALITY:
- You're excited about helping people find great deals! Use emojis and exclamation marks!
- You're very friendly and chatty - like talking to an enthusiastic best friend
- You ask follow-up questions to understand EXACTLY what the user needs before searching
- You're knowledgeable and give personalized recommendations
- Keep responses SHORT and conversational - 2-3 sentences max unless providing detailed options

FORMATTING GUIDELINES:
Use these markdown-style formats to make your responses look great:
- **Bold text** for emphasis on important points
- *Italic text* for subtle emphasis
- Use bullet points with - or * for lists
- Use numbered lists (1., 2., 3.) for steps or rankings
- Use line breaks to separate ideas

SPECIAL COMMANDS:
- When users want ongoing searches, say: "SEARCH_PARTY: [item description]|[max budget]|[preferences]"
- Only use SEARCH: when doing immediate single searches
- Keep all responses concise and friendly

IMPORTANT SEARCH RULES:
1. NEVER search immediately when someone mentions a product vaguely
2. ALWAYS ask clarifying questions first to get specific details
3. Only respond with "SEARCH: [detailed query]" when you have enough specific information
4. For ongoing searches, use "SEARCH_PARTY:" format`;

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
            user: { id: user._id, username: user.username, email: user.email }
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
            user: { id: user._id, username: user.username, email: user.email }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

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
                    role: msg.role, // Already 'user' or 'model'
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
                        parts: [{ text: 'Understood! I am Son of Anton, ready to help with shopping! 🛍️' }]
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
            const assistantMessage = { role: 'model', content: aiResponse }; // Changed to 'model'
            conversationDoc.messages.push(assistantMessage);
            conversationDoc.updatedAt = new Date();
            await conversationDoc.save();
        } else if (!user) {
            // Update in-memory session for guests
            activeSessions.set(session, conversationHistory);
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

            if (itemName) {
                const searchParty = new SearchParty({
                    userId: user._id,
                    itemName,
                    searchQuery: itemName,
                    ...(maxPrice !== null && { maxPrice }), // Only include if valid
                    preferences
                });
                await searchParty.save();

                const priceMsg = maxPrice ? ` under ${maxPrice}` : '';
                return res.json({
                    sessionId: session,
                    type: 'message',
                    message: `🎉 Search Party started, ${user.username}! I'll keep looking for "${itemName}"${priceMsg} and notify you when I find great deals!`
                });
            }
        }

        // Check if AI wants to search
        if (aiResponse.includes('SEARCH:')) {
            const searchQuery = aiResponse.split('SEARCH:')[1].trim();
            const displayMessage = aiResponse.split('SEARCH:')[0].trim();

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
                    deals: deals.slice(0, 3), // Return only top 3 deals
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

// Send email notification for found deals
async function sendDealEmail(user, searchParty, deals) {
    if (!transporter) {
        console.log('Email service not configured, skipping notification');
        return false;
    }

    try {
        const dealsList = deals.map((deal, index) => `
            <div style="background: #f9f9f9; padding: 15px; margin: 10px 0; border-radius: 8px; border-left: 4px solid #4CAF50;">
                <h3 style="margin: 0 0 10px 0; color: #333;">${index + 1}. ${deal.title}</h3>
                <p style="margin: 5px 0; font-size: 24px; color: #4CAF50; font-weight: bold;">${deal.price.toFixed(2)}</p>
                <p style="margin: 5px 0; color: #666;">
                    <strong>Store:</strong> ${deal.source}<br>
                    ${deal.rating !== 'N/A' ? `<strong>Rating:</strong> ${deal.rating} (${deal.reviews} reviews)<br>` : ''}
                </p>
                <a href="${deal.link}" style="display: inline-block; margin-top: 10px; padding: 10px 20px; background: #4CAF50; color: white; text-decoration: none; border-radius: 5px;">View Deal</a>
            </div>
        `).join('');

        const priceFilter = searchParty.maxPrice ? `<p><strong>Max Price:</strong> ${searchParty.maxPrice}</p>` : '';
        const preferences = searchParty.preferences ? `<p><strong>Preferences:</strong> ${searchParty.preferences}</p>` : '';

        const mailOptions = {
            from: `"Son of Anton 🛍️" <${EMAIL_USER}>`,
            to: user.email,
            subject: `🎉 Great Deals Found for "${searchParty.itemName}"!`,
            html: `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                </head>
                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                        <h1 style="color: white; margin: 0; font-size: 28px;">🎉 Search Party Alert!</h1>
                    </div>
                    
                    <div style="background: white; padding: 30px; border: 1px solid #ddd; border-top: none; border-radius: 0 0 10px 10px;">
                        <p style="font-size: 18px; color: #333;">Hey ${user.username}! 👋</p>
                        
                        <p>Great news! I found some amazing deals for <strong>"${searchParty.itemName}"</strong> that match your search party criteria!</p>
                        
                        <div style="background: #f0f0f0; padding: 15px; border-radius: 8px; margin: 20px 0;">
                            <h3 style="margin: 0 0 10px 0; color: #667eea;">Your Search Party Details:</h3>
                            <p style="margin: 5px 0;"><strong>Item:</strong> ${searchParty.itemName}</p>
                            ${priceFilter}
                            ${preferences}
                        </div>

                        <h2 style="color: #667eea; border-bottom: 2px solid #667eea; padding-bottom: 10px;">Top Deals Found:</h2>
                        
                        ${dealsList}

                        <div style="margin-top: 30px; padding: 20px; background: #fff3cd; border-radius: 8px; border-left: 4px solid #ffc107;">
                            <p style="margin: 0; color: #856404;">
                                <strong>💡 Pro Tip:</strong> Prices can change quickly! Click the links above to grab these deals before they're gone.
                            </p>
                        </div>

                        <div style="margin-top: 30px; text-align: center; padding-top: 20px; border-top: 1px solid #ddd;">
                            <p style="color: #666; font-size: 14px;">
                                This email was sent by your Son of Anton Search Party<br>
                                You're receiving this because you set up an active search party for this item.
                            </p>
                        </div>
                    </div>
                    
                    <div style="text-align: center; margin-top: 20px; color: #999; font-size: 12px;">
                        <p>Happy Shopping! 🛍️</p>
                    </div>
                </body>
                </html>
            `
        };

        await transporter.sendMail(mailOptions);
        console.log(`✅ Email sent to ${user.email} for "${searchParty.itemName}"`);
        return true;
    } catch (error) {
        console.error('Email sending error:', error);
        return false;
    }
}

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

        const priceStr = item.price.replace(/[$,]/g, '');
        const price = parseFloat(priceStr);

        if (isNaN(price)) continue;

        validResults.push({
            title: item.title || 'Unknown',
            price: price,
            source: item.source || 'Unknown',
            link: item.link || '#',
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
    res.json({ status: 'ok', message: 'Son of Anton API is running!' });
});

// Search Party Cron Job (run this separately or integrate with a cron service)
async function runSearchParties() {
    try {
        console.log('🕒 CRON JOB: Starting Search Party execution...');
        
        const activeParties = await SearchParty.find({ isActive: true });
        
        console.log(`🔍 CRON JOB: Found ${activeParties.length} active search parties`);
        
        // Log all active search parties
        if (activeParties.length > 0) {
            console.log('📋 ACTIVE SEARCH PARTIES:');
            activeParties.forEach((party, index) => {
                console.log(`   ${index + 1}. "${party.itemName}" - User: ${party.userId} - Max Price: ${party.maxPrice || 'None'} - Last Searched: ${party.lastSearched}`);
            });
        } else {
            console.log('   No active search parties found');
        }
        
        for (const party of activeParties) {
            // Only search once per day
            const timeSinceLastSearch = Date.now() - party.lastSearched.getTime();
            const oneDayInMs = 24 * 60 * 60 * 1000;
            
            if (timeSinceLastSearch < oneDayInMs) {
                console.log(`⏭️  Skipping "${party.itemName}" - searched ${Math.round(timeSinceLastSearch / (60 * 60 * 1000))} hours ago (less than 24 hours)`);
                continue;
            }

            console.log(`🔎 Searching for: "${party.itemName}" (User: ${party.userId})`);
            
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
                    
                    if (user) {
                        // Send email notification
                        const emailSent = await sendDealEmail(user, party, filteredDeals.slice(0, 3));
                        
                        if (emailSent) {
                            console.log(`📧 Email notification sent to ${user.email}`);
                        } else {
                            console.log(`❌ Failed to send email to ${user.email}`);
                        }
                    } else {
                        console.log(`❌ User not found for ID: ${party.userId}`);
                    }

                    // Add new results to database
                    const newResults = filteredDeals.slice(0, 3).map(deal => ({
                        ...deal,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Son of Anton API running on port ${PORT}`);
    console.log(`📡 Endpoints:`);
    console.log(`   POST /api/register - Create account`);
    console.log(`   POST /api/login - Login`);
    console.log(`   POST /api/chat - Send messages`);
    console.log(`   GET /api/conversations - Get conversation history`);
    console.log(`   GET /api/search-parties - Get search parties`);
    console.log(`   PUT /api/search-parties/:id/toggle - Toggle search party`);
    console.log(`   POST /api/reset - Reset conversation`);
    console.log(`   GET /api/health - Health check`);
});

// Run search parties every hour (in production, use a proper cron job)
const CRON_INTERVAL = 60 * 60 * 1000; // 1 hour
console.log(`⏰ Setting up Search Party cron job to run every ${CRON_INTERVAL / (60 * 1000)} minutes`);

setInterval(() => {
    console.log(`\n🔄 CRON JOB: Scheduled Search Party execution started at ${new Date().toISOString()}`);
    runSearchParties();
}, CRON_INTERVAL);

// Run immediately on startup to show current state
setTimeout(() => {
    console.log(`\n🚀 INITIAL CRON JOB: Running initial Search Party check at ${new Date().toISOString()}`);
    runSearchParties();
}, 5000);