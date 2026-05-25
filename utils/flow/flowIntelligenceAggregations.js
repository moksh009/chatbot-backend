'use strict';

const Message = require('../../models/Message');

const DEFAULT_FALLBACK_REGEX =
  /I'm not sure|I don't understand|fallback|connect you to an agent|sorry, I didn't get that|I'm having trouble|couldn't understand|please try again/i;

/**
 * For each outgoing fallback message, find the immediately prior incoming user message (one query).
 * @param {string} clientId
 * @param {{ limit?: number, since?: Date, fallbackRegex?: RegExp }} opts
 * @returns {Promise<string[]>} distinct question texts
 */
async function collectQuestionsBeforeFallbacks(clientId, opts = {}) {
  const limit = Math.min(200, Math.max(1, opts.limit || 50));
  const since = opts.since || null;
  const fallbackRegex = opts.fallbackRegex || DEFAULT_FALLBACK_REGEX;

  const match = {
    clientId,
    direction: 'outgoing',
    content: { $regex: fallbackRegex },
  };
  if (since) match.timestamp = { $gte: since };

  const rows = await Message.aggregate([
    { $match: match },
    { $sort: { timestamp: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: Message.collection.name,
        let: { conv: '$conversationId', ts: '$timestamp' },
        pipeline: [
          {
            $match: {
              clientId,
              direction: 'incoming',
              $expr: {
                $and: [
                  { $eq: ['$conversationId', '$$conv'] },
                  { $lt: ['$timestamp', '$$ts'] },
                ],
              },
            },
          },
          { $sort: { timestamp: -1 } },
          { $limit: 1 },
          { $project: { content: 1, timestamp: 1, _id: 1 } },
        ],
        as: 'priorIncoming',
      },
    },
    { $unwind: { path: '$priorIncoming', preserveNullAndEmptyArrays: false } },
    {
      $project: {
        query: '$priorIncoming.content',
        queryId: '$priorIncoming._id',
        date: '$timestamp',
      },
    },
  ]);

  return rows;
}

module.exports = {
  collectQuestionsBeforeFallbacks,
  DEFAULT_FALLBACK_REGEX,
};
