const { generateText } = require("./gemini");

// Meta's known rejection patterns (built from experience)
const RISK_PATTERNS = [
  { pattern: /bit\.ly|tinyurl|goo\.gl|t\.co/i,            risk: 15, reason: "URL shorteners reduce approval rate. Use full URLs." },
  { pattern: /free|FREE/,                                   risk: 10, reason: '"FREE" in caps triggers spam detection. Try "complimentary".' },
  { pattern: /win|winner|selected|congratulations/i,        risk: 12, reason: "Lottery/prize language often rejected. Rephrase as earned reward." },
  { pattern: /click here|click now/i,                       risk: 8,  reason: '"Click here" is flagged. Use specific CTAs like "View your order".' },
  { pattern: /\b(buy now|shop now)\b/i,                    risk: 5,  reason: "Sales pressure language — acceptable but reduces score slightly." },
  { pattern: /\!\s*\!/,                                    risk: 5,  reason: "Multiple exclamation marks look spammy to Meta reviewers." },
  { pattern: /([A-Z]{4,})/,                               risk: 8,  reason: "Excessive caps. Meta prefers sentence case." },
  { pattern: /personal|private|confidential/i,              risk: 7,  reason: "Privacy-related words can trigger closer review." },
  { pattern: /verify|confirm your account|click to verify/i,risk: 10, reason: "Phishing-pattern language. Rewrite to be more specific." },
  { pattern: /limited time|expires|last chance/i,           risk: 3,  reason: "Urgency is fine but used cautiously by Meta reviewers." }
];

const POSITIVE_PATTERNS = [
  { pattern: /{{1}}|{{2}}|{{3}}/,  bonus: 5, reason: "Personalization variables improve approval rate." },
  { pattern: /order|delivery|track/i, bonus: 8, reason: "Transaction/utility language is approved faster." },
  { pattern: /support|help|assist/i,  bonus: 5, reason: "Support language is viewed favorably." }
];

/**
 * Perform rule-based fast scoring.
 */
function getFastScore(templateContent, category) {
  let riskScore    = 0;
  let riskFactors  = [];
  let bonusScore   = 0;
  let bonusFactors = [];

  const text = [
    templateContent.header?.text || "",
    templateContent.body || templateContent.text || "",
    templateContent.footer || ""
  ].join(" ");

  for (const { pattern, risk, reason } of RISK_PATTERNS) {
    if (pattern.test(text)) {
      riskScore += risk;
      riskFactors.push({ type: "risk", points: risk, message: reason });
    }
  }

  for (const { pattern, bonus, reason } of POSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      bonusScore += bonus;
      bonusFactors.push({ type: "bonus", points: bonus, message: reason });
    }
  }

  if (category === "MARKETING") {
    riskScore += 5;
    riskFactors.push({ type: "info", points: 5, message: "Marketing templates face higher scrutiny than Utility templates." });
  }

  const bodyLength = (templateContent.body || templateContent.text || "").length;
  if (bodyLength > 1024) {
    riskScore += 10;
    riskFactors.push({ type: "risk", points: 10, message: `Body is ${bodyLength} chars. Meta recommends under 1024.` });
  }

  const buttons = templateContent.buttons || [];
  if (buttons.length > 3) {
    riskScore += 15;
    riskFactors.push({ type: "risk", points: 15, message: "Max 3 buttons allowed. Your template has more." });
  }

  const baseProb   = category === "UTILITY" ? 90 : 75;
  const finalProb  = Math.min(99, Math.max(10, baseProb - riskScore + bonusScore));

  const rating = finalProb >= 80 ? "high"
               : finalProb >= 60 ? "medium"
               :                   "low";

  return {
    probability: finalProb,
    rating,
    riskFactors:  riskFactors.sort((a, b) => b.points - a.points),
    bonusFactors: bonusFactors.sort((a, b) => b.points - a.points),
    summary: rating === "high"
      ? "This template has a good chance of approval. Minor improvements could push it higher."
      : rating === "medium"
      ? "Moderate approval probability. Address the risk factors below to improve chances."
      : "High rejection risk. Review and address all risk factors before submitting.",
    estimatedReviewTime: category === "UTILITY" ? "30 min – 2 hours" : "2 – 24 hours"
  };
}

async function analyzeWithGeminiAndRewrite(templateContent, category, geminiKey) {
  const text = [
    templateContent.header?.text || "",
    templateContent.body || templateContent.text || "",
    templateContent.footer || ""
  ].join(" \n");

  if (!text.trim()) return null;

  const prompt = `
You are a Meta WhatsApp template reviewer and an expert copywriter. Analyze this template for approval issues and then REWRITE it to ensure approval as a WhatsApp template.

Template text: "${text}"
Category: ${category}

1. Identify issues that Meta reviewers commonly reject, beyond obvious spam words. Wait for: ambiguous intent, potential phishing patterns, unclear CTA, privacy concerns, competitor mentions, inappropriate content.
2. Rewrite the template to fix the identified issues and dramatically increase its likelihood of Meta approval.

CRITICAL RULE:
Preserve all {{1}}, {{2}}, {{3}} variables exactly as they are. Do not change the variable syntax to [Name] or {variable}. If the original text uses {{1}}, the rewritten text MUST use {{1}}.

Return ONLY JSON:
{
  "risks": [
    { "type": "risk", "points": 5, "message": "explanation in 10 words max" }
  ],
  "bonuses": [
    { "type": "bonus", "points": 3, "message": "explanation in 10 words max" }
  ],
  "additionalRisk": 5,
  "additionalBonus": 2,
  "rewrittenText": "The entire rewritten template text here, keeping all {{1}} exact."
}

If no internal issues found: { "risks": [], "bonuses": [], "additionalRisk": 0, "additionalBonus": 0, "rewrittenText": "The entire rewritten template text here..." }`;

  const result = await generateText(prompt, geminiKey, { maxTokens: 800, temperature: 0.2 });
  if (!result) return null;

  try {
    return JSON.parse(result.replace(/\`\`\`json|\`\`\`/g, "").trim());
  } catch {
    return null;
  }
}

module.exports = { getFastScore, analyzeWithGeminiAndRewrite };
