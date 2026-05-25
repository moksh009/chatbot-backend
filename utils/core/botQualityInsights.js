"use strict";

/**
 * Builds prioritized, tenant-specific improvement steps for Bot Quality.
 * No fake drift % or generic competitor text — only what we can infer from counts.
 */

function letterGradeFromScore(score) {
  if (score == null || Number.isNaN(score)) return { letter: "—", tone: "slate" };
  if (score >= 95) return { letter: "S", tone: "emerald" };
  if (score >= 90) return { letter: "A+", tone: "emerald" };
  if (score >= 85) return { letter: "A", tone: "violet" };
  if (score >= 75) return { letter: "B", tone: "amber" };
  if (score >= 60) return { letter: "C", tone: "amber" };
  return { letter: "D", tone: "rose" };
}

/**
 * @param {object} ctx
 * @returns {{ recommendations: object[], summaryLine: string }}
 */
function buildBotQualityRecommendations(ctx) {
  const {
    pendingPhrases = 0,
    activeKb = 0,
    draftKb = 0,
    publishedFlows = 0,
    qualitySample = 0,
    conversations30d = 0,
    dropoffNodes = [],
    corrections = 0,
    intentsDefined = 0,
    intentsCold = 0,
    compositeScore = null,
  } = ctx;

  const recs = [];

  if (pendingPhrases > 0) {
    recs.push({
      priority: 1,
      title: `Resolve ${pendingPhrases} unmatched phrase${pendingPhrases === 1 ? "" : "s"}`,
      body: "Each pending phrase is a real customer message the model did not route confidently. Assigning them to intents is the fastest accuracy win.",
      href: "/intelligence-hub?tab=neural-inbox",
      cta: "Training Inbox",
    });
  }

  if (activeKb === 0) {
    recs.push({
      priority: 2,
      title: "Activate knowledge documents",
      body: "Drafts do not reach WhatsApp or the knowledge test panel. Publish at least one Active document (policy, FAQ, or catalog text) so answers stay grounded.",
      href: "/intelligence-hub?tab=knowledge-base",
      cta: "Knowledge Base",
    });
  } else if (draftKb > 0) {
    recs.push({
      priority: 3,
      title: `${draftKb} draft document${draftKb === 1 ? "" : "s"} not in retrieval`,
      body: "Review drafts, trim noise, then switch status to Active so bots and the KB tester can use them.",
      href: "/intelligence-hub?tab=knowledge-base",
      cta: "Review drafts",
    });
  }

  if (publishedFlows === 0) {
    recs.push({
      priority: 4,
      title: "Publish a WhatsApp flow",
      body: "Without a published journey, drop-off and hand-off metrics stay thin. Connect at least one main flow (welcome, support, or commerce).",
      href: "/flow-builder",
      cta: "Flow Builder",
    });
  }

  if (dropoffNodes?.[0]?.count > 0) {
    const top = dropoffNodes[0];
    recs.push({
      priority: 5,
      title: "Smooth the busiest exit step",
      body: `Many chats end after “${String(top.label || "Unknown step").slice(0, 72)}”. Add a clearer next step, reduce friction, or offer human handoff there.`,
      href: "/flow-builder",
      cta: "Edit flows",
    });
  }

  if (corrections > 5) {
    recs.push({
      priority: 6,
      title: "High training correction volume",
      body: "Frequent corrections usually mean intents or flows disagree with what customers say. Audit the top corrected paths and tighten triggers.",
      href: "/intelligence-hub?tab=intent-engine",
      cta: "Intent Engine",
    });
  }

  if (intentsDefined > 0 && intentsCold > 0) {
    recs.push({
      priority: 7,
      title: `${intentsCold} intent${intentsCold === 1 ? "" : "s"} never fired (7d window)`,
      body: "Add training phrases that match how customers actually write, or merge rare intents to reduce confusion.",
      href: "/intelligence-hub?tab=intent-engine",
      cta: "Tune intents",
    });
  }

  if (qualitySample === 0 && conversations30d > 0) {
    recs.push({
      priority: 8,
      title: "Enable AI quality scores on conversations",
      body: "You have chats in the last 30 days, but none carry `aiQualityScore`. Once your bot pipeline writes scores, this page can grade tone, speed, and accuracy honestly.",
      href: "/intelligence-hub?tab=persona",
      cta: "Persona & engine",
    });
  }

  if (conversations30d === 0) {
    recs.push({
      priority: 9,
      title: "Send real traffic to measure quality",
      body: "No conversations in the last 30 days — open WhatsApp test numbers, run a small pilot, or replay the Intent Simulator to generate signal.",
      href: "/intelligence-hub?tab=intent-sandbox",
      cta: "Intent Simulator",
    });
  }

  if (recs.length === 0) {
    recs.push({
      priority: 99,
      title: "Keep monitoring",
      body: "Signals look healthy for the checks we can see. Revisit after more traffic or when you add new flows.",
      href: "/intelligence-hub?tab=neural-inbox",
      cta: "Training Inbox",
    });
  }

  recs.sort((a, b) => a.priority - b.priority);

  const g = letterGradeFromScore(compositeScore);

  let summaryLine = "";
  if (compositeScore != null) {
    summaryLine = `Score ${Math.round(compositeScore)}/100 reflects ${qualitySample > 0 ? "scored chats" : "automation coverage"} — use the checklist to improve.`;
  } else if (conversations30d === 0) {
    summaryLine = "No conversations in the last 30 days — run traffic or pilots, then work through the steps below.";
  } else if (qualitySample === 0) {
    summaryLine =
      "Chats exist but none carry AI quality scores yet — when your pipeline sets `aiQualityScore`, the radar and grade become fully meaningful.";
  } else {
    summaryLine = "Work through the prioritized steps below to improve reliability and customer experience.";
  }

  return { recommendations: recs, summaryLine, gradeLetter: g.letter, gradeTone: g.tone };
}

module.exports = {
  buildBotQualityRecommendations,
  letterGradeFromScore,
};
