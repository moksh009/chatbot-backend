"use strict";

/**
 * PHASE 4: Global SEO & Schema Injection
 * Generates JSON-LD structured data for products, orders, and business info.
 */
function generateProductSchema(product) {
  if (!product || !product.title) return "";

  const schema = {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": product.title,
    "description": product.description || `High quality ${product.title} provided by our store.`,
    "offers": {
      "@type": "Offer",
      "priceCurrency": product.currency || "INR",
      "price": product.price || 0,
      "availability": product.available ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      "url": product.url || ""
    }
  };

  return `<script type="application/ld+json">${JSON.stringify(schema)}</script>`;
}

function generateBusinessSchema(client) {
  if (!client) return "";

  const schema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": client.businessName || "Our Store",
    "url": client.shopDomain ? `https://${client.shopDomain}` : "",
    "logo": client.logoUrl || "",
    "contactPoint": {
      "@type": "ContactPoint",
      "telephone": client.whatsapp?.phoneNumber || "",
      "contactType": "customer service"
    }
  };

  return `<script type="application/ld+json">${JSON.stringify(schema)}</script>`;
}

module.exports = { generateProductSchema, generateBusinessSchema };
