'use strict';

const AdLead = require('../../models/AdLead');

function normalizeTagList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

async function transitionLeadTags({ filter, add = [], remove = [] } = {}) {
  if (!filter || typeof filter !== 'object') return { matchedCount: 0, modifiedCount: 0 };
  const addTags = normalizeTagList(add);
  const removeTags = normalizeTagList(remove).filter((tag) => !addTags.includes(tag));
  if (!addTags.length && !removeTags.length) {
    return { matchedCount: 0, modifiedCount: 0 };
  }

  const result = await AdLead.updateMany(filter, [
    {
      $set: {
        tags: {
          $setUnion: [
            { $setDifference: [{ $ifNull: ['$tags', []] }, removeTags] },
            addTags,
          ],
        },
      },
    },
  ]);

  return {
    matchedCount: Number(result?.matchedCount || 0),
    modifiedCount: Number(result?.modifiedCount || 0),
  };
}

module.exports = {
  transitionLeadTags,
  normalizeTagList,
};
