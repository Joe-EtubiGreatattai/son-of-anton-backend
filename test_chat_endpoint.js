const axios = require('axios');

const API_URL = 'https://son-of-anton-backend-1n0j.onrender.com/api/chat';

async function testChatEndpoint() {
    console.log('Testing /api/chat endpoint...\n');

    const testPayload = {
        message: 'Hello, can you help me find a laptop?',
        searchQuery: '',
        sessionId: 'test-session-' + Date.now()
    };

    try {
        console.log('Sending request to:', API_URL);
        console.log('Payload:', JSON.stringify(testPayload, null, 2));
        console.log('\nWaiting for response...\n');

        const response = await axios.post(API_URL, testPayload, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        console.log('✅ SUCCESS!');
        console.log('Status:', response.status);
        console.log('Response:', JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('❌ ERROR!');

        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Error data:', JSON.stringify(error.response.data, null, 2));
            console.error('Headers:', JSON.stringify(error.response.headers, null, 2));
        } else if (error.request) {
            console.error('No response received');
            console.error('Request:', error.request);
        } else {
            console.error('Error message:', error.message);
        }

        console.error('\nFull error:', error);
        process.exit(1);
    }
}

testChatEndpoint();
