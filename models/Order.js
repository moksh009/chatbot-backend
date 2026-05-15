const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
  clientId: { type: String, required: true },
  shopifyOrderId: { type: String },
  orderId: { type: String, required: true },
  orderNumber: { type: String },
  customerName: { type: String },
  name: { type: String },              // Alias of customerName (Shopify compat)
  phone: { type: String },             // Legacy field
  customerPhone: { type: String },     // New standardized field
  email: { type: String },             // Legacy field
  customerEmail: { type: String },     // New standardized field for email automation
  amount: { type: Number },            // Legacy field (not required — totalPrice is used)
  totalPrice: { type: Number },
  /** Raw Shopify Admin REST financial_status (e.g. paid, pending, partially_refunded) */
  financialStatus: { type: String, default: '' },
  /** Raw Shopify fulfillment_status (e.g. fulfilled, partial, unfulfilled) */
  fulfillmentStatus: { type: String, default: '' },
  status: { type: String, default: 'pending' },
  paymentMethod: { type: String },
  storeString: { type: String },
  isCOD: { type: Boolean, default: false },
  /** RTO Protection — COD WhatsApp confirmation */
  isCodConfirmed: { type: Boolean, default: false },
  codConfirmationSentAt: { type: Date },
  codConfirmationRespondedAt: { type: Date },
  codConfirmationDeadlineAt: { type: Date },
  /** pending | confirmed | cancelled */
  codConfirmationResponse: { type: String, default: '' },
  /** Count of courier non-delivery style events (from fulfillment webhooks). */
  deliveryAttempts: { type: Number, default: 0 },
  /** safe | at_risk | returned — operational RTO shielding state */
  rtoStatus: { type: String, enum: ['safe', 'at_risk', 'returned'], default: 'safe' },
  ndrRescueSentAt: { type: Date },
  lastNdrEventAt: { type: Date },
  /** Estimated ₹ attributed to RTO prevention (e.g. fake COD cancel). */
  rtoValueAttributed: { type: Number, default: 0 },
  /** Webhook idempotency: short-lived lock while COD WhatsApp is in flight. */
  codConfirmationProcessingAt: { type: Date },
  /** Webhook idempotency: short-lived lock while NDR template send is in flight. */
  ndrRescueProcessingAt: { type: Date },
  /** Last Shopify cancel API error (COD fake-cancel path). */
  shopifyCancelError: { type: String, default: '' },
  razorpayLinkId: { type: String },
  razorpayUrl: { type: String },
  cashfreeLinkId: { type: String },
  cashfreeUrl: { type: String },
  stripeLinkId: { type: String },
  stripeUrl: { type: String },
  payuLinkId: { type: String },
  payuUrl: { type: String },
  gatewayPaymentId: { type: String }, // Unified generic ID
  gatewayPaymentUrl: { type: String }, // Unified generic URL
  paidViaLink: { type: Boolean, default: false },
  paidAt: { type: Date },
  codNudgeSentAt: { type: Date },
  codNudgeScheduledAt: { type: Date }, 
  codNudgeStatus: { type: String, default: 'none' }, // none, scheduled, sent, failed
  source: { type: String },
  address: { type: String },
  city: { type: String },
  state: { type: String },
  zip: { type: String },
  fulfilledAt: { type: Date },
  trackingUrl: { type: String },
  trackingNumber: { type: String },
  items: [{
    name: String,
    quantity: Number,
    price: Number,
    sku: String,
    image: String,
    productId: String,
    variantId: String,
  }],
  shippingAddress: { type: Object },
  billingAddress: { type: Object },
  createdAt: { type: Date, default: Date.now },
  
  // Phase 25: Track 8 RTO Predictor
  rtoRiskScore: { type: Number, default: 0 },
  rtoRiskLevel: { type: String, enum: ['Low', 'Medium', 'High'], default: 'Low' },

  /** Dedupes identical Shopify webhook bursts (status + tracking fingerprint). */
  lastDispatchSignature: { type: String, default: '' },
});

OrderSchema.index({ orderId: 1, clientId: 1 }, { unique: true });
// Performance indexes for dashboard queries
OrderSchema.index({ clientId: 1, createdAt: -1 });
OrderSchema.index({ clientId: 1, financialStatus: 1 });
OrderSchema.index({ clientId: 1, status: 1 });
OrderSchema.index({ clientId: 1, isCOD: 1 });
OrderSchema.index({ clientId: 1, codConfirmationResponse: 1 });
OrderSchema.index({ phone: 1 });
OrderSchema.index({ clientId: 1, phone: 1 });
OrderSchema.index({ clientId: 1, 'items.productId': 1 });

module.exports = mongoose.model('Order', OrderSchema);