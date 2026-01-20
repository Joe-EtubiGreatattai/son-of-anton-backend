const axios = require('axios');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/gemini-2.5-pro';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1/${GEMINI_MODEL}:generateContent`;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

if (!GOOGLE_API_KEY) {
    console.error('❌ WARNING: GOOGLE_API_KEY is not defined in environment variables!');
} else {
    console.log(`🤖 AI Service initialized with model: ${GEMINI_MODEL}`);
}

/**
 * Call Gemini API with a prompt and optional image
 */
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

/**
 * Build user preferences prompt for AI
 */
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

/**
 * Build search preferences prompt for AI
 */
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

/**
 * Generate AI prompt
 */
function generateAIPrompt(userMessage, searchQuery, user, messageHistory, platform = 'web') {
    // WhatsApp-specific prompt: Focus on notifications, redirect searches to web
    if (platform === 'whatsapp') {
        const whatsappPrompt = `
You are **Son of Anton** on WhatsApp, a friendly notification assistant.

**Your Role on WhatsApp:**
- You send notifications about product availability, price drops, and deals
- You respond warmly to greetings and basic questions
- You are NOT a shopping assistant on WhatsApp - that's for the web app!

**CRITICAL RULE:**
When a user asks about products or wants to search for something, respond like this:

"Hey there! 👋 I'd love to help you find that! For the best shopping experience with real-time search, product comparisons, and awesome deals, please visit our web app at:

🔗 **https://www.sonofanton.live/**

I'll stay here on WhatsApp to send you notifications about great deals and product updates! 📱✨"

**EXAMPLES:**
User: "I need a new phone"
You: "Hey there! 👋 I'd love to help you find that phone! For the best shopping experience with real-time search and comparisons, please visit our web app at:

🔗 **https://www.sonofanton.live/**

I'll be here to notify you about amazing phone deals when they pop up! 📱✨"

User: "hello"
You: "Hi! 👋 Great to see you here on WhatsApp! I'm Son of Anton, your shopping notification assistant. I'll keep you updated on amazing deals! 

If you want to search for products right now, head over to **https://www.sonofanton.live/** for the full experience! 🛍️"

User: "thanks"
You: "You're very welcome! 😊 Happy shopping! Remember, visit **https://www.sonofanton.live/** anytime! ✨"

**Conversation history:**
${(messageHistory || []).map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n')}

**Current user message:**
User: ${userMessage}

Remember: Always be friendly and redirect shopping queries to the web app!
`;
        return whatsappPrompt;
    }

    // Original web-based prompt for the web application
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
3) IMMEDIATELY add a new line starting with: CATEGORY: <category> (Choose from: gadget, fashion, food, decor, beauty, auto, other)

RESPONSE FORMAT (If Casual Chat):
1) Just respond conversationally.
2) Do NOT include "SEARCH:" or "CATEGORY:".

SEARCH FORMAT:
- SEARCH: simple product keywords
- Be concise (2-5 words)
- CATEGORY: Choose the best fit from: gadget, fashion, food, decor, beauty, auto, other.

CATEGORIZATION RULES:
- gadget: Phones, laptops, electronics, appliances, accessories.
- fashion: Clothes, shoes, bags, jewelry, sneakers, watches (if luxury/style).
- food: Groceries, snacks, drinks.
- decor: Furniture, home items, rugs.
- beauty: Skincare, makeup, perfume.
- auto: Car parts, accessories.
- other: Anything else.

EXAMPLES:
User: "help me find a rolex"
Response: I'll find the best Rolex watches for you!
SEARCH: rolex watches
CATEGORY: fashion

User: "I need new sneakers"
Response: Let me search for some cool sneakers for you! 👟
SEARCH: popular sneakers
CATEGORY: fashion

User: "iphone 13 pro"
Response: I'll check the best prices for iPhone 13 Pro!
SEARCH: iphone 13 pro
CATEGORY: gadget

User: "I want a blender"
Response: I'll find some high-quality blenders for you!
SEARCH: kitchen blender
CATEGORY: gadget

IMPORTANT RULES:
- ALWAYS include CATEGORY: if you include SEARCH:.
- If user mentions sneakers, dresses, or shirts, use CATEGORY: fashion.
- If user mentions phones, laptops, or electronics, use CATEGORY: gadget.
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

/**
 * Function to detect category using AI
 */
async function detectCategoryWithAI(query) {
    try {
        console.log(`🤖 Asking AI to categorize: "${query}"`);
        const prompt = `Classify this shopping query into exactly one of these categories: gadget, fashion, food, decor, beauty, auto, other.
Current Query: "${query}"

Return ONLY the category name. No other text.`;

        const response = await callGeminiAPI(prompt);
        const category = response.toLowerCase().trim().replace(/[^\w]/g, '');

        const validCategories = ['gadget', 'fashion', 'food', 'decor', 'beauty', 'auto', 'other'];
        if (validCategories.includes(category)) {
            return category;
        }

        // Contextual fallback
        if (category.includes('gadget') || category.includes('tech') || category.includes('electronic')) return 'gadget';
        if (category.includes('fashion') || category.includes('cloth') || category.includes('wear') || category.includes('shoe')) return 'fashion';

        return 'other';
    } catch (e) {
        console.error('AI Category detection failed:', e.message);
        return 'other';
    }
}

/**
 * Format AI Display Message
 */
function formatDisplayMessage(message) {
    if (!message || message.trim() === '') {
        return "Let me search for that! 🔍";
    }
    return message;
}

/**
 * Use AI to rank/filter results based on relevance to the search query.
 * This helps filter out accessories (like cases) when searching for devices.
 */
async function rankResultsWithAI(searchQuery, results) {
    if (!results || results.length === 0) return [];

    const itemsText = results.map((item, index) => `${index}: ${item.title}`).join('\n');

    const prompt = `
You are a highly analytical shopping relevance evaluator.
The user's EXACT search intent is: "${searchQuery}"

Here is a list of product results received from multiple stores:
${itemsText}

TASK: 
Determine which items are a direct match for the user's intent.

STRICT FILTERING RULES:
1. NO ACCESSORIES: If the user searches for a main device (e.g., iPhone, AirPods, PlayStation), and the result is an accessory (case, cover, screen guard, charger, cable, strap, etc.), it MUST be marked as NOT RELEVANT.
2. VERSION MATCHING: If the user specified a version (e.g., "iPhone 15"), any results for earlier versions (e.g., "iPhone 11") are NOT RELEVANT.
3. ITEM TYPE: If the user searches for a specific item, different types (e.g., "iPhone 15" results in "MacBook" or "Apple Watch") are NOT RELEVANT.

OUTPUT:
Return ONLY a JSON array of indices for items that are HIGHLY RELEVANT and DIRECT MATCHES.
Example: [0, 1, 4]

Return ONLY the JSON array.`;

    try {
        const aiResponse = await callGeminiAPI(prompt);
        const match = aiResponse.match(/\[.*\]/);
        if (match) {
            const relevantIndices = JSON.parse(match[0]);
            console.log(`🤖 AI Filter: Kept ${relevantIndices.length}/${results.length} items for query "${searchQuery}"`);
            return results.filter((_, index) => relevantIndices.includes(index));
        }
        return results; // Fallback if AI response is weird
    } catch (error) {
        console.error('AI ranking error:', error);
        return results; // Fallback on error
    }
}

module.exports = {
    callGeminiAPI,
    generateAIPrompt,
    buildUserPreferencesPrompt,
    buildSearchPreferencesPrompt,
    detectCategoryWithAI,
    formatDisplayMessage,
    rankResultsWithAI
};
