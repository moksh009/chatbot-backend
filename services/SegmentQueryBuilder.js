const TRACKABLE_ASSETS = require('../constants/trackableAssets');

/**
 * Translates UI filters into a MongoDB query object.
 * @param {Array} filters - Array of { assetId, operator, targetValue }
 * @returns {Object} MongoDB query object
 */
const buildMongoQueryFromFilters = (filters) => {
  if (!filters || filters.length === 0) return {};

  const query = {};
  const andConditions = [];

  filters.forEach(filter => {
    const assetConfig = TRACKABLE_ASSETS.ASSETS[filter.assetId];
    if (!assetConfig) return;

    let mongoOperator = '';
    switch (filter.operator) {
      case '>=': mongoOperator = '$gte'; break;
      case '<=': mongoOperator = '$lte'; break;
      case '===': mongoOperator = '$eq'; break;
    }

    if (assetConfig.id === 'JUST_LANDED') {
      const isTrue = filter.targetValue === true || filter.targetValue === 'true';
      if (isTrue) {
         andConditions.push({ ordersCount: 0 });
         andConditions.push({ inboundMessageCount: { $lte: 1 } });
      }
      return; // Skip standard mapping
    }

    if (assetConfig.type === 'CALCULATED_DAYS') {
      // If we want ">= 30 days ago", the date must be LESS THAN (older than) 30 days ago.
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() - parseInt(filter.targetValue));
      
      const dateOperator = filter.operator === '>=' ? '$lte' : '$gte';
      andConditions.push({ [assetConfig.dbField]: { [dateOperator]: targetDate } });
      return;
    }

    // Standard Number matching
    if (mongoOperator === '$eq') {
      andConditions.push({ [assetConfig.dbField]: filter.targetValue });
    } else {
      andConditions.push({ [assetConfig.dbField]: { [mongoOperator]: parseFloat(filter.targetValue) } });
    }
  });

  if (andConditions.length > 0) {
    query.$and = andConditions;
  }

  return query;
};

module.exports = { buildMongoQueryFromFilters };
