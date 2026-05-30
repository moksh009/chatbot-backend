const { buildKnowledgeFromWebsite } = require('./websiteKnowledgeBuilder');

async function scrapeWebsiteText(url) {
  const built = await buildKnowledgeFromWebsite(url, { useAiEnhance: false });
  return built.content;
}

module.exports = {
  scrapeWebsiteText,
};
