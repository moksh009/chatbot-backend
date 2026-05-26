const axios = require('axios');
const log = require('../core/logger')('AmazonSPAPI');

/**
 * Amazon SP-API Helper (Enterprise Foundation)
 */
class AmazonSPAPI {
    constructor(credentials = {}) {
        this.clientId = credentials.clientId || process.env.AMAZON_CLIENT_ID;
        this.clientSecret = credentials.clientSecret || process.env.AMAZON_CLIENT_SECRET;
        this.refreshToken = credentials.refreshToken || process.env.AMAZON_REFRESH_TOKEN;
        this.region = credentials.region || 'eu-west-1'; // or us-east-1
        this.accessToken = null;
    }

    /**
     * Get OAuth Access Token from LWA (Login with Amazon)
     */
    async getAccessToken() {
        if (this.accessToken) return this.accessToken;

        try {
            const res = await axios.post('https://api.amazon.com/auth/o2/token', {
                grant_type: 'refresh_token',
                refresh_token: this.refreshToken,
                client_id: this.clientId,
                client_secret: this.clientSecret
            });
            this.accessToken = res.data.access_token;
            return this.accessToken;
        } catch (err) {
            log.error('LWA Auth Failed:', err.response?.data || err.message);
            throw new Error(`Amazon LWA Authentication failed: ${err.message}`);
        }
    }

    /**
     * Fetch recent orders from Amazon
     */
    async getOrders(marketplaceId, createdAfter = null) {
        const token = await this.getAccessToken();
        const endpoint = `https://sellingpartnerapi-${this.region}.amazon.com/orders/v0/orders`;
        
        try {
            const res = await axios.get(endpoint, {
                params: {
                    MarketplaceIds: marketplaceId,
                    CreatedAfter: createdAfter || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
                    OrderStatuses: 'Unshipped,PartiallyShipped,Shipped'
                },
                headers: {
                    'x-amz-access-token': token,
                    'Content-Type': 'application/json'
                }
            });
            return res.data.payload?.Orders || [];
        } catch (err) {
            log.error('GetOrders Failed:', err.response?.data || err.message);
            return [];
        }
    }

    /**
     * Get Order Items (to extract SKUs for Trigger Engine)
     */
    async getOrderItems(orderId) {
        const token = await this.getAccessToken();
        const endpoint = `https://sellingpartnerapi-${this.region}.amazon.com/orders/v0/orders/${orderId}/orderItems`;
        
        try {
            const res = await axios.get(endpoint, {
                headers: {
                    'x-amz-access-token': token,
                    'Content-Type': 'application/json'
                }
            });
            return res.data.payload?.OrderItems || [];
        } catch (err) {
            log.error(`GetOrderItems Failed for ${orderId}:`, err.response?.data || err.message);
            return [];
        }
    }

    /**
     * Patch merchant-fulfilled listing quantity (Listings Items API).
     */
    async updateListingQuantity({ sellerId, marketplaceId, sellerSku, quantity }) {
        const token = await this.getAccessToken();
        const skuEnc = encodeURIComponent(sellerSku);
        const endpoint = `https://sellingpartnerapi-${this.region}.amazon.com/listings/2021-08-01/items/${sellerId}/${skuEnc}`;

        try {
            const res = await axios.patch(
                endpoint,
                {
                    productType: 'PRODUCT',
                    patches: [
                        {
                            op: 'replace',
                            path: '/attributes/fulfillment_availability',
                            value: [
                                {
                                    fulfillment_channel_code: 'DEFAULT',
                                    quantity: Math.max(0, Number(quantity) || 0),
                                    marketplace_id: marketplaceId,
                                },
                            ],
                        },
                    ],
                },
                {
                    headers: {
                        'x-amz-access-token': token,
                        'Content-Type': 'application/json',
                    },
                    params: { marketplaceIds: marketplaceId },
                }
            );
            return { ok: true, status: res.status, payload: res.data };
        } catch (err) {
            const detail = err.response?.data || err.message;
            log.error(`updateListingQuantity ${sellerSku}:`, detail);
            return { ok: false, reason: 'api_error', error: typeof detail === 'string' ? detail : JSON.stringify(detail) };
        }
    }

    /**
     * Read merchant-fulfilled qty hint from listings (best-effort).
     */
    async getListingQuantity({ sellerId, marketplaceId, sellerSku }) {
        const details = await this.getListingDetails({ sellerId, marketplaceId, sellerSku });
        return details?.merchantFulfilled?.quantity ?? null;
    }

