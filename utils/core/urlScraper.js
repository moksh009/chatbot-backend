const axios = require('axios');
const cheerio = require('cheerio');

async function scrapeWebsiteText(url) {
  try {
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 10000
    });
    
    const $ = cheerio.load(data);
    
    // Remove unwanted tags
    $('script, style, noscript, iframe, img, svg').remove();
    
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    return text;
  } catch (error) {
    console.error(`Failed to scrape ${url}:`, error.message);
    throw error;
  }
}

module.exports = {
  scrapeWebsiteText
};
