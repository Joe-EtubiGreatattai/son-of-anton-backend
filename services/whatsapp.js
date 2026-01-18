const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

class WhatsAppService {
    constructor() {
        this.client = null;
        this.qrCode = null;
        this.status = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, QR_READY, CONNECTED
        this.clientReady = false;
    }

    initialize() {
        console.log('🚀 Initializing WhatsApp Service...');
        this.status = 'CONNECTING';

        this.client = new Client({
            authStrategy: new LocalAuth({
                dataPath: path.join(__dirname, '../.wwebjs_auth')
            }),
            puppeteer: {
                handleSIGINT: false,
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
            if (msg.body.toLowerCase() === 'ping') {
                msg.reply('pong');
            }
        });

        this.client.initialize().catch(err => {
            console.error('💥 WhatsApp Initialization Error:', err);
            this.status = 'DISCONNECTED';
        });
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

// Singleton instance
const whatsappService = new WhatsAppService();
module.exports = whatsappService;
