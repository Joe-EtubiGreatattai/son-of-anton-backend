// email-utils.js
require('dotenv').config();
const nodemailer = require('nodemailer');

// Email configuration
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_SERVICE = process.env.EMAIL_SERVICE || 'gmail';

// Create and export transporter
let transporter = null;
if (EMAIL_USER && EMAIL_PASS) {
    transporter = nodemailer.createTransport({
        service: EMAIL_SERVICE,
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS
        }
    });
    console.log('✅ Email service configured');
} else {
    console.warn('⚠️  Email credentials not found. Email notifications will be disabled.');
}

// Export the sendDealEmail function
async function sendDealEmail(user, searchParty, deals) {
    if (!transporter) {
        console.log('Email service not configured, skipping notification');
        return false;
    }

    try {
        const dealsList = deals.map((deal, index) => `
            <div style="background: #f9f9f9; padding: 15px; margin: 10px 0; border-radius: 8px; border-left: 4px solid #4CAF50;">
                <h3 style="margin: 0 0 10px 0; color: #333;">${index + 1}. ${deal.title}</h3>
                <p style="margin: 5px 0; font-size: 24px; color: #4CAF50; font-weight: bold;">${deal.price.toFixed(2)}</p>
                <p style="margin: 5px 0; color: #666;">
                    <strong>Store:</strong> ${deal.source}<br>
                    ${deal.rating !== 'N/A' ? `<strong>Rating:</strong> ${deal.rating} (${deal.reviews} reviews)<br>` : ''}
                </p>
                <a href="${deal.link}" style="display: inline-block; margin-top: 10px; padding: 10px 20px; background: #4CAF50; color: white; text-decoration: none; border-radius: 5px;">View Deal</a>
            </div>
        `).join('');

        const priceFilter = searchParty.maxPrice ? `<p><strong>Max Price:</strong> ${searchParty.maxPrice}</p>` : '';
        const preferences = searchParty.preferences ? `<p><strong>Preferences:</strong> ${searchParty.preferences}</p>` : '';

        const mailOptions = {
            from: `"Son of Anton 🛍️" <${EMAIL_USER}>`,
            to: user.email,
            subject: `🎉 Great Deals Found for "${searchParty.itemName}"!`,
            html: `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                </head>
                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                        <h1 style="color: white; margin: 0; font-size: 28px;">🎉 Search Party Alert!</h1>
                    </div>
                    
                    <div style="background: white; padding: 30px; border: 1px solid #ddd; border-top: none; border-radius: 0 0 10px 10px;">
                        <p style="font-size: 18px; color: #333;">Hey ${user.username}! 👋</p>
                        
                        <p>Great news! I found some amazing deals for <strong>"${searchParty.itemName}"</strong> that match your search party criteria!</p>
                        
                        <div style="background: #f0f0f0; padding: 15px; border-radius: 8px; margin: 20px 0;">
                            <h3 style="margin: 0 0 10px 0; color: #667eea;">Your Search Party Details:</h3>
                            <p style="margin: 5px 0;"><strong>Item:</strong> ${searchParty.itemName}</p>
                            ${priceFilter}
                            ${preferences}
                        </div>

                        <h2 style="color: #667eea; border-bottom: 2px solid #667eea; padding-bottom: 10px;">Top Deals Found:</h2>
                        
                        ${dealsList}

                        <div style="margin-top: 30px; padding: 20px; background: #fff3cd; border-radius: 8px; border-left: 4px solid #ffc107;">
                            <p style="margin: 0; color: #856404;">
                                <strong>💡 Pro Tip:</strong> Prices can change quickly! Click the links above to grab these deals before they're gone.
                            </p>
                        </div>

                        <div style="margin-top: 30px; text-align: center; padding-top: 20px; border-top: 1px solid #ddd;">
                            <p style="color: #666; font-size: 14px;">
                                This email was sent by your Son of Anton Search Party<br>
                                You're receiving this because you set up an active search party for this item.
                            </p>
                        </div>
                    </div>
                    
                    <div style="text-align: center; margin-top: 20px; color: #999; font-size: 12px;">
                        <p>Happy Shopping! 🛍️</p>
                    </div>
                </body>
                </html>
            `
        };

        await transporter.sendMail(mailOptions);
        console.log(`✅ Email sent to ${user.email} for "${searchParty.itemName}"`);
        return true;
    } catch (error) {
        console.error('Email sending error:', error);
        return false;
    }
}

module.exports = {
    transporter,
    sendDealEmail
};