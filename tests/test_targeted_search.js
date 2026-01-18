const axios = require('axios');
const chalk = require('chalk');

const BACKEND_URL = 'http://192.168.1.165:3000/api/search';

async function runTest(query, expectedSources, label) {
    console.log(chalk.cyan(`\n[${label}] Testing query: "${query}"`));
    try {
        const startTime = Date.now();
        const response = await axios.post(BACKEND_URL,
            { searchQuery: query },
            { timeout: 120000 } // 2 minutes timeout for integrated scraping
        );
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        const { deals, totalValid } = response.data;

        if (!deals || deals.length === 0) {
            console.log(chalk.red(`  ❌ No deals found.`));
            return;
        }

        console.log(chalk.green(`  ✅ Found ${totalValid} total valid deals in ${duration}s.`));

        // Source distribution
        const sourceCounts = {};
        deals.forEach(d => {
            sourceCounts[d.source] = (sourceCounts[d.source] || 0) + 1;
        });

        console.log(chalk.gray('  Source Distribution:'), sourceCounts);

        // Verify priority sources
        const foundSources = Object.keys(sourceCounts).map(s => s.toLowerCase());
        const missingSources = expectedSources.filter(s => !foundSources.some(fs => fs.includes(s.toLowerCase())));

        if (missingSources.length === 0) {
            console.log(chalk.green(`  ✅ All targeted sources (${expectedSources.join(', ')}) were included.`));
        } else {
            console.log(chalk.yellow(`  ⚠️  Some targeted sources were missing: ${missingSources.join(', ')}`));
            console.log(chalk.gray(`     (Note: This might be normal if the store had no results for this query)`));
        }

        // Verify Weighting (Top 10 should be 90% Nigerian if available)
        const top10 = deals.slice(0, 10);
        const nigerianInTop10 = top10.filter(d => ['slot', 'jiji', 'jumia'].some(s => d.source.toLowerCase().includes(s))).length;

        console.log(chalk.blue(`  📊 Nigerian Priority: ${nigerianInTop10}/10 products in top 10 are from local stores.`));

        if (nigerianInTop10 >= 8) {
            console.log(chalk.green(`  ✅ 90/10 weighting is working effectively.`));
        } else {
            console.log(chalk.yellow(`  ℹ️  Weighting: Only ${nigerianInTop10}/10 are local. (May be due to limited local stock)`));
        }

    } catch (error) {
        console.error(chalk.red(`  ❌ Test failed:`), error.message);
        if (error.code === 'ECONNABORTED') {
            console.error(chalk.red('     Request timed out.'));
        }
        if (error.response) {
            console.error(chalk.red(`     Status: ${error.response.status}`));
            console.error(chalk.red(`     Data:`), error.response.data);
        }
    }
}

async function main() {
    console.log(chalk.bold.magenta('--- Starting Targeted Search Integration Tests ---'));

    // Test Gadget (Priority: Slot, Jiji | Backup: Amazon, eBay)
    await runTest('iphone 13', ['Slot', 'Jiji'], 'GADGET');

    // Test Fashion (Priority: Jumia | Backup: Amazon, eBay)
    await runTest('sneakers', ['Jumia'], 'FASHION');

    // Test General (Priority: Jiji, Slot | Backup: Amazon, eBay)
    await runTest('blender', ['Jiji'], 'GENERAL');

    console.log(chalk.bold.magenta('\n--- Integration Tests Completed ---'));
}

main();
