require('dotenv').config();
const { sendDealEmail } = require('./email-utils');

const user = {
    username: 'Great Attai',
    email: 'greatattai442@gmail.com'
};

const searchParty = {
    itemName: 'Test Search Party Item',
    maxPrice: 1000,
    preferences: 'Fast shipping, good condition'
};

const deals = [
    {
        title: 'Test Deal: MacBook Pro 14"',
        price: 999.00,
        source: 'Amazon',
        link: 'https://amazon.com',
        image: 'https://m.media-amazon.com/images/I/618d5bS2lUL._AC_SL1500_.jpg',
        rating: '4.8',
        reviews: '1250'
    },
    {
        title: 'Test Deal: Sony WH-1000XM5',
        price: 348.00,
        source: 'Best Buy',
        link: 'https://bestbuy.com',
        image: 'https://m.media-amazon.com/images/I/51SKmu2G9FL._AC_SL1000_.jpg',
        rating: '4.7',
        reviews: '850'
    }
];

async function runTest() {
    console.log(`Attempting to send test email to ${user.email}...`);
    try {
        const success = await sendDealEmail(user, searchParty, deals);
        if (success) {
            console.log('✅ Test email sent successfully!');
        } else {
            console.error('❌ Failed to send test email.');
            process.exit(1);
        }
    } catch (error) {
        console.error('❌ Error during test:', error);
        process.exit(1);
    }
}

runTest();
