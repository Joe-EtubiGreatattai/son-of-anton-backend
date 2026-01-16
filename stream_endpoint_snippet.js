
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
                }
            }
        } catch (err) {
            console.error("Local search stream error", err);
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
