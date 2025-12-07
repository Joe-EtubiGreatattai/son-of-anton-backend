require('dotenv').config();
const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
    vendorId: mongoose.Schema.Types.ObjectId,
    title: String,
    description: String,
    price: Number,
    category: String,
    image: String,
    stock: Number,
    createdAt: Date
});

const Product = mongoose.model('Product', productSchema);

async function checkProducts() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to database...\n');

        const products = await Product.find({});
        console.log(`📦 Total products in database: ${products.length}\n`);

        if (products.length > 0) {
            console.log('Products found:');
            products.forEach((p, idx) => {
                console.log(`\n${idx + 1}. ${p.title}`);
                console.log(`   Vendor ID: ${p.vendorId}`);
                console.log(`   Price: ₦${p.price}`);
                console.log(`   Created: ${p.createdAt}`);
            });
        } else {
            console.log('⚠️ No products found in database!');
        }

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await mongoose.disconnect();
    }
}

checkProducts();
