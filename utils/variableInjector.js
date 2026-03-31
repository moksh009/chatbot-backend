"use strict";

const { DateTime } = require('luxon');

/**
 * Enterprise Variable Injector
 * Supports 20+ dynamic variables using a resolver map.
 */
function injectVariables(text, { lead, client, convo, order }) {
  if (!text || typeof text !== 'string') return text;

  // 1. Define Variable Resolvers
  const RESOLVERS = {
    // --- Lead / Customer Variables ---
    'name':           () => lead?.name || 'Customer',
    'first_name':     () => (lead?.name || 'Customer').split(' ')[0],
    'phone':          () => lead?.phoneNumber || convo?.phone || 'N/A',
    'email':          () => lead?.email || 'N/A',
    'city':           () => lead?.city || 'your city',
    'tags':           () => (lead?.tags || []).join(', ') || 'None',
    'score':          () => lead?.score || 0,
    
    // --- Business / Client Variables ---
    'business_name':  () => client?.name || 'our store',
    'business_phone': () => client?.adminPhone || 'our support',
    'store_url':      () => client?.nicheData?.storeUrl || '',
    
    // --- Order / Cart Variables ---
    'order_id':       () => order?.orderId || convo?.metadata?.order_id || 'N/A',
    'order_status':   () => order?.status || convo?.metadata?.order_status || 'Processing',
    'order_total':    () => order?.amount || order?.totalPrice || convo?.metadata?.order_total || 0,
    'tracking_link':  () => order?.trackingUrl || 'Pending',
    'cart_total':     () => lead?.cartValue || convo?.metadata?.cart_total || 0,
    'items_count':    () => (lead?.cartSnapshot?.items?.length) || 0,
    'last_product':   () => lead?.cartSnapshot?.items?.[0]?.title || 'Product',
    
    // --- System / Context Variables ---
    'current_day':    () => DateTime.now().setZone('Asia/Kolkata').toFormat('EEEE'),
    'current_time':   () => DateTime.now().setZone('Asia/Kolkata').toFormat('h:mm a'),
    'agent_name':     () => client?.config?.agentName || 'AI Assistant',
    'greeting':       () => {
      const hour = DateTime.now().setZone('Asia/Kolkata').hour;
      if (hour < 12) return 'Good Morning';
      if (hour < 17) return 'Good Afternoon';
      return 'Good Evening';
    },
    
    // --- Custom Metadata Fallback ---
    'last_input':     () => convo?.metadata?.last_input || '',
  };

  // 2. Perform Replacement
  let result = text;
  
  // Replace standard {{variable}} syntax
  const regex = /\{\{([a-zA-Z0-9_]+)\}\}/g;
  result = result.replace(regex, (match, key) => {
    const resolver = RESOLVERS[key];
    if (resolver) return resolver();
    
    // Fallback to conversation metadata if no resolver exists
    if (convo?.metadata && convo.metadata[key] !== undefined) {
      return convo.metadata[key];
    }
    
    return match; // Return as is if not found
  });

  return result;
}

module.exports = { injectVariables };
