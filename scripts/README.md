# WhatsApp Broadcast Scripts

This directory contains scripts for sending WhatsApp broadcast messages to users.

## 📋 Available Scripts

### `broadcast-whatsapp.js`
Sends an announcement message to all registered users with phone numbers.

## 🚀 Usage

### Prerequisites
1. Make sure your WhatsApp service is linked (QR code scanned)
2. Backend server should be running (for WhatsApp connection)
3. Database connection is required

### Running the Broadcast

```bash
# From the backend directory
node scripts/broadcast-whatsapp.js
```

### What It Does
1. ✅ Connects to your MongoDB database
2. ✅ Initializes WhatsApp service
3. ✅ Fetches all users with valid phone numbers
4. ✅ Sends announcement message to each user
5. ✅ Includes 3-5 second delays between messages (anti-spam protection)
6. ✅ Shows real-time progress
7. ✅ Provides detailed statistics at the end

## ⚠️ Important Notes

### Rate Limiting
- The script includes automatic delays (3-5 seconds) between messages
- This prevents WhatsApp from flagging your account for spam
- **Do not modify these delays** unless you know what you're doing

### Phone Number Format
- Users must have phone numbers with country codes (e.g., `+1234567890`)
- Invalid phone numbers will be skipped automatically
- The script logs all skipped users

### Stopping the Broadcast
- Press `Ctrl+C` to stop the broadcast at any time
- The script will show statistics for messages sent before stopping
- All connections will be cleaned up properly

## 📊 Output Example

```
🚀 Starting WhatsApp Broadcast...

📦 Connecting to database...
✅ Database connected!

📱 Initializing WhatsApp service...
✅ WhatsApp ready!

👥 Fetching users with phone numbers...
📊 Found 150 users with phone numbers

📤 Starting broadcast...

══════════════════════════════════════════════════════════════════════
[1/150] 📤 Sending to john@example.com (+1234567890)...
[1/150] ✅ Sent successfully!
[1/150] ⏳ Waiting 3.4s before next message...

[2/150] 📤 Sending to jane@example.com (+9876543210)...
[2/150] ✅ Sent successfully!
...

══════════════════════════════════════════════════════════════════════

📊 Broadcast Statistics:
   Total users:     150
   ✅ Sent:         145
   ❌ Failed:       2
   ⚠️  Skipped:      3

🎉 Broadcast complete!
```

## 🛠️ Customizing the Message

Edit the `ANNOUNCEMENT_MESSAGE` constant in `broadcast-whatsapp.js`:

```javascript
const ANNOUNCEMENT_MESSAGE = `Your custom message here`;
```

## 🔒 Safety Features

1. **Graceful Shutdown**: Handles Ctrl+C properly
2. **Error Handling**: Continues even if individual messages fail
3. **Progress Tracking**: Shows real-time progress
4. **Detailed Logging**: Records all successes, failures, and skips
5. **Database Cleanup**: Always closes connections properly

## 📝 Best Practices

1. **Test First**: Send to yourself or a small group before broadcasting to everyone
2. **Check WhatsApp Status**: Ensure WhatsApp service is connected before running
3. **Monitor Progress**: Watch the console output for any issues
4. **Review Statistics**: Check the final stats to ensure delivery
5. **Timing Matters**: Don't send broadcasts at odd hours

## 🚨 Troubleshooting

### "WhatsApp service failed to connect"
- Make sure WhatsApp is linked (scan QR code first)
- Check that the backend server is running
- Verify `.env` has correct settings

### "No users with phone numbers found"
- Check your database for users with valid phone numbers
- Verify the User model schema matches

### Messages failing to send
- Check phone number format (must include country code with +)
- Verify WhatsApp connection is stable
- Check the error details in the final statistics

## 💡 Pro Tips

- Run during business hours for better engagement
- Keep messages concise and friendly
- Include a clear call-to-action
- Test with a small group first
- Monitor your WhatsApp account for any warnings
