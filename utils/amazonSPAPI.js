const axios = require('axios');
const log = require('./logger')('AmazonSPAPI');

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
}

module.exports = AmazonSPAPI;
