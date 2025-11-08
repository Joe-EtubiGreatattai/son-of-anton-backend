const axios = require('axios');

const googleApiKey = 'AIzaSyADRG85rWWBqhKUBT9mOkrEZ8B8C4bBgc4';

async function listModels() {
    try {
        console.log('🔍 Fetching available models...\n');
        
        const response = await axios.get(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${googleApiKey}`
        );

        const models = response.data.models;
        
        console.log(`✅ Found ${models.length} models:\n`);
        
        models.forEach((model, index) => {
            console.log(`${index + 1}. ${model.name}`);
            console.log(`   Display Name: ${model.displayName}`);
            console.log(`   Description: ${model.description}`);
            console.log(`   Supported Methods: ${model.supportedGenerationMethods.join(', ')}`);
            console.log();
        });

        // Filter models that support generateContent
        const generateContentModels = models.filter(m => 
            m.supportedGenerationMethods.includes('generateContent')
        );

        console.log('\n🎯 Models that support generateContent:');
        generateContentModels.forEach(model => {
            console.log(`   • ${model.name}`);
        });

    } catch (error) {
        console.log('❌ Error:', error.response?.data?.error?.message || error.message);
    }
}

listModels();