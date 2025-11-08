const axios = require('axios');
const readline = require('readline');

class DealFinderBot {
    constructor(serpApiKey, googleApiKey) {
        this.serpApiKey = serpApiKey;
        this.googleApiKey = googleApiKey;
        this.baseUrl = 'https://serpapi.com/search';
        this.geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
        this.conversationHistory = [];
    }

    async chat(userMessage) {
        const systemPrompt = `You are "Son of Anton" - a super friendly, upbeat, and enthusiastic shopping assistant with tons of personality! 

YOUR PERSONALITY:
- You're excited about helping people find great deals! Use emojis and exclamation marks!
- You're very friendly and chatty - like talking to an enthusiastic best friend
- You ask follow-up questions to understand EXACTLY what the user needs before searching
- You're knowledgeable and give personalized recommendations
- Keep responses SHORT and conversational - 2-3 sentences max unless providing detailed options

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
- Normal conversation: Just chat naturally and ask questions
- When ready to search: "SEARCH: [specific product with details]"
- After seeing results: "RECOMMEND: [result number]|[reason why this is the best choice]"

Examples:
User: "I need a phone"
You: "Awesome! I'd love to help you find the perfect phone! 🎉 What kind of phone are you looking for? iPhone or Android? And what's your budget looking like? Any specific features you really need?"

User: "An iPhone, around $800, good camera"
You: "SEARCH: iPhone good camera under 800"

Remember: You're Son of Anton - friendly, helpful, and always making sure you understand what people need before searching!`;

        this.conversationHistory.push({
            role: 'user',
            parts: [{ text: userMessage }]
        });

        try {
            const response = await axios.post(
                `${this.geminiUrl}?key=${this.googleApiKey}`,
                {
                    contents: [
                        {
                            role: 'user',
                            parts: [{ text: systemPrompt }]
                        },
                        ...this.conversationHistory
                    ]
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            const aiResponse = response.data.candidates[0].content.parts[0].text;
            
            this.conversationHistory.push({
                role: 'model',
                parts: [{ text: aiResponse }]
            });

            return aiResponse;
        } catch (error) {
            console.log(`Error with AI: ${error.response?.data?.error?.message || error.message}`);
            return null;
        }
    }

    async searchItem(itemName) {
        try {
            const response = await axios.get(this.baseUrl, {
                params: {
                    q: itemName,
                    api_key: this.serpApiKey,
                    engine: 'google_shopping',
                    num: 10
                }
            });
            return response.data;
        } catch (error) {
            console.log(`Error fetching results: ${error.message}`);
            return null;
        }
    }

    findBestDeals(results) {
        if (!results || !results.shopping_results) {
            return { deals: null, totalValid: null };
        }

        const shoppingResults = results.shopping_results;

        console.log('\n📊 Processing Results:');
        console.log(`   Total results received: ${shoppingResults.length}`);

        if (shoppingResults.length === 0) {
            return { deals: null, totalValid: null };
        }

        const validResults = [];
        let skippedNoPrice = 0;
        let skippedInvalidPrice = 0;

        for (const item of shoppingResults) {
            if (!item.price) {
                skippedNoPrice++;
                continue;
            }

            const priceStr = item.price.replace(/[$,]/g, '');
            const price = parseFloat(priceStr);

            if (isNaN(price)) {
                skippedInvalidPrice++;
                continue;
            }

            validResults.push({
                title: item.title || 'Unknown',
                price: price,
                source: item.source || 'Unknown',
                link: item.link || '#',
                rating: item.rating || 'N/A',
                reviews: item.reviews || 'N/A'
            });
        }

        console.log(`   ✓ Valid results with prices: ${validResults.length}`);
        console.log(`   ✗ Skipped (no price): ${skippedNoPrice}`);
        console.log(`   ✗ Skipped (invalid price format): ${skippedInvalidPrice}`);

        if (validResults.length === 0) {
            return { deals: null, totalValid: null };
        }

        // Sort by price (lowest first)
        validResults.sort((a, b) => a.price - b.price);

        console.log('\n🎯 Selection Criteria:');
        console.log('   • Sorted by: Lowest price first');
        console.log(`   • Price range found: $${validResults[0].price.toFixed(2)} - $${validResults[validResults.length - 1].price.toFixed(2)}`);
        console.log(`   • Found ${validResults.length} valid options`);

        return {
            deals: validResults.slice(0, 10),
            totalValid: validResults.length
        };
    }

    async getAIRecommendation(deals, searchQuery) {
        const dealsText = deals.map((deal, index) => 
            `${index + 1}. ${deal.title} - $${deal.price.toFixed(2)} from ${deal.source}${deal.rating !== 'N/A' ? ` (Rating: ${deal.rating}, ${deal.reviews} reviews)` : ''}`
        ).join('\n');

        const recommendPrompt = `Based on these search results for "${searchQuery}", recommend THE BEST SINGLE OPTION and explain why:

${dealsText}

Consider: value for money (not just cheapest), ratings, reviews, and store reliability.
Respond with: RECOMMEND: [number]|[enthusiastic explanation of why this is the best choice]`;

        try {
            const response = await axios.post(
                `${this.geminiUrl}?key=${this.googleApiKey}`,
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

            return response.data.candidates[0].content.parts[0].text;
        } catch (error) {
            console.log(`Error getting recommendation: ${error.message}`);
            return null;
        }
    }

    displayRecommendation(recommendation, deals, searchQuery) {
        console.log('\n' + '='.repeat(70));
        console.log(`🎯 SON OF ANTON'S RECOMMENDATION FOR: ${searchQuery.toUpperCase()}`);
        console.log('='.repeat(70));

        if (!recommendation || !recommendation.includes('RECOMMEND:')) {
            console.log('\n🤔 Hmm, having trouble making a recommendation. Here are the top options:\n');
            deals.slice(0, 3).forEach((deal, index) => {
                console.log(`${index + 1}. 💰 $${deal.price.toFixed(2)}`);
                console.log(`   📦 ${deal.title.substring(0, 60)}...`);
                console.log(`   🏪 ${deal.source}`);
                console.log();
            });
            return;
        }

        const parts = recommendation.split('RECOMMEND:')[1].split('|');
        const recommendedIndex = parseInt(parts[0].trim()) - 1;
        const reason = parts[1]?.trim() || 'This is the best option!';

        if (recommendedIndex >= 0 && recommendedIndex < deals.length) {
            const deal = deals[recommendedIndex];
            
            console.log(`\n✨ ${reason}\n`);
            console.log('📦 HERE\'S YOUR BEST MATCH:');
            console.log('─'.repeat(70));
            console.log(`💰 Price: $${deal.price.toFixed(2)}`);
            console.log(`📱 Product: ${deal.title}`);
            console.log(`🏪 Store: ${deal.source}`);
            if (deal.rating !== 'N/A') {
                console.log(`⭐ Rating: ${deal.rating} (${deal.reviews} reviews)`);
            }
            console.log(`🔗 Link: ${deal.link}`);
            console.log('─'.repeat(70));
        }
    }
}

async function main() {
    console.log('💬 Hi! I\'m Son of Anton. What are you shopping for today? (Type \'quit\' to exit)\n');

    // API keys
    const serpApiKey = '6b8f496d91f4c52df9999f724c0756f87c63fb840bdf4a50a5a71337641215ce';
    const googleApiKey = 'AIzaSyADRG85rWWBqhKUBT9mOkrEZ8B8C4bBgc4';

    const bot = new DealFinderBot(serpApiKey, googleApiKey);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const askQuestion = () => {
        rl.question('💬 You: ', async (input) => {
            input = input.trim();

            if (['quit', 'exit', 'q'].includes(input.toLowerCase())) {
                console.log('\n👋 Thanks for stopping by! Happy shopping! 🛍️');
                rl.close();
                return;
            }

            if (!input) {
                console.log('⚠️  Hey! Say something! I\'m here to help! 😊\n');
                askQuestion();
                return;
            }

            console.log('');

            const aiResponse = await bot.chat(input);

            if (!aiResponse) {
                console.log('❌ Oops! I had a little hiccup. Can you say that again? 😅\n');
                askQuestion();
                return;
            }

            // Check if AI wants to perform a search
            if (aiResponse.includes('SEARCH:')) {
                const searchQuery = aiResponse.split('SEARCH:')[1].trim();
                
                // Show the AI's message without the SEARCH command
                const displayMessage = aiResponse.split('SEARCH:')[0].trim();
                if (displayMessage) {
                    console.log(`🤖 Son of Anton: ${displayMessage.replace(/\*\*/g, '')}\n`);
                }
                
                console.log(`🔎 Searching for '${searchQuery}'...`);

                const results = await bot.searchItem(searchQuery);
                const { deals, totalValid } = bot.findBestDeals(results);
                
                if (deals && deals.length > 0) {
                    const recommendation = await bot.getAIRecommendation(deals, searchQuery);
                    bot.displayRecommendation(recommendation, deals, searchQuery);
                } else {
                    console.log('\n❌ Couldn\'t find any deals for that. Want to try something else? 🤔');
                }
            } else {
                console.log(`🤖 Son of Anton: ${aiResponse.replace(/\*\*/g, '')}\n`);
            }

            console.log('\n' + '-'.repeat(70) + '\n');
            askQuestion();
        });
    };

    askQuestion();
}

main();