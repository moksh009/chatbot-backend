const axios = require('axios');
const Client = require('../models/Client');
const { encrypt, decrypt } = require('./encryption');
const shopifyAdminApiVersion = require('./shopifyAdminApiVersion');
const log = require('./logger')('ShopifyGraphQL');

/**
 * Executes a GraphQL mutation/query on Shopify Admin API.
 * Uses the same auto-rotation and self-healing logic from shopifyHelper.
 */
async function executeGraphQL(clientId, query, variables = {}) {
    const client = await Client.findOne({ clientId });
    if (!client) throw new Error('Client not found');

    const domain = client.shopDomain;
    const apiVersion = client.shopifyApiVersion || shopifyAdminApiVersion;
    const token = decrypt(client.shopifyAccessToken);

    if (!token || !domain) {
        throw new Error('Shopify credentials incomplete (GraphQL)');
    }

    try {
        const response = await axios.post(
            `https://${domain}/admin/api/${apiVersion}/graphql.json`,
            { query, variables },
            {
                headers: {
                    'X-Shopify-Access-Token': token,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.errors) {
            log.error(`GraphQL Errors for ${clientId}:`, JSON.stringify(response.data.errors));
            throw new Error(`Shopify GraphQL Error: ${response.data.errors[0].message}`);
        }

        return response.data.data;
    } catch (err) {
        log.error(`GraphQL Request Failed for ${clientId}:`, err.response?.data || err.message);
        throw err;
    }
}

/**
 * Creates a unique, single-use, 3-month valid Shopify discount code.
 * Uses the modern GraphQL Admin API (future-proof).
 */
async function createLoyaltyDiscount(clientId, { code, amount, customerId, daysValid = 90 }) {
    const mutation = `
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              codes(first: 1) {
                nodes {
                  code
                }
              }
              startsAt
              endsAt
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
    `;

    const startsAt = new Date().toISOString();
    const endsAt = new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000).toISOString();

    const variables = {
      basicCodeDiscount: {
        title: `Loyalty Reward: ${amount} OFF`,
        code: code,
        startsAt: startsAt,
        endsAt: endsAt,
        customerSelection: {
          all: true // For simplicity in V1, we allow anyone with the code to use it, fixed via uniqueness
        },
        customerGets: {
          value: {
            fixedAmountValue: amount
          },
          items: {
            all: true
          }
        },
        appliesOncePerCustomer: true,
        usageLimit: 1
      }
    };

    try {
        const result = await executeGraphQL(clientId, mutation, variables);
        const data = result.discountCodeBasicCreate;

        if (data.userErrors && data.userErrors.length > 0) {
            throw new Error(`UserErrors: ${data.userErrors.map(e => e.message).join(', ')}`);
        }

        return {
            success: true,
            id: data.codeDiscountNode.id,
            code: code,
            endsAt: endsAt
        };
    } catch (err) {
        log.error(`Failed to create loyalty discount for ${clientId}:`, err.message);
        throw err;
    }
}

/**
 * Fetches all store locations for a client.
 */
async function getLocations(clientId) {
    const query = `
    query {
      locations(first: 10) {
        nodes {
          id
          name
          isActive
        }
      }
    }
    `;
    try {
        const result = await executeGraphQL(clientId, query);
        return result.locations.nodes;
    } catch (err) {
        log.error(`Failed to fetch locations for ${clientId}:`, err.message);
        return [];
    }
}

/**
 * Fetches inventory levels for specific product variants across all locations.
 */
async function getInventoryLevels(clientId, variantIds) {
    const query = `
    query getInventory($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          sku
          inventoryItem {
            inventoryLevels(first: 10) {
              nodes {
                available
                location {
                  name
                }
              }
            }
          }
        }
      }
    }
    `;
    try {
        const result = await executeGraphQL(clientId, query, { ids: variantIds });
        return result.nodes;
    } catch (err) {
        log.error(`Failed to fetch inventory for ${clientId}:`, err.message);
        return [];
    }
}

module.exports = {
    executeGraphQL,
    createLoyaltyDiscount,
    getLocations,
    getInventoryLevels,
    /**
     * Phase 25: Search Customer by Phone
     * Fetches detailed customer profile from Shopify using phone number.
     */
    searchCustomerByPhone: async (clientId, phone) => {
        const query = `
        query searchCustomer($query: String!) {
          customers(first: 1, query: $query) {
            nodes {
              id
              firstName
              lastName
              email
              phone
              defaultAddress {
                city
                province
                country
                zip
                address1
              }
            }
          }
        }
        `;
        try {
            // Shopify query syntax for phone search
            const result = await executeGraphQL(clientId, query, { query: `phone:${phone}` });
            return result.customers.nodes[0] || null;
        } catch (err) {
            log.error(`Failed to search customer for ${clientId}:`, err.message);
            return null;
        }
    }
};

