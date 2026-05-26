'use strict';

const KnowledgeDocument = require('../../models/KnowledgeDocument');

/**
 * Best-effort KB seed from website scrape selling points (support_bot goal).
 * @param {string} clientId
 * @param {{ keySellingPoints?: string[] }} brandProfile
 * @returns {Promise<number>} count created
 */
async function seedKnowledgeFromBrandProfile(clientId, brandProfile) {
  const points = Array.isArray(brandProfile?.keySellingPoints)
    ? brandProfile.keySellingPoints.filter((p) => String(p || '').trim())
    : [];
  if (!clientId || points.length === 0) return 0;

  let created = 0;
  for (const raw of points.slice(0, 3)) {
    const text = String(raw).trim().slice(0, 500);
    if (!text) continue;
    const title = text.length > 80 ? `${text.slice(0, 77)}…` : text;
    const existing = await KnowledgeDocument.findOne({
      clientId,
      sourceType: 'website',
      title,
    })
      .select('_id')
      .lean();
    if (existing) continue;

    await KnowledgeDocument.create({
      clientId,
      title,
      content: text,
      documentType: 'faq',
      sourceType: 'website',
      sourceUrl: brandProfile.sourceUrl || undefined,
      isActive: true,
      status: 'processed',
    });
    created += 1;
  }
  return created;
}

module.exports = { seedKnowledgeFromBrandProfile };
