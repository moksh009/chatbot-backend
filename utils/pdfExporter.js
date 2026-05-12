const PDFDocument = require("pdfkit");
const logger = require("./logger")("PDFExporter");
const { gatherIntelligenceReportData } = require("./intelligenceReportData");

/**
 * Generate dashboard / intelligence PDF with real tenant metrics when possible.
 * @param {object} client — Client lean doc from export route
 * @param {object} requestData — optional overrides from client (merged on top of server data)
 * @param {object} options — { widgetIds, period }
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
    insights:
      Array.isArray(requestData?.insights) && requestData.insights.length > 0
        ? requestData.insights
        : serverPayload.insights || [],
  };

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: 50,
        info: {
          Title: `TopEdge Intelligence Report - ${merged.meta?.displayName || client?.businessName || clientId}`,
          Author: "TopEdge AI",
        },
      });
      const chunks = [];

      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      const displayName = merged.meta?.displayName || client?.businessName || clientId || "Workspace";
      const periodLabel = merged.periodLabel || "Last 30 days (rolling)";

      doc.rect(0, 0, doc.page.width, 150).fill("#0f172a");
      doc.fillColor("#ffffff").fontSize(22).font("Helvetica-Bold").text("TopEdge AI Intelligence", 50, 40);
      doc.fontSize(9).font("Helvetica").text(`EXECUTIVE SUMMARY • ${new Date().toLocaleDateString("en-IN")}`, 50, 72);
      doc.fontSize(9).fillColor("#cbd5e1").text(periodLabel, 50, 86);
      doc.fillColor("#ffffff").fontSize(13).font("Helvetica-Bold").text(displayName, 50, 108);
      doc.fontSize(8).font("Helvetica").fillColor("#e2e8f0").text(`Workspace ID: ${clientId || "—"}`, 50, 128, {
        width: doc.page.width - 100,
      });

      doc.fillColor("#0f172a").fontSize(11).font("Helvetica").text(merged.executiveBlurb || "", 50, 175, {
        width: doc.page.width - 100,
        lineGap: 3,
      });

      let y = 248;
      doc.fontSize(15).font("Helvetica-Bold").text("Core performance (rolling window)", 50, y);
      doc.rect(50, y + 22, doc.page.width - 100, 1).fill("#e2e8f0");

      y += 38;
      const metrics = [
        {
          label: "New CRM leads",
          value: String(merged.stats_grid?.leads?.total ?? 0),
          color: "#7c3aed",
        },
        {
          label: "Attributed orders",
          value: String(merged.stats_grid?.orders?.count ?? 0),
          color: "#10b981",
        },
        {
          label: "Revenue (INR)",
          value: `₹${Number(merged.stats_grid?.orders?.revenue || 0).toLocaleString("en-IN")}`,
          color: "#0f172a",
        },
      ];

      metrics.forEach((m, i) => {
        doc.rect(50 + i * 165, y, 150, 72).fill("#f8fafc");
        doc.fillColor("#64748b").fontSize(7).font("Helvetica-Bold").text(m.label.toUpperCase(), 58 + i * 165, y + 12);
        doc.fillColor(m.color).fontSize(16).font("Helvetica-Bold").text(m.value, 58 + i * 165, y + 34);
      });

      y += 100;
      doc.fillColor("#0f172a").fontSize(15).font("Helvetica-Bold").text("Intelligence signals (DNA)", 50, y);
      doc.rect(50, y + 22, doc.page.width - 100, 1).fill("#e2e8f0");
      y += 40;

      const dimensions = merged.stats?.dimensions || [];
      if (dimensions.length === 0) {
        doc
          .fillColor("#64748b")
          .fontSize(10)
          .font("Helvetica")
          .text(
            "No scored AI conversations in this period — dimension bars are hidden so the report stays honest. Once your bot writes `aiQualityScore` on chats, this section will populate automatically.",
            50,
            y,
            { width: doc.page.width - 100, lineGap: 4 }
          );
        y += 70;
      } else {
        doc.fillColor("#0f172a").fontSize(10).font("Helvetica-Bold").text("Dimension breakdown", 50, y);
        y += 18;
        dimensions.forEach((d) => {
          const score = safeBarPct(d.score);
          doc.fillColor("#64748b").fontSize(9).font("Helvetica").text(d.name, 50, y);
          doc.rect(200, y - 2, 300, 10).fill("#f1f5f9");
          doc.rect(200, y - 2, (score / 100) * 300, 10).fill("#7c3aed");
          doc.fillColor("#0f172a").fontSize(9).font("Helvetica-Bold").text(`${score}%`, 510, y);
          y += 22;
        });
      }

      y = Math.max(y + 24, 420);
      if (y > 480) {
        doc.addPage();
        y = 50;
      }

      doc.fillColor("#0f172a").fontSize(15).font("Helvetica-Bold").text("Operational highlights", 50, y);
      doc.rect(50, y + 22, doc.page.width - 100, 1).fill("#e2e8f0");
      y += 44;

      const insights = merged.insights || [];
      if (!insights.length) {
        doc.fillColor("#64748b").fontSize(10).text("No highlights available for this export.", 50, y);
        y += 24;
      } else {
        insights.forEach((insight) => {
          const text = String(insight || "").trim();
          if (!text) return;
          doc.circle(58, y + 4, 2.5).fill("#7c3aed");
          doc.fillColor("#334155").fontSize(9).font("Helvetica").text(text, 72, y, { width: 455, lineGap: 3 });
          y += Math.min(48, doc.heightOfString(text, { width: 455 }) + 10);
          if (y > doc.page.height - 120) {
            doc.addPage();
            y = 50;
          }
        });
      }

      doc
        .fillColor("#94a3b8")
        .fontSize(7)
        .font("Helvetica")
        .text(
          "Confidential • Generated from live workspace metrics • TopEdge AI",
          50,
          doc.page.height - 42,
          { align: "center", width: doc.page.width - 100 }
        );

      doc.end();
    } catch (error) {
      logger.error("PDF Generation failed", error);
      reject(error);
    }
  });
}

function safeBarPct(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

module.exports = {
  generateDashboardPDF,
};
