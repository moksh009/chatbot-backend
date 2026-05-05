const TRACKABLE_ASSETS = require('../constants/trackableAssets');

/**
 * Deterministic Translator: Conditions Array -> Mongo Query
 * Maps the high-level Waterfall Asset conditions to native MongoDB operators.
 * This service handles the core logic for rule-based lead segmentation.
 */
const translateConditionsToQuery = (conditions) => {
    if (!Array.isArray(conditions) || conditions.length === 0) return {};
    
    const andConditions = [];

    conditions.forEach(cond => {
        const asset = TRACKABLE_ASSETS.ASSETS[cond.assetId];
        if (!asset) return;

        let mongoOperator;
        switch (cond.operator) {
            case '>=': mongoOperator = '$gte'; break;
            case '<=': mongoOperator = '$lte'; break;
            case '===': mongoOperator = '$eq'; break;
            default: mongoOperator = '$eq';
        }

        // 1. Handle Special Compound Conditions (e.g., Just Landed)
        if (asset.id === 'JUST_LANDED') {
            const isJustLanded = cond.targetValue === true || cond.targetValue === 'true';
            if (isJustLanded) {
                andConditions.push({ ordersCount: 0 });
                andConditions.push({ inboundMessageCount: { $lte: 1 } });
            } else {
                // If not just landed, we want people who HAVE ordered OR have interacted
                andConditions.push({ 
                    $or: [
                        { ordersCount: { $gt: 0 } },
                        { inboundMessageCount: { $gt: 1 } }
                    ] 
                });
            }
        } 
        
        // 2. Handle Date-based Calculations (Rolling windows)
        else if (asset.type === 'CALCULATED_DAYS') {
            const days = parseInt(cond.targetValue);
            if (isNaN(days)) return;

            const date = new Date();
            date.setDate(date.getDate() - days);
            
            // If operator is >= (Older than X days), lastInteraction <= pastDate
            // If operator is <= (Within X days), lastInteraction >= pastDate
            const dateOp = cond.operator === '>=' ? '$lte' : '$gte';
            andConditions.push({ [asset.dbField]: { [dateOp]: date } });
        } 
        
        // 3. Handle Standard Numeric, Boolean & String Fields (dot paths e.g. adAttribution.source)
        else {
            let val = cond.targetValue;
            if (asset.type === 'NUMBER') val = parseFloat(cond.targetValue);
            if (asset.type === 'BOOLEAN') val = (cond.targetValue === true || cond.targetValue === 'true');
            if (asset.type === 'STRING') val = String(cond.targetValue ?? '').trim();

            if (val !== undefined && val !== '') {
                if (asset.type === 'NUMBER' && isNaN(val)) return;

                if (asset.type === 'STRING') {
                    andConditions.push({ [asset.dbField]: val });
                } else {
                    andConditions.push({ [asset.dbField]: { [mongoOperator]: val } });
                }
            }
        }
    });

    if (andConditions.length === 0) return {};
    return andConditions.length === 1 ? andConditions[0] : { $and: andConditions };
};

module.exports = { translateConditionsToQuery };
