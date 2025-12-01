// Test script to verify exchange rate cron job implementation
require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/chat_app';

// Exchange Rate Schema
const exchangeRateSchema = new mongoose.Schema({
    baseCurrency: { type: String, required: true, unique: true, default: 'USD' },
    rates: { type: Map, of: Number, required: true },
    lastUpdated: { type: Date, default: Date.now }
});

const ExchangeRate = mongoose.model('ExchangeRate', exchangeRateSchema);

async function testExchangeRates() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(MONGO_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('✅ MongoDB connected');

        // Check if exchange rates exist in database
        const exchangeRateDoc = await ExchangeRate.findOne({ baseCurrency: 'USD' });

        if (exchangeRateDoc) {
            console.log('✅ Exchange rates found in database!');
            console.log('Last updated:', exchangeRateDoc.lastUpdated);
            console.log('Sample rates:');
            const rates = Object.fromEntries(exchangeRateDoc.rates);
            console.log('  USD to NGN:', rates.NGN);
            console.log('  USD to EUR:', rates.EUR);
            console.log('  USD to GBP:', rates.GBP);
            console.log('\nTotal currencies available:', Object.keys(rates).length);
        } else {
            console.log('❌ No exchange rates found in database.');
            console.log('The cron job should fetch them on server startup.');
        }

        await mongoose.connection.close();
        console.log('\n✅ Test completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

testExchangeRates();