    /**
     * Listings API — merchant-fulfilled qty + fulfillment channel detection.
     */
    async getListingDetails({ sellerId, marketplaceId, sellerSku }) {
        const token = await this.getAccessToken();
        const skuEnc = encodeURIComponent(sellerSku);
        const endpoint = `https://sellingpartnerapi-${this.region}.amazon.com/listings/2021-08-01/items/${sellerId}/${skuEnc}`;
        try {
            const res = await axios.get(endpoint, {
                headers: { 'x-amz-access-token': token },
                params: { marketplaceIds: marketplaceId, includedData: 'fulfillmentAvailability' },
            });
            const availability = res.data?.fulfillmentAvailability || res.data?.attributes?.fulfillment_availability || [];
            const list = Array.isArray(availability) ? availability : [availability].filter(Boolean);

            let merchantQty = 0;
            let fbaQty = 0;
            const channels = [];
            for (const row of list) {
                const code = String(row.fulfillment_channel_code || row.channelCode || '').toUpperCase();
                const qty = Number(row.quantity ?? row.availableQuantity ?? 0) || 0;
                channels.push(code || 'DEFAULT');
                if (code === 'DEFAULT' || code === 'MERCHANT' || code === '') {
                    merchantQty += qty;
                } else if (code.includes('AMAZON')) {
                    fbaQty += qty;
                } else {
                    merchantQty += qty;
                }
            }

            let fulfillment = 'merchant';
            if (merchantQty > 0 && fbaQty > 0) fulfillment = 'mixed';
            else if (fbaQty > 0 && merchantQty <= 0) fulfillment = 'fba';

            return {
                ok: true,
                merchantFulfilled: { quantity: merchantQty, channels },
                fbaListingQty: fbaQty,
                detectedFulfillment: fulfillment,
                asin: res.data?.asin || res.data?.summaries?.[0]?.asin,
            };
        } catch (err) {
            const status = err.response?.status;
            const detail = err.response?.data || err.message;
            log.warn(`getListingDetails ${sellerSku}:`, detail);
            return { ok: false, status, error: typeof detail === 'string' ? detail : JSON.stringify(detail) };
        }
    }

    /**
     * FBA Inventory API — paginated summaries.
     * @returns {{ summaries: Array, nextToken: string|null }}
     */
    async getFbaInventorySummaries({ marketplaceId, nextToken = null, sellerSkus = null }) {
        const token = await this.getAccessToken();
        const endpoint = `https://sellingpartnerapi-${this.region}.amazon.com/fba/inventory/v1/summaries`;

        const params = {
            granularityType: 'Marketplace',
            granularityId: marketplaceId,
            marketplaceIds: marketplaceId,
            details: true,
        };
        if (nextToken) params.nextToken = nextToken;
        if (sellerSkus?.length) params.sellerSkus = sellerSkus.join(',');

        try {
            const res = await axios.get(endpoint, {
                headers: { 'x-amz-access-token': token },
                params,
            });
            const payload = res.data?.payload || res.data || {};
            const summaries = payload.inventorySummaries || payload.summaries || [];
            return {
                summaries: Array.isArray(summaries) ? summaries : [],
                nextToken: payload.pagination?.nextToken || payload.nextToken || null,
            };
        } catch (err) {
            const status = err.response?.status;
            const detail = err.response?.data || err.message;
            log.error('getFbaInventorySummaries failed:', detail);
            const error = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
            error.status = status;
            error.isRateLimit = status === 429;
            throw error;
        }
    }

    clearAccessToken() {
        this.accessToken = null;
    }
}

module.exports = AmazonSPAPI;

/**
 * Normalize SP-API FBA summary row to snapshot shape.
 */
function parseFbaSummaryRow(row) {
    const details = row.inventoryDetails || row;
    const reserved =
        Number(details.reservedQuantity?.totalReservedQuantity ?? details.reservedQuantity) || 0;
    const researching =
        Number(details.researchingQuantity?.totalResearchingQuantity ?? details.researchingQuantity) || 0;
    const unfulfillable =
        Number(details.unfulfillableQuantity?.totalUnfulfillableQuantity ?? details.unfulfillableQuantity) || 0;

    const fulfillable = Number(details.fulfillableQuantity) || 0;
    const inboundWorking = Number(details.inboundWorkingQuantity) || 0;
    const inboundShipped = Number(details.inboundShippedQuantity) || 0;
    const inboundReceiving = Number(details.inboundReceivingQuantity) || 0;

    return {
        sellerSku: row.sellerSku || row.sku,
        asin: row.asin || '',
        fba: {
            fulfillable,
            inbound: { working: inboundWorking, shipped: inboundShipped, receiving: inboundReceiving },
            reserved,
            unfulfillable,
            researching,
            totalQuantity: Number(row.totalQuantity) || fulfillable + inboundWorking + inboundShipped + inboundReceiving,
        },
    };
}

AmazonSPAPI.parseFbaSummaryRow = parseFbaSummaryRow;
