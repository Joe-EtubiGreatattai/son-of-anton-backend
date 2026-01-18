const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const aiService = require('./ai');
const mongoose = require('mongoose');

// We'll lazy-load models to avoid circular dependencies if any, 
// though here we can just require them if they are defined globally or in another file.
// Since they are in server.js, we might have an issue unless we move them.
// FOR NOW, I'll assume they are available or I'll move them.
let User;
let Conversation;

try {
    User = mongoose.model('User');
    Conversation = mongoose.model('Conversation');
} catch (e) {
    // Models might not be initialized yet if this is required before server.js defines them
}

class WhatsAppService {
    constructor() {
        this.client = null;
        this.qrCode = null;
        this.status = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, QR_READY, CONNECTED
        this.clientReady = false;
    }

    async initialize(retries = 3) {
        if (this.status === 'CONNECTING' && retries > 0) {
            console.log('⏳ WhatsApp already initializing, waiting...');
            return;
        }

        console.log(`🚀 Initializing WhatsApp Service... (Attempts left: ${retries})`);
        this.status = 'CONNECTING';

        // Aggressive Lock Clearing
        try {
            const sessionPath = path.join(__dirname, '../.wwebjs_auth/session');
            const lockPath = path.join(sessionPath, 'SingletonLock');
            if (fs.existsSync(lockPath)) {
                console.log('🔓 Found persistent session lock. Clearing...');
                fs.unlinkSync(lockPath);
                console.log('✅ Session lock removed.');
            }
        } catch (lockError) {
            console.log('⚠️ Warning: Could not clear lock file automatically:', lockError.message);
        }

        try {
            if (this.client) {
                try {
                    // Check if puppeteer browser exists before trying to destroy
                    if (this.client.pupBrowser) {
                        await this.client.destroy();
                    }
                } catch (e) {
                    console.log('⚠️ Error cleaning up existing client:', e.message);
                } finally {
                    this.client = null;
                }
            }

            this.client = new Client({
                authStrategy: new LocalAuth({
                    dataPath: path.join(__dirname, '../.wwebjs_auth')
                }),
                webVersionCache: {
                    type: 'remote',
                    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
                },
                puppeteer: {
                    handleSIGINT: false,
                    cacheDirectory: path.join(__dirname, '../.puppeteer_cache'),
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-gpu'
                    ],
                }
            });

            this.client.on('qr', (qr) => {
                console.log('📸 WhatsApp QR Code received. Scan it to link your account:');
                this.qrCode = qr;
                this.status = 'QR_READY';
                qrcode.generate(qr, { small: true });
            });

            this.client.on('ready', () => {
                console.log('✅ WhatsApp Client is READY!');
                this.status = 'CONNECTED';
                this.clientReady = true;
                this.qrCode = null;

                // CRITICAL FIX: Override sendSeen to prevent markedUnread errors
                // This is a workaround for WhatsApp Web library compatibility issues
                if (this.client.pupPage) {
                    this.client.pupPage.evaluate(() => {
                        if (window.WWebJS && window.WWebJS.sendSeen) {
                            window.WWebJS.sendSeen = async () => {
                                // No-op: disable auto-seen marking to prevent errors
                                return true;
                            };
                        }
                    }).catch(err => {
                        console.log('⚠️ Could not patch sendSeen function:', err.message);
                    });
                }
            });

            this.client.on('authenticated', () => {
                console.log('🔑 WhatsApp Authenticated successfully!');
                this.status = 'AUTHENTICATED';
            });

            this.client.on('auth_failure', (msg) => {
                console.error('❌ WhatsApp Authentication failure:', msg);
                this.status = 'DISCONNECTED';
                this.clientReady = false;
            });

            this.client.on('disconnected', (reason) => {
                console.log('🔌 WhatsApp Disconnected:', reason);
                this.status = 'DISCONNECTED';
                this.clientReady = false;
                // Attempt to re-initialize after a delay
                setTimeout(() => this.initialize(), 5000);
            });

            this.client.on('message', async (msg) => {
                try {
                    if (msg.body.toLowerCase() === 'ping') {
                        return msg.reply('pong');
                    }

                    // Only process messages from individuals, not groups
                    const chat = await msg.getChat();
                    if (chat.isGroup) return;

                    console.log(`📩 WhatsApp Message from ${msg.from}: ${msg.body}`);

                    // 1. Identify User
                    if (!User) User = mongoose.model('User');
                    if (!Conversation) Conversation = mongoose.model('Conversation');

                    const phoneNumber = msg.from.split('@')[0];
                    const user = await User.findOne({
                        $or: [
                            { phoneNumber: phoneNumber },
                            { phoneNumber: `+${phoneNumber}` },
                            { phoneNumber: msg.from }
                        ]
                    });

                    // 2. Manage Conversation History
                    const sessionId = `whatsapp_${msg.from}`;
                    let conversation = await Conversation.findOne({ sessionId });

                    if (!conversation) {
                        conversation = new Conversation({
                            sessionId,
                            userId: user ? user._id : new mongoose.Types.ObjectId(), // Placeholder for anonymous
                            messages: []
                        });
                    }

                    // Add user message to history
                    conversation.messages.push({ role: 'user', content: msg.body });

                    // 3. Generate AI Response (WhatsApp-specific: redirects searches to web)
                    const aiPrompt = aiService.generateAIPrompt(msg.body, null, user, conversation.messages, 'whatsapp');
                    const aiResponse = await aiService.callGeminiAPI(aiPrompt);

                    // Clean AI response from search markers for WhatsApp
                    let cleanReply = aiResponse.replace(/SEARCH:.*(\n?)/, '').replace(/CATEGORY:.*(\n?)/, '').trim();
                    const displayMessage = aiService.formatDisplayMessage(cleanReply);

                    // Add assistant response to history
                    conversation.messages.push({ role: 'assistant', content: aiResponse });
                    await conversation.save();

                    // 4. Send Reply - with fallback for markedUnread errors
                    try {
                        // Try sending through the chat object first (more reliable)
                        const chat = await msg.getChat();
                        await chat.sendMessage(displayMessage);
                        console.log(`📤 WhatsApp Reply sent to ${msg.from}`);
                    } catch (sendError) {
                        // If chat.sendMessage fails, log the error but don't crash
                        console.error('⚠️ Error sending WhatsApp message (markedUnread issue):', sendError.message);
                        console.log('💬 Message content was:', displayMessage);
                        // The conversation history was already saved, so at least we have that
                    }

                } catch (error) {
                    console.error('❌ Error processing WhatsApp AI reply:', error);
                }
            });

            this.client.initialize().catch(async (err) => {
                console.error('💥 WhatsApp Initialization Error:', err.message);
                this.status = 'DISCONNECTED';

                // Specific check for lock/running error
                if (err.message.includes('browser is already running') || err.message.includes('SingletonLock')) {
                    console.log(`🔄 Session conflict detected. Attempting lock-break retry... (${retries} retries left)`);

                    // Force cleanup of client object before retry
                    this.client = null;

                    setTimeout(() => this.initialize(retries - 1), 3000);
                } else if (retries > 0) {
                    console.log(`🔄 Retrying initialization... (${retries} left)`);
                    setTimeout(() => this.initialize(retries - 1), 5000);
                } else {
                    console.error('❌ Max retries reached or fatal error. WhatsApp will not be available.');
                }
            });
        } catch (error) {
            console.error('💥 Fatal WhatsApp Error during setup:', error);
            this.status = 'DISCONNECTED';
        }
    }

    async destroy() {
        console.log('🧹 Shutting down WhatsApp Service...');
        if (this.client) {
            try {
                // Only destroy if it was actually initialized
                if (this.client.pupBrowser) {
                    await this.client.destroy();
                }
                console.log('✅ WhatsApp Client destroyed successfully.');
            } catch (err) {
                console.error('❌ Error destroying WhatsApp Client:', err.message);
            } finally {
                this.client = null;
                this.clientReady = false;
                this.status = 'DISCONNECTED';
            }
        }
    }

    getStatus() {
        return {
            status: this.status,
            ready: this.clientReady,
            hasQR: !!this.qrCode
        };
    }

    getQR() {
        return this.qrCode;
    }

    async sendMessage(phoneNumber, message) {
        if (!this.clientReady) {
            throw new Error('WhatsApp client is not ready');
        }

        // Clean phone number (remove non-digits, ensure format)
        const cleanedNumber = phoneNumber.replace(/\D/g, '');
        const finalNumber = cleanedNumber.includes('@c.us') ? cleanedNumber : `${cleanedNumber}@c.us`;

        try {
            const chat = await this.client.sendMessage(finalNumber, message);
            return chat;
        } catch (error) {
            console.error('Error sending WhatsApp message:', error);
            throw error;
        }
    }
}

const whatsappService = new WhatsAppService();
module.exports = whatsappService;
