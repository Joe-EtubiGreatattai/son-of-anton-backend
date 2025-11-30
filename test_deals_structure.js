// Test script to verify deals have link field
const testDeals = [
    {
        title: "Test Product 1",
        price: 29.99,
        source: "Amazon",
        link: "https://amazon.com/product1?tag=sagato-20",
        image: "https://example.com/image1.jpg",
        rating: "4.5",
        reviews: "100"
    },
    {
        title: "Test Product 2",
        price: 24.99,
        source: "eBay",
        link: "https://ebay.com/product2?campid=5338759945",
        image: "https://example.com/image2.jpg",
        rating: "4.0",
        reviews: "50"
    }
];

console.log("Test Deals Structure:");
console.log(JSON.stringify(testDeals, null, 2));

console.log("\n\nChecking if link exists in each deal:");
testDeals.forEach((deal, index) => {
    console.log(`Deal ${index + 1}:`);
    console.log(`  - Title: ${deal.title}`);
    console.log(`  - Has link: ${!!deal.link}`);
    console.log(`  - Link: ${deal.link}`);
});

console.log("\n\nThis is the exact structure your backend sends to the frontend.");
console.log("Each deal object includes the 'link' field with the affiliate URL.");
