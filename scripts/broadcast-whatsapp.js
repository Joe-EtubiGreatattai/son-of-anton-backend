#!/usr/bin/env node

/**
 * WhatsApp Broadcast Script
 * Sends an announcement message to all registered users
 * 
 * Usage: node scripts/broadcast-whatsapp.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const whatsappService = require('../services/whatsapp');

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

// User Schema (simplified for this script)
const userSchema = new mongoose.Schema({
    username: String,
    email: String,
    phoneNumber: String,
    preferences: Object,
    searchPreferences: Object
});

const User = mongoose.model('User', userSchema);

// Broadcast message
const ANNOUNCEMENT_MESSAGE = `🎉 Exciting News! 🎉

Son of Anton is now on WhatsApp! 📱✨

I'm your personal shopping notification assistant! I'll keep you updated on:
✅ Amazing deals and price drops
✅ Product availability alerts
✅ Exclusive offers

Want to search for products right now? Visit our full web app at:
🔗 **https://www.sonofanton.live/**

Happy shopping! 🛍️
- Son of Anton`;

// Statistics
const stats = {
    total: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    errors: []
};

async function broadcastToAllUsers() {
    try {
        console.log('🚀 Starting WhatsApp Broadcast...\n');

        // Connect to MongoDB
        console.log('📦 Connecting to database...');
        await mongoose.connect(MONGO_URI);
        console.log('✅ Database connected!\n');

        // Initialize WhatsApp Service
        console.log('📱 Initializing WhatsApp service...');
        await whatsappService.initialize();

        // Wait for WhatsApp to be ready
        let retries = 0;
        while (whatsappService.status !== 'CONNECTED' && retries < 60) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            retries++;
        }

        if (whatsappService.status !== 'CONNECTED') {
            throw new Error('WhatsApp service failed to connect after 60 seconds');
        }
        console.log('✅ WhatsApp ready!\n');

        // Fetch all users with phone numbers
        console.log('👥 Fetching users with phone numbers...');
        const users = await User.find({
            phoneNumber: { $exists: true, $ne: null, $ne: '' }
        }).select('username email phoneNumber');

        stats.total = users.length;
        console.log(`📊 Found ${stats.total} users with phone numbers\n`);

        if (stats.total === 0) {
            console.log('⚠️  No users with phone numbers found. Exiting...');
            return;
        }

        console.log('📤 Starting broadcast...\n');
        console.log('═'.repeat(70));

        // Send messages with delay to avoid rate limiting
        for (let i = 0; i < users.length; i++) {
            const user = users[i];
            const progress = `[${i + 1}/${stats.total}]`;

            try {
                // Format phone number for WhatsApp
                let phoneNumber = user.phoneNumber.trim();

                // Remove any non-digit characters except +
                phoneNumber = phoneNumber.replace(/[^\d+]/g, '');

                // Ensure it starts with country code
                if (!phoneNumber.startsWith('+')) {
                    // If no country code, skip this user
                    console.log(`${progress} ⚠️  Skipped ${user.username || user.email}: Invalid phone format (${user.phoneNumber})`);
                    stats.skipped++;
                    continue;
                }

                // Format for WhatsApp (remove + and add @c.us)
                const whatsappNumber = phoneNumber.substring(1) + '@c.us';

                console.log(`${progress} 📤 Sending to ${user.username || user.email} (${phoneNumber})...`);

                // Send the message
                await whatsappService.client.sendMessage(whatsappNumber, ANNOUNCEMENT_MESSAGE);

                stats.sent++;
                console.log(`${progress} ✅ Sent successfully!`);

                // Delay between messages (3-5 seconds to avoid rate limiting)
                const delay = 3000 + Math.random() * 2000;
                if (i < users.length - 1) { // Don't delay after last message
                    console.log(`${progress} ⏳ Waiting ${(delay / 1000).toFixed(1)}s before next message...\n`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }

            } catch (error) {
                stats.failed++;
                stats.errors.push({
                    user: user.username || user.email,
                    phone: user.phoneNumber,
                    error: error.message
                });
                console.log(`${progress} ❌ Failed: ${error.message}\n`);
            }
        }

        console.log('═'.repeat(70));
        console.log('\n📊 Broadcast Statistics:');
        console.log(`   Total users:     ${stats.total}`);
        console.log(`   ✅ Sent:         ${stats.sent}`);
        console.log(`   ❌ Failed:       ${stats.failed}`);
        console.log(`   ⚠️  Skipped:      ${stats.skipped}`);

        if (stats.errors.length > 0) {
            console.log('\n📋 Error Details:');
            stats.errors.forEach((err, idx) => {
                console.log(`   ${idx + 1}. ${err.user} (${err.phone}): ${err.error}`);
            });
        }

        console.log('\n🎉 Broadcast complete!');

    } catch (error) {
        console.error('\n❌ Broadcast failed:', error.message);
        console.error(error.stack);
    } finally {
        // Cleanup
        console.log('\n🧹 Cleaning up...');
        await mongoose.connection.close();
        console.log('✅ Database connection closed');
        console.log('👋 Goodbye!\n');
        process.exit(0);
    }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', async () => {
    console.log('\n\n⚠️  Broadcast interrupted by user');
    console.log('\n📊 Statistics so far:');
    console.log(`   Total users:     ${stats.total}`);
    console.log(`   ✅ Sent:         ${stats.sent}`);
    console.log(`   ❌ Failed:       ${stats.failed}`);
    console.log(`   ⚠️  Skipped:      ${stats.skipped}`);

    await mongoose.connection.close();
    process.exit(0);
});

// Run the broadcast
broadcastToAllUsers();
