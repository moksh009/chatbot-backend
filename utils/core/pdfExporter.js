const PDFDocument = require("pdfkit");
const logger = require("./logger")("PDFExporter");
const { gatherIntelligenceReportData, formatInr } = require("./intelligenceReportData");

const MARGIN = 48;
const CONTENT_WIDTH = 499; // A4 minus margins

function safeBarPct(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function pageBottom(doc) {
  return doc.page.height - MARGIN - 28;
}

function ensureSpace(doc, y, needed) {
  if (y + needed > pageBottom(doc)) {
    doc.addPage();
    return MARGIN;
  }
  return y;
}

function drawSectionTitle(doc, y, title) {
  y = ensureSpace(doc, y, 36);
  doc.fillColor("#0f172a").fontSize(13).font("Helvetica-Bold").text(title, MARGIN, y);
  doc.rect(MARGIN, y + 18, CONTENT_WIDTH, 1).fill("#e2e8f0");
  return y + 28;
}

function drawFooter(doc) {
  doc
    .fillColor("#94a3b8")
    .fontSize(7)
    .font("Helvetica")
    .text("Confidential · Generated from live workspace metrics · TopEdge AI", MARGIN, doc.page.height - 36, {
      align: "center",
      width: CONTENT_WIDTH,
    });
}

function drawBullet(doc, y, text) {
  const body = String(text || "").trim();
  if (!body) return y;
  const textHeight = doc.heightOfString(body, { width: CONTENT_WIDTH - 22, lineGap: 2 });
  y = ensureSpace(doc, y, textHeight + 10);
  doc.circle(MARGIN + 6, y + 5, 2.5).fill("#7c3aed");
  doc.fillColor("#334155").fontSize(9).font("Helvetica").text(body, MARGIN + 16, y, {
    width: CONTENT_WIDTH - 22,
    lineGap: 2,
  });
  return y + textHeight + 8;
}

function drawKpiRow(doc, y, metrics) {
  y = ensureSpace(doc, y, 68);
  const colW = Math.floor(CONTENT_WIDTH / metrics.length);
  metrics.forEach((m, i) => {
    const x = MARGIN + i * colW;
    doc.roundedRect(x, y, colW - 8, 58, 6).fillAndStroke("#f8fafc", "#e2e8f0");
    doc
      .fillColor("#64748b")
      .fontSize(7)
      .font("Helvetica-Bold")
      .text(m.label.toUpperCase(), x + 10, y + 10, { width: colW - 20 });
    doc.fillColor(m.color).fontSize(15).font("Helvetica-Bold").text(m.value, x + 10, y + 28, {
      width: colW - 20,
    });
  });
  return y + 68;
}

function drawKeyValueGrid(doc, y, rows) {
  y = ensureSpace(doc, y, rows.length * 16 + 8);
  rows.forEach((row) => {
    doc.fillColor("#64748b").fontSize(9).font("Helvetica").text(row.label, MARGIN, y, { width: 170 });
    doc.fillColor("#0f172a").fontSize(9).font("Helvetica-Bold").text(row.value, MARGIN + 175, y, {
      width: CONTENT_WIDTH - 175,
    });
    y += 14;
  });
  return y + 6;
}

/**
 * Generate Intelligence Hub PDF with real tenant metrics.
 */
async function generateDashboardPDF(client, requestData = {}, options = {}) {
  const clientId = client?.clientId;
  let serverPayload = {};
  try {
    serverPayload = await gatherIntelligenceReportData(clientId);
  } catch (e) {
    logger.error("gatherIntelligenceReportData failed", e);
  }

  const merged = {
    ...serverPayload,
    ...(requestData && typeof requestData === "object" ? requestData : {}),
    stats_grid: { ...serverPayload.stats_grid, ...(requestData?.stats_grid || {}) },
    stats: {
      ...serverPayload.stats,
      ...(requestData?.stats || {}),
      dimensions:
        Array.isArray(requestData?.stats?.dimensions) && requestData.stats.dimensions.length > 0
          ? requestData.stats.dimensions
          : serverPayload.stats?.dimensions || [],
    },
    highlights:
      Array.isArray(requestData?.highlights) && requestData.highlights.length > 0
        ? requestData.highlights
        : serverPayload.highlights || serverPayload.insights || [],
  };

  const inr = (n) => formatInr(n);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: MARGIN,
        bufferPages: true,
        info: {
          Title: `TopEdge Intelligence Report - ${merged.meta?.displayName || client?.businessName || clientId}`,
          Author: "TopEdge AI",
        },
      });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      const displayName = merged.meta?.displayName || client?.businessName || clientId || "Workspace";
      const periodLabel = merged.periodLabel || "Last 30 days";
      const today = new Date().toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });

      // Header band
      doc.rect(0, 0, doc.page.width, 118).fill("#0f172a");
      doc.fillColor("#ffffff").fontSize(20).font("Helvetica-Bold").text("TopEdge AI Intelligence", MARGIN, 32);
      doc.fontSize(8).font("Helvetica").fillColor("#cbd5e1").text(`Executive summary · ${today}`, MARGIN, 58);
      doc.fontSize(8).fillColor("#e2e8f0").text(periodLabel, MARGIN, 72);
      doc.fillColor("#ffffff").fontSize(12).font("Helvetica-Bold").text(displayName, MARGIN, 88);
      doc.fontSize(7).font("Helvetica").fillColor("#94a3b8").text(`Workspace: ${clientId || "—"}`, MARGIN, 104);

      let y = 132;
      doc.fillColor("#334155").fontSize(10).font("Helvetica").text(merged.executiveBlurb || "", MARGIN, y, {
        width: CONTENT_WIDTH,
        lineGap: 3,
      });
      y += doc.heightOfString(merged.executiveBlurb || "", { width: CONTENT_WIDTH, lineGap: 3 }) + 16;

      y = drawSectionTitle(doc, y, "Core performance");
      y = drawKpiRow(doc, y, [
        {
          label: "New CRM leads",
          value: String(merged.stats_grid?.leads?.total ?? 0),
          color: "#7c3aed",
        },
        {
          label: "WhatsApp chats",
          value: String(merged.stats_grid?.conversations?.total ?? 0),
          color: "#6366f1",
        },
        {
          label: "Orders",
          value: String(merged.stats_grid?.orders?.count ?? 0),
          color: "#10b981",
        },
        {
          label: "Revenue",
          value: inr(merged.stats_grid?.orders?.revenue || 0),
          color: "#0f172a",
        },
      ]);

      const brain = merged.sections?.aiBrain || {};
      y = drawSectionTitle(doc, y + 4, "AI Brain setup");
      y = drawKeyValueGrid(doc, y, [
        { label: "API provider", value: brain.apiConnected ? brain.provider || "Connected" : "Not connected" },
        { label: "Bot persona", value: brain.personaName || "Default assistant" },
        { label: "Active intent rules", value: String(brain.activeIntents ?? 0) },
        { label: "Knowledge documents", value: String(brain.activeKnowledgeDocs ?? 0) },
        {
          label: "Intent matches (30d)",
          value: String(brain.learningHits ?? merged.stats?.learningHits ?? 0),
        },
        {
          label: "Training inbox items",
          value: String(brain.trainingCases ?? 0),
        },
      ]);

      if (Array.isArray(brain.knowledgeTitles) && brain.knowledgeTitles.length > 0) {
        y = ensureSpace(doc, y, 20);
        doc.fillColor("#64748b").fontSize(8).font("Helvetica").text("Knowledge sources:", MARGIN, y);
        y += 12;
        doc.fillColor("#334155").fontSize(8).font("Helvetica").text(brain.knowledgeTitles.join(" · "), MARGIN, y, {
          width: CONTENT_WIDTH,
          lineGap: 2,
        });
        y += doc.heightOfString(brain.knowledgeTitles.join(" · "), { width: CONTENT_WIDTH }) + 8;
      }

      const dimensions = merged.stats?.dimensions || [];
      y = drawSectionTitle(doc, y + 4, "Conversation quality");
      if (dimensions.length === 0) {
        y = ensureSpace(doc, y, 28);
        doc
          .fillColor("#64748b")
          .fontSize(9)
          .font("Helvetica")
          .text(
            "Not enough scored conversations in this period to show quality bars. As your bot handles more chats, quality metrics will appear here.",
            MARGIN,
            y,
            { width: CONTENT_WIDTH, lineGap: 2 }
          );
        y += doc.heightOfString(
          "Not enough scored conversations in this period to show quality bars. As your bot handles more chats, quality metrics will appear here.",
          { width: CONTENT_WIDTH, lineGap: 2 }
        ) + 8;
      } else {
        dimensions.forEach((d) => {
          const score = safeBarPct(d.score);
          y = ensureSpace(doc, y, 20);
          doc.fillColor("#64748b").fontSize(8).font("Helvetica").text(d.name, MARGIN, y, { width: 150 });
          doc.rect(MARGIN + 160, y + 1, 280, 8).fill("#f1f5f9");
          doc.rect(MARGIN + 160, y + 1, (score / 100) * 280, 8).fill("#7c3aed");
          doc.fillColor("#0f172a").fontSize(8).font("Helvetica-Bold").text(`${score}%`, MARGIN + 450, y);
          y += 16;
        });
      }

      y = drawSectionTitle(doc, y + 4, "Operational highlights");
      const highlights = merged.highlights || [];
      if (!highlights.length) {
        y = ensureSpace(doc, y, 16);
        doc.fillColor("#64748b").fontSize(9).text("No highlights for this period.", MARGIN, y);
        y += 16;
      } else {
        highlights.forEach((line) => {
          y = drawBullet(doc, y, line);
        });
      }

      drawFooter(doc);
      doc.end();
    } catch (error) {
      logger.error("PDF Generation failed", error);
      reject(error);
    }
  });
}

module.exports = {
  generateDashboardPDF,
};
