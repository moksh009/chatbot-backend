const axios = require('axios');

/**
 * Enhanced URL Scraper
 * Fetches an HTML page and aggressively extracts readable text
 * while filtering out scripts, styles, and boilerplate HTML.
 */
async function scrapeWebsiteText(url) {
  try {
    // Basic validation
    let targetUrl = url.trim();
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }

    // Fetch HTML
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
      },
      timeout: 10000 // 10s timeout
    });

    let html = response.data;

    // 1. Remove Scripts and Styles
    html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
    html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
    html = html.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ');

    // 2. Remove SVGs, Navs, Footers (Optional but helps focusing on core text)
    html = html.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ');
    
    // 3. Replace common block elements with newlines for formatting
    html = html.replace(/<(div|p|br|h1|h2|h3|h4|h5|h6|li|tr|td)[^>]*>/gi, '\n');

    // 4. Strip all remaining HTML tags
    let text = html.replace(/<[^>]+>/g, ' ');

    // 5. Decode basic HTML entities
    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&copy;/g, '©')
      .replace(/&reg;/g, '®');

    // 6. Clean up whitespace
    text = text.replace(/[ \t]+/g, ' '); // collapse horizontal whitespace
    text = text.replace(/[\n\r]{2,}/g, '\n\n'); // collapse multiple vertical newlines to just 2
    text = text.trim();

    // 7. Limit output size to prevent context overflow (e.g., 15k chars)
    if (text.length > 20000) {
      text = text.substring(0, 20000) + '... [TRUNCATED]';
    }

    return { success: true, text };
  } catch (error) {
    console.error(`[Scraper Error] Failed to scrape ${url}:`, error.message);
    return { success: false, error: 'Could not fetch or parse the website. Check the URL and try again.' };
  }
}

module.exports = { scrapeWebsiteText };
