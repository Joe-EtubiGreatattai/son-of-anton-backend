
require('dotenv').config();
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: String,
    email: String,
    role: String
});

const User = mongoose.model('User', userSchema);

async function debugUserSearch() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to database...');

        const query = "greatattai442";
        console.log(`Searching for users containing "${query}" in email...`);

        const users = await User.find({ email: { $regex: query, $options: 'i' } });

        console.log(`Found ${users.length} matches:`);
        users.forEach(u => {
            console.log(`- ID: ${u._id}`);
            console.log(`  Email: "${u.email}"`); // Quotes to show whitespace
            console.log(`  Role: ${u.role}`);
        });

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await mongoose.disconnect();
    }
}

debugUserSearch();
