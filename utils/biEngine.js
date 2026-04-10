"use strict";

const mongoose = require("mongoose");
const { platformGenerateJSON, platformGenerateText } = require("./gemini");

// Models
const AdLead = require("../models/AdLead");
const Order = require("../models/Order");
const Appointment = require("../models/Appointment");
const DailyStat = require("../models/DailyStat");
const Conversation = require("../models/Conversation");

/**
 * BI Engine — Phase 28 Track 4
 *
 * Translates natural language questions into database queries and formats the results.
 * 
 * DESIGN CONSTRAINTS (User-Enforced):
 * 1. ObjectId Sanitization: Hex strings merged/parsed into mongoose.Types.ObjectId.
 * 2. Client Isolation: FORCE unshift $match { clientId: ObjectId } at index 0.
 * 3. Execution Safety: .maxTimeMS(5000) on all aggregates.
 * 4. Read-Only: No mutation operations ($out, $merge, etc.) allowed.
 */

const SYSTEM_PROMPT = `
You are a Business Intelligence (BI) Analyst for an AI Chatbot Platform. 
Your goal is to translate a user's natural language question into a structured Mongoose aggregate pipeline.

## DATA SCHEMA OVERVIEW
1. Model: "AdLead" (CRM contacts)
   - fields: { name, phoneNumber, email, leadScore, tags: [string], lastInteraction: Date, commerceEvents: [{ event, amount }] }
2. Model: "Order" (E-commerce sales)
   - fields: { amount: number, status: string, items: [{ name, price, quantity }], createdAt: Date }
3. Model: "Appointment" (Bookings)
   - fields: { service: string, date: string, status: string, revenue: number, createdAt: Date }
4. Model: "DailyStat" (Aggregated daily trends)
   - fields: { date: "YYYY-MM-DD", totalChats, uniqueUsers, revenue, orders, linkClicks }
5. Model: "Conversation" (Chats)
   - fields: { sentiment: "Positive"|"Neutral"|"Negative", tags: [string], updatedAt: Date }

## QUERY PLAN FORMAT
Your output MUST be a JSON object with two keys:
1. "model": One of ["AdLead", "Order", "Appointment", "DailyStat", "Conversation"]
2. "pipeline": An array of Mongoose aggregate stages.

## RULES
- DO NOT filter by "clientId". The system handles this automatically.
- Always use $match as the first stage if filtering by dates or status.
- Use $group for aggregations (sum, avg, count).
- Use $sort and $limit where appropriate (e.g., "Top 5 leads").
- Return ONLY raw JSON. No explanation.

Example Input: "What was my total e-commerce revenue this week?"
Example Output: { "model": "Order", "pipeline": [{ "$match": { "createdAt": { "$gte": "2024-03-01T00:00:00Z" } } }, { "$group": { "_id": null, "total": { "$sum": "$amount" } } }] }
`;

/**
 * Helper to recursively convert 24-character hex strings to ObjectIds
 * to avoid "missing records" in aggregate pipelines.
 */
function sanitizeIds(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeIds(item));
  }

  const newObj = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.match(/^[0-9a-fA-F]{24}$/)) {
      newObj[key] = new mongoose.Types.ObjectId(value);
    } else if (typeof value === 'object') {
      newObj[key] = sanitizeIds(value);
    } else {
      newObj[key] = value;
    }
  }
  return newObj;
}

/**
 * Main BI Engine Processor
 */
async function processBIQuery(clientId, queryText, clientContext) {
  // Step 1: Intent to Query Plan
  const prompt = SYSTEM_PROMPT + `\n\nCurrent Date: ${new Date().toISOString()}.\nQuestion: ${queryText}\nProvide the JSON strictly:`;
  
  let queryPlan = await platformGenerateJSON(prompt);
  
  if (!queryPlan || !queryPlan.model) {
    console.error("[BI Engine] AI failed to return valid JSON model wrapper.");
    throw new Error("AI failed to generate a valid data plan. Try rephrasing.");
  }

  const models = { AdLead, Order, Appointment, DailyStat, Conversation };
  const TargetModel = models[queryPlan.model];
  if (!TargetModel) throw new Error(`Invalid model target: ${queryPlan.model}`);

  // Step 2: Sanitize and Lock Pipeline
  let pipeline = sanitizeIds(queryPlan.pipeline || []);
  
  // FORCE Client Isolation as requested
  pipeline.unshift({ 
    $match: { clientId: new mongoose.Types.ObjectId(clientId) } // Ensure it's correctly cast
  });

  // Step 3: Execute with 5s Kill Switch
  let rawData;
  try {
    rawData = await TargetModel.aggregate(pipeline).option({ maxTimeMS: 5000 });
  } catch (e) {
    console.error("[BI Engine] Execution Error:", e.message);
    throw new Error(`Data extraction failed: ${e.message}`);
  }

  // Step 4: Narrative Generation
  const finalPrompt = `
    Context: You are a BI Assistant.
    User Question: "${queryText}"
    Extract Result: ${JSON.stringify(rawData)}
    
    Instructions:
    1. Provide a concise, clear answer based on the data.
    2. If the data is an empty array, explain that no matching records were found for that criteria.
    3. Use a professional yet helpful tone.
    4. Format numbers clearly (e.g. currency, commas).
  `;

  const narrativeText = await platformGenerateText(finalPrompt);
  
  return {
    answer: narrativeText || "Here is what I found. (Narrative unavailable)",
    data: rawData, // Passing data optionally for frontend visual rendering logic if applicable
    modelUsed: queryPlan.model,
    extractedCount: rawData?.length || 0,
    timestamp: new Date()
  };
}

/**
 * Suggests 3 relevant business questions based on the client's current data volume.
 */
async function generateQuerySuggestions(clientId) {
  const prompt = `
Context: You are a BI Assistant for an AI CRM.
Based on the data we track (Leads, Orders, Appointments, DailyStats), generate 3 diverse natural language questions a business owner should ask to gain insights.
Examples: 
- "Which tags are most common among my VIP customers?"
- "What is the average lead score for users from Meta Ads?"
- "Compare appointment revenue between this month and last month."

Return ONLY a JSON array of strings.
`;

  try {
    const questions = await platformGenerateJSON(prompt);
    if (Array.isArray(questions)) return questions;
    return ["Show my top 5 products", "Total sales today", "Lead growth this month"];
  } catch (e) {
    return ["Show my top 5 products", "Total sales today", "Lead growth this month"];
  }
}

module.exports = { processBIQuery, generateQuerySuggestions };
