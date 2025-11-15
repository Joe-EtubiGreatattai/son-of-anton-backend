// test-email.js
require('dotenv').config();

async function sendTestEmail() {
    // Import from the dedicated email utils module
    const { sendDealEmail, transporter } = require('./email-utils');

    const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
    const EMAIL_USER = process.env.EMAIL_USER;
    const EMAIL_PASS = process.env.EMAIL_PASS;

    // Check if any email service is configured
    if (!SENDGRID_API_KEY && (!EMAIL_USER || !EMAIL_PASS)) {
        console.error('❌ No email service configured');
        console.log('Please set either:');
        console.log('  - SENDGRID_API_KEY for SendGrid (recommended)');
        console.log('  - EMAIL_USER and EMAIL_PASS for SMTP fallback');
        return false;
    }

    // Determine which service will be used
    const usingService = SENDGRID_API_KEY ? 'SendGrid' : 'SMTP';
    console.log(`📧 Using ${usingService} for email delivery\n`);

    // Create test data
    const testUser = {
        username: 'Test User',
        email: process.env.TEST_EMAIL_RECIPIENT || EMAIL_USER || 'test@example.com',
        _id: 'test-user-id-123'
    };

    const testSearchParty = {
        itemName: 'Gaming Laptop',
        searchQuery: 'gaming laptop',
        maxPrice: 1500,
        preferences: 'RTX 4070, 16GB RAM, good cooling system',
        _id: 'test-search-party-456'
    };

    const testDeals = [
        {
            title: 'ASUS ROG Strix G16 Gaming Laptop - RTX 4070',
            price: 1299.99,
            source: 'Amazon',
            link: 'https://amazon.com/asus-rog-strix',
            image: 'https://via.placeholder.com/300x200/667eea/ffffff?text=ASUS+ROG',
            rating: '4.5',
            reviews: '1,234'
        },
        {
            title: 'MSI Pulse 17 Gaming Laptop - RTX 4070',
            price: 1399.99,
            source: 'Best Buy',
            link: 'https://bestbuy.com/msi-pulse',
            image: 'https://via.placeholder.com/300x200/764ba2/ffffff?text=MSI+Pulse',
            rating: '4.3',
            reviews: '890'
        },
        {
            title: 'Lenovo Legion Pro 5i Gaming Laptop',
            price: 1449.99,
            source: 'Newegg',
            link: 'https://newegg.com/lenovo-legion',
            image: 'https://via.placeholder.com/300x200/059669/ffffff?text=Lenovo',
            rating: '4.7',
            reviews: '2,156'
        }
    ];

    console.log('📧 Attempting to send test email...');
    console.log(`From: ${process.env.SENDGRID_FROM_EMAIL || EMAIL_USER || 'no-reply@example.com'}`);
    console.log(`To: ${testUser.email}`);
    
    if (!SENDGRID_API_KEY) {
        console.log(`Service: ${process.env.EMAIL_SERVICE || 'gmail'}`);
    }
    console.log('');

    try {
        const result = await sendDealEmail(testUser, testSearchParty, testDeals);
        
        if (result) {
            console.log('✅ Test email sent successfully!');
            console.log(`\n📬 Check ${testUser.email} for the test email`);
        } else {
            console.log('❌ Email sending failed');
            console.log('Check the logs above for details');
        }
        
        return result;
    } catch (error) {
        console.error('❌ Failed to send test email:', error.message);
        
        if (error.code === 'EAUTH') {
            console.log('\n🔐 Authentication failed. Please check your email credentials');
            if (!SENDGRID_API_KEY) {
                console.log('For Gmail, you may need to use an App Password instead of your regular password');
                console.log('Learn more: https://support.google.com/accounts/answer/185833');
            }
        } else if (error.code === 'ESOCKET' || error.code === 'ETIMEDOUT') {
            console.log('\n🌐 Network error. Check your internet connection and firewall settings');
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
                console.log('\n💥 Test failed - check configuration');
                process.exit(1);
            }
        })
        .catch(error => {
            console.log('\n💥 Test failed with error!');
            process.exit(1);
        });
}

module.exports = { sendTestEmail };