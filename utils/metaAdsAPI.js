"use strict";

const axios = require("axios");

const API_VERSION = process.env.META_ADS_API_VERSION || "v18.0";

/**
 * Fetch all active/paused Meta campaigns for a client.
 */
async function fetchMetaCampaigns(client) {
  if (!client.metaAdAccountId || !client.metaAdsToken) {
    throw new Error("Meta Ads not connected. Please connect your Meta Ads account first.");
  }

  const resp = await axios.get(
    `https://graph.facebook.com/${API_VERSION}/${client.metaAdAccountId}/campaigns`,
    {
      params: {
        fields:       "id,name,status,objective,daily_budget,lifetime_budget,created_time,start_time,stop_time",
        access_token: client.metaAdsToken,
        filtering:    JSON.stringify([{ field: "status", operator: "IN", value: ["ACTIVE", "PAUSED"] }]),
        limit:        50
      }
    }
  );
  return resp.data.data || [];
}

/**
 * Fetch all ads within a campaign.
 */
async function fetchCampaignAds(client, campaignId) {
  const resp = await axios.get(
    `https://graph.facebook.com/${API_VERSION}/${campaignId}/ads`,
    {
      params: {
        fields:       "id,name,status,creative{id,name,title,body,image_url,call_to_action},created_time",
        access_token: client.metaAdsToken,
        limit:        50
      }
    }
  );
  return resp.data.data || [];
}

/**
 * Fetch ad performance insights.
 */
async function fetchAdInsights(client, adId, datePreset = "last_30d") {
  const resp = await axios.get(
    `https://graph.facebook.com/${API_VERSION}/${adId}/insights`,
    {
      params: {
        fields:      "impressions,clicks,spend,cpc,ctr,reach,frequency,actions",
        date_preset: datePreset,
        access_token: client.metaAdsToken
      }
    }
  );
  return resp.data.data?.[0] || {};
}

/**
 * Get all ad accounts the user has access to.
 * Called after OAuth grants ads_read permission.
 */
async function getAdAccounts(metaUserToken) {
  const resp = await axios.get(
    `https://graph.facebook.com/${API_VERSION}/me/adaccounts`,
    {
      params: {
        fields:       "id,name,account_status,currency",
        access_token: metaUserToken,
        limit:        20
      }
    }
  );
  return resp.data.data || [];
}

/**
 * Full sync: import all campaigns + ads from Meta, calculate TopEdge stats.
 */
async function syncMetaAds(clientId) {
  const Client  = require("../models/Client");
  const AdLead  = require("../models/AdLead");
  const MetaAd  = require("../models/MetaAd");

  const client = await Client.findOne({ clientId }).lean();
  if (!client || !client.metaAdAccountId || !client.metaAdsToken) {
    console.log(`[MetaAds] Client ${clientId} has no Meta Ads connection — skipping sync`);
    return;
  }

  console.log(`[MetaAds] Starting sync for client ${clientId}`);

  try {
    const campaigns = await fetchMetaCampaigns(client);

    for (const campaign of campaigns) {
      let ads;
      try { ads = await fetchCampaignAds(client, campaign.id); } catch { ads = []; }

      for (const ad of ads) {
        let insights;
        try { insights = await fetchAdInsights(client, ad.id); } catch { insights = {}; }

        // Count TopEdge leads from this ad
        const leadsCount = await AdLead.countDocuments({
          clientId: client._id,
          "adAttribution.adId": ad.id
        });

        // Sum revenue
        const revenueAgg = await AdLead.aggregate([
          { $match: { clientId: client._id, "adAttribution.adId": ad.id } },
          { $group: { _id: null, total: { $sum: "$lifetimeValue" } } }
        ]);
        const revenue = revenueAgg[0]?.total || 0;

        // Count conversions (those who also ordered)
        const ordersCount = await AdLead.countDocuments({
          clientId: client._id,
          "adAttribution.adId": ad.id,
          ordersCount: { $gt: 0 }
        });

        const spend          = parseFloat(insights.spend || 0);
        const roiPercent     = spend > 0 ? parseFloat(((revenue - spend) / spend * 100).toFixed(1)) : 0;
        const costPerLead    = leadsCount > 0 ? parseFloat((spend / leadsCount).toFixed(2)) : 0;
        const conversionRate = leadsCount > 0 ? parseFloat((ordersCount / leadsCount * 100).toFixed(1)) : 0;

        await MetaAd.findOneAndUpdate(
          { clientId: client._id, metaAdId: ad.id },
          {
            $set: {
              metaCampaignId:   campaign.id,
              metaCampaignName: campaign.name,
              adName:           ad.name,
              adStatus:         ad.status,
              creativeTitle:    ad.creative?.title || "",
              creativeBody:     ad.creative?.body  || "",
              creativeImageUrl: ad.creative?.image_url || "",
              callToAction:     ad.creative?.call_to_action?.type || "",
              insights: {
                impressions:  parseInt(insights.impressions || 0),
                clicks:       parseInt(insights.clicks || 0),
                spend,
                cpc:          parseFloat(insights.cpc || 0),
                ctr:          parseFloat(insights.ctr || 0),
                reach:        parseInt(insights.reach || 0),
                lastSyncedAt: new Date()
              },
              topedgeStats: { leadsCount, ordersCount, revenue, conversionRate, costPerLead, roiPercent },
              lastImportedAt: new Date()
            },
            $setOnInsert: { clientId: client._id, createdAt: new Date() }
          },
          { upsert: true }
        );
      }
    }

    console.log(`[MetaAds] Sync complete for client ${clientId}`);
  } catch (err) {
    console.error(`[MetaAds] Sync error for ${clientId}:`, err.message);
  }
}

module.exports = { fetchMetaCampaigns, fetchCampaignAds, fetchAdInsights, getAdAccounts, syncMetaAds };
