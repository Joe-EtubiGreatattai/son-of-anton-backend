require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Load API keys from environment variables
const SERP_API_KEY = process.env.SERP_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const SERP_BASE_URL = 'https://serpapi.com/search';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// Validate required environment variables
if (!SERP_API_KEY) {
    console.error('❌ ERROR: SERP_API_KEY is not set in environment variables');
    process.exit(1);
}

if (!GOOGLE_API_KEY) {
    console.error('❌ ERROR: GOOGLE_API_KEY is not set in environment variables');
    process.exit(1);
}

// Store conversation histories per session
const sessions = new Map();

const SYSTEM_PROMPT = `You are "Son of Anton" - a super friendly, upbeat, and enthusiastic shopping assistant with tons of personality! 

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
- [Link text](url) for clickable links (though you rarely need this)

Examples of good formatting:
"Hey there! 🎉 I'd love to help you find the **perfect phone**!

Let me ask you a few quick questions:
- What's your budget range?
- Do you prefer iPhone or Android?
- Any must-have features?

Once I know these, I can find you the **best deals**!"

IMPORTANT SEARCH RULES:
1. NEVER search immediately when someone mentions a product vaguely
2. ALWAYS ask clarifying questions first to get specific details:
   - What brand or model are they interested in?
   - What's their budget range?
   - What features are most important to them?
   - Any specific requirements (color, size, specs)?
3. Only respond with "SEARCH: [detailed query]" when you have enough specific information
4. After getting search results, analyze them and recommend THE BEST ONE based on:
   - Best value for money (not just cheapest)
   - Good ratings and reviews
   - Reliable store/seller
   - User's stated preferences

RESPONSE FORMATS:
- Normal conversation: Chat naturally with nice formatting
- When ready to search: "SEARCH: [specific product with details]"
- After seeing results: "RECOMMEND: [result number]|[reason with formatting]"

Remember: You're Son of Anton - friendly, helpful, and always making your responses look nice and easy to read!`;

// Chat endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const { message, sessionId } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        // Get or create session
        const session = sessionId || Date.now().toString();
        if (!sessions.has(session)) {
            sessions.set(session, []);
        }

        const conversationHistory = sessions.get(session);

        // Add user message to history
        conversationHistory.push({
            role: 'user',
            parts: [{ text: message }]
        });

        // Call Gemini API
        const response = await axios.post(
            `${GEMINI_URL}?key=${GOOGLE_API_KEY}`,
            {
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: SYSTEM_PROMPT }]
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
        
        // Add AI response to history
        conversationHistory.push({
            role: 'model',
            parts: [{ text: aiResponse }]
        });

        // Check if AI wants to search
        if (aiResponse.includes('SEARCH:')) {
            const searchQuery = aiResponse.split('SEARCH:')[1].trim();
            const displayMessage = aiResponse.split('SEARCH:')[0].trim();

            // Perform search
            const searchResults = await searchItem(searchQuery);
            const { deals, totalValid } = findBestDeals(searchResults);

            if (deals && deals.length > 0) {
                const recommendation = await getAIRecommendation(deals, searchQuery);
                const recommendationData = parseRecommendation(recommendation, deals);

                return res.json({
                    sessionId: session,
                    type: 'recommendation',
                    message: formatDisplayMessage(displayMessage),
                    searchQuery,
                    deals,
                    recommendation: recommendationData
                });
            } else {
                return res.json({
                    sessionId: session,
                    type: 'message',
                    message: "Hmm, couldn't find any deals for that. 🤔\n\nWant to try a different search or adjust your requirements?"
                });
            }
        }

        // Regular response - keep the formatting
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

    if (shoppingResults.length === 0) {
        return { deals: null, totalValid: null };
    }

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

// Get AI recommendation
async function getAIRecommendation(deals, searchQuery) {
    const dealsText = deals.map((deal, index) => 
        `${index + 1}. ${deal.title} - $${deal.price.toFixed(2)} from ${deal.source}${deal.rating !== 'N/A' ? ` (Rating: ${deal.rating}, ${deal.reviews} reviews)` : ''}`
    ).join('\n');

    const recommendPrompt = `Based on these search results for "${searchQuery}", recommend THE BEST SINGLE OPTION and explain why in a friendly, formatted way.

${dealsText}

Consider: value for money (not just cheapest), ratings, reviews, and store reliability.

Format your response with:
- **Bold** for the key reasons
- Bullet points if listing multiple benefits
- Keep it enthusiastic and conversational

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
        // Clean up excessive asterisks
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
app.post('/api/reset', (req, res) => {
    const { sessionId } = req.body;
    if (sessionId && sessions.has(sessionId)) {
        sessions.delete(sessionId);
    }
    res.json({ message: 'Session reset successfully' });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Son of Anton API is running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Son of Anton API running on port ${PORT}`);
    console.log(`📡 Endpoints:`);
    console.log(`   POST /api/chat - Send messages`);
    console.log(`   POST /api/reset - Reset conversation`);
    console.log(`   GET /api/health - Health check`);
});