// test-email.js
require('dotenv').config();

async function sendTestEmail() {
    // Import from the dedicated email utils module
    const { sendDealEmail, transporter } = require('./email-utils');

    // Check if email credentials are available in environment
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.error('❌ Email credentials not found in environment variables');
        console.log('Please set EMAIL_USER and EMAIL_PASS in your .env file');
        return false;
    }

    // Check if transporter is configured
    if (!transporter) {
        console.error('❌ Email transporter not configured');
        console.log('Please check your email configuration');
        return false;
    }

    // Create test data
    const testUser = {
        username: 'Test User',
        email: process.env.EMAIL_USER,
        _id: 'test-user-id-123'
    };

    const testSearchParty = {
        itemName: 'Test Product - Gaming Laptop',
        searchQuery: 'gaming laptop test',
        maxPrice: 1500,
        preferences: 'RGB lighting, good cooling system',
        _id: 'test-search-party-456'
    };

    const testDeals = [
        {
            title: 'ASUS ROG Strix Gaming Laptop - Test Deal',
            price: 1299.99,
            source: 'Amazon',
            link: 'https://amazon.com/test-laptop',
            rating: '4.5',
            reviews: '1,234'
        },
        {
            title: 'MSI Pulse Gaming Laptop - Test Deal',
            price: 1399.99,
            source: 'Best Buy',
            link: 'https://bestbuy.com/test-laptop',
            rating: '4.3',
            reviews: '890'
        }
    ];

    console.log('📧 Attempting to send test email...');
    console.log(`From: ${process.env.EMAIL_USER}`);
    console.log(`To: ${testUser.email}`);
    console.log(`Service: ${process.env.EMAIL_SERVICE || 'gmail'}`);

    try {
        const result = await sendDealEmail(testUser, testSearchParty, testDeals);
        
        if (result) {
            console.log('✅ Test email sent successfully!');
        } else {
            console.log('❌ Email sending failed');
        }
        
        return result;
    } catch (error) {
        console.error('❌ Failed to send test email:', error.message);
        
        if (error.code === 'EAUTH') {
            console.log('\n🔐 Authentication failed. Please check your email credentials');
        }
        
        throw error;
    }
}

// Run the test if this file is executed directly
if (require.main === module) {
    console.log('🧪 Testing email functionality...\n');
    
    sendTestEmail()
        .then(success => {
            if (success) {
                console.log('\n🎯 Test completed successfully!');
                process.exit(0);
            } else {
                console.log('\n💥 Test failed');
                process.exit(1);
            }
        })
        .catch(error => {
            console.log('\n💥 Test failed with error!');
            process.exit(1);
        });
}

module.exports = { sendTestEmail };