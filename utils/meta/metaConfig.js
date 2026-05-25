/**
 * Meta Graph API Configuration — Single Source of Truth
 * ─────────────────────────────────────────────────────
 * ALL files must import the API version from here.
 * Never hardcode v18.0, v19.0, etc. directly in route/utility files.
 *
 * v18.0 — EXPIRED January 26, 2026
 * v19.0 — Expires May 21, 2026
 * v20.0 — Expires September 24, 2026
 * v21.0 — Stable (released Oct 2, 2024)
 * v25.0 — Latest (released Feb 18, 2026)
 *
 * We target v21.0 as a safe, well-tested version with long support.
 */

const GRAPH_API_VERSION = process.env.API_VERSION || 'v21.0';
const META_ADS_API_VERSION = process.env.META_ADS_API_VERSION || 'v21.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

module.exports = {
  GRAPH_API_VERSION,
  META_ADS_API_VERSION,
  GRAPH_BASE_URL,
};
