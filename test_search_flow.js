const axios = require('axios');
const chalk = require('chalk');

const SCRAPPER_URL = 'https://search-api-backend-7uw8.onrender.com/api/search';
const BACKEND_URL = 'http://localhost:3000/api/search';

// Use a simple query to ensure we get results if it's working
const QUERY = 'iphone 12';
const CATEGORY = 'electronics';

async function testScrapper() {
    console.log(chalk.blue('--- Testing Direct Scrapper Connection (localhost:3001) ---'));
    try {
        const start = Date.now();
        console.log(`Sending request to ${SCRAPPER_URL}?q=${QUERY}...`);

        const response = await axios.get(SCRAPPER_URL, {
            params: { q: QUERY, category: CATEGORY },
            timeout: 60000 // 60s timeout for scraping
        });

        const duration = Date.now() - start;
        console.log(chalk.green(`✅ Scrapper responded in ${duration}ms`));
        console.log(`Status: ${response.status}`);
        const count = response.data.results?.length || 0;
        console.log(`Results: ${count}`);

        if (count > 0) {
            console.log(`Sample: ${response.data.results[0].title}`);
        } else {
            console.log(chalk.yellow('⚠️  Scrapper returned 0 results. Check scrapper logic/selectors.'));
        }
        return true;
    } catch (error) {
        console.error(chalk.red('❌ Scrapper Test Failed:'));
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
            console.error('Data:', error.response.data);
        } else {
            console.error(error.message);
            if (error.code === 'ECONNREFUSED') {
                console.error(chalk.yellow('👉 Is the scrapper running on port 3001?'));
            }
        }
        return false;
    }
}

async function testBackend() {
    console.log(chalk.blue('\n--- Testing Backend Proxy Connection (localhost:3000) ---'));
    try {
        const start = Date.now();
        console.log(`Sending request to ${BACKEND_URL}?q=${QUERY}...`);

        const response = await axios.get(BACKEND_URL, {
            params: { q: QUERY, category: CATEGORY },
            timeout: 60000
        });

        const duration = Date.now() - start;
        console.log(chalk.green(`✅ Backend responded in ${duration}ms`));
        console.log(`Status: ${response.status}`);
        const count = response.data.results?.length || 0;
        console.log(`Results: ${count}`);

        if (count > 0) {
            console.log(`Sample: ${response.data.results[0].title}`);
        } else {
            console.log(chalk.yellow('⚠️  Backend returned 0 results.'));
        }
    } catch (error) {
        console.error(chalk.red('❌ Backend Test Failed:'));
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
            console.error('Data:', error.response.data);
        } else {
            console.error(error.message);
            if (error.code === 'ECONNREFUSED') {
                console.error(chalk.yellow('👉 Is the backend running on port 3000?'));
            }
        }
    }
}

async function run() {
    const scrapperOk = await testScrapper();
    if (scrapperOk) {
        await testBackend();
    } else {
        console.log(chalk.red('\n🛑 Skipping Backend test because Scrapper failed. Fix Scrapper first.'));
    }
}

run();
