// backend/src/modules/ai/ai.report.js
//
// Feature 13 — Monthly Financial Report (PDF)
// Generates a downloadable PDF: summary numbers + AI insights + category breakdown
//
const PDFDocument = require('pdfkit');
const { generateOnce, parseJson } = require('./ai.engine');

// ─── Brand colours ────────────────────────────────────────────────────────────
const COLORS = {
  primary:    '#6C63FF',  // WealthFlux purple
  dark:       '#1A1A2E',
  text:       '#2D2D3A',
  muted:      '#6B7280',
  success:    '#10B981',
  danger:     '#EF4444',
  warning:    '#F59E0B',
  border:     '#E5E7EB',
  white:      '#FFFFFF',
  lightBg:    '#F9FAFB',
};

// ─── Helper: format PKR amounts ───────────────────────────────────────────────
function fmt(amount, currency = 'Rs.') {
  return `${currency} ${Number(amount || 0).toLocaleString('en-PK')}`;
}

// ─── Helper: month name from YYYY-MM string ───────────────────────────────────
function monthLabel(yyyyMm) {
  if (!yyyyMm) return 'This Month';
  const [y, m] = yyyyMm.split('-');
  const date   = new Date(Number(y), Number(m) - 1, 1);
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * Ask Ollama for a short qualitative summary paragraph for the report.
 */
async function generateReportNarrative({ income, expenses, savings, savingsRate, topCategory }) {
  const prompt = `
You are WealthFlux's report engine. Write a 3-sentence financial summary paragraph for a monthly PDF report.

Financial Data:
- Total Income: Rs. ${income}
- Total Expenses: Rs. ${expenses}
- Net Savings: Rs. ${savings}
- Savings Rate: ${savingsRate}%
- Biggest Expense Category: ${topCategory || 'N/A'}

Be concise, data-driven, and encouraging. Do NOT use bullet points. Plain paragraph only.
`;
  try {
    return await generateOnce(prompt, { temperature: 0.4, num_predict: 200 });
  } catch {
    return 'Your monthly financial summary is presented below. Review your category breakdown to identify areas for improvement and track progress toward your savings goals.';
  }
}

/**
 * generateReport({ month, income, expenses, budgets, categoryBreakdown, insights, currency })
 *
 * Returns a Buffer containing a complete PDF document.
 * Stream this directly to res in the controller.
 *
 * @param {string}   month            - 'YYYY-MM' string
 * @param {number}   income           - total income this month
 * @param {number}   expenses         - total expenses this month
 * @param {Array}    categoryBreakdown - [{ name, total, percentage }]
 * @param {Array}    insights          - [{ type, text }] from analyzeService
 * @param {number}   budgetHealthScore
 * @param {string}   currency          - 'Rs.' default
 * @param {string}   userName
 */
async function generateReport({
  month,
  income        = 0,
  expenses      = 0,
  categoryBreakdown = [],
  insights      = [],
  budgetHealthScore = 0,
  currency      = 'Rs.',
  userName      = 'User',
}) {
  const savings     = income - expenses;
  const savingsRate = income > 0 ? ((savings / income) * 100).toFixed(1) : 0;
  const topCategory = categoryBreakdown[0]?.name ?? null;

  // Fetch AI narrative in parallel with PDF construction
  const narrative = await generateReportNarrative({ income, expenses, savings, savingsRate, topCategory });

  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];

    doc.on('data',  (chunk) => chunks.push(chunk));
    doc.on('end',   ()      => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 100; // usable width (50px margin each side)

    // ── HEADER BANNER ────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 90).fill(COLORS.primary);

    doc.fillColor(COLORS.white)
       .fontSize(22).font('Helvetica-Bold')
       .text('WealthFlux', 50, 20);

    doc.fontSize(11).font('Helvetica')
       .text(`Monthly Financial Report — ${monthLabel(month)}`, 50, 48);

    doc.fontSize(9)
       .text(`Prepared for: ${userName}  |  Generated: ${new Date().toLocaleDateString('en-PK')}`, 50, 65);

    doc.moveDown(3);

    // ── SUMMARY CARDS ROW ────────────────────────────────────────────────────
    const cardY   = 110;
    const cardW   = (W - 20) / 3;  // 3 equal cards with 10px gaps
    const cards   = [
      { label: 'Total Income',   value: fmt(income,   currency), color: COLORS.success },
      { label: 'Total Expenses', value: fmt(expenses, currency), color: COLORS.danger  },
      { label: 'Net Savings',    value: fmt(savings,  currency), color: savings >= 0 ? COLORS.success : COLORS.danger },
    ];

    cards.forEach((card, i) => {
      const x = 50 + i * (cardW + 10);
      doc.rect(x, cardY, cardW, 60).fillAndStroke(COLORS.lightBg, COLORS.border);
      doc.rect(x, cardY, 4, 60).fill(card.color);
      doc.fillColor(COLORS.muted).fontSize(8).font('Helvetica')
         .text(card.label, x + 12, cardY + 10, { width: cardW - 15 });
      doc.fillColor(COLORS.text).fontSize(13).font('Helvetica-Bold')
         .text(card.value, x + 12, cardY + 28, { width: cardW - 15 });
    });

    // ── BUDGET HEALTH SCORE ───────────────────────────────────────────────────
    const scoreY = cardY + 80;
    doc.rect(50, scoreY, W, 44).fillAndStroke(COLORS.lightBg, COLORS.border);

    const scoreColor = budgetHealthScore >= 80 ? COLORS.success
                     : budgetHealthScore >= 50 ? COLORS.warning
                     : COLORS.danger;

    doc.fillColor(COLORS.muted).fontSize(9).font('Helvetica')
       .text('Budget Health Score', 62, scoreY + 8);
    doc.fillColor(scoreColor).fontSize(18).font('Helvetica-Bold')
       .text(`${budgetHealthScore}/100`, 62, scoreY + 20);

    // Savings rate badge
    doc.fillColor(COLORS.muted).fontSize(9).font('Helvetica')
       .text(`Savings Rate: ${savingsRate}%`, 200, scoreY + 20);

    // ── AI NARRATIVE ──────────────────────────────────────────────────────────
    const narrativeY = scoreY + 64;
    doc.fillColor(COLORS.primary).fontSize(11).font('Helvetica-Bold')
       .text('AI Financial Summary', 50, narrativeY);

    doc.moveTo(50, narrativeY + 16).lineTo(50 + W, narrativeY + 16)
       .strokeColor(COLORS.border).lineWidth(1).stroke();

    doc.fillColor(COLORS.text).fontSize(9.5).font('Helvetica')
       .text(narrative, 50, narrativeY + 24, { width: W, lineGap: 4 });

    // ── CATEGORY BREAKDOWN ────────────────────────────────────────────────────
    const breakY = narrativeY + 90;
    doc.fillColor(COLORS.primary).fontSize(11).font('Helvetica-Bold')
       .text('Expense Breakdown by Category', 50, breakY);

    doc.moveTo(50, breakY + 16).lineTo(50 + W, breakY + 16)
       .strokeColor(COLORS.border).lineWidth(1).stroke();

    if (categoryBreakdown.length === 0) {
      doc.fillColor(COLORS.muted).fontSize(9).font('Helvetica')
         .text('No expense data available for this period.', 50, breakY + 28);
    } else {
      const maxBarW = W - 160;
      categoryBreakdown.slice(0, 10).forEach((cat, idx) => {
        const rowY   = breakY + 28 + idx * 24;
        const pct    = Math.min(cat.percentage ?? 0, 100);
        const barW   = (pct / 100) * maxBarW;
        const hue    = (idx * 47) % 360;
        const barClr = `hsl(${hue}, 65%, 52%)`;

        // Category name
        doc.fillColor(COLORS.text).fontSize(9).font('Helvetica')
           .text(cat.name, 50, rowY + 2, { width: 110, ellipsis: true });

        // Bar background
        doc.rect(165, rowY + 2, maxBarW, 12).fill(COLORS.border);
        // Filled bar
        if (barW > 0) doc.rect(165, rowY + 2, barW, 12).fill(barClr);

        // Amount + percentage
        doc.fillColor(COLORS.text).fontSize(8).font('Helvetica')
           .text(`${fmt(cat.total, currency)}  (${pct.toFixed(1)}%)`,
                 165 + maxBarW + 8, rowY + 2);
      });
    }

    // ── AI INSIGHTS ───────────────────────────────────────────────────────────
    const insightStartY = breakY + 30 + Math.max(categoryBreakdown.length, 1) * 24 + 20;

    if (insightStartY + 80 > doc.page.height - 80) {
      doc.addPage();
    }

    const insY = insightStartY < doc.page.height - 200 ? insightStartY : 60;

    doc.fillColor(COLORS.primary).fontSize(11).font('Helvetica-Bold')
       .text('AI Insights', 50, insY);

    doc.moveTo(50, insY + 16).lineTo(50 + W, insY + 16)
       .strokeColor(COLORS.border).lineWidth(1).stroke();

    const insightColors = { warning: COLORS.warning, danger: COLORS.danger, success: COLORS.success };
    const insightIcons  = { warning: '⚠', danger: '🔴', success: '✓' };

    insights.slice(0, 5).forEach((ins, idx) => {
      const iy    = insY + 28 + idx * 32;
      const clr   = insightColors[ins.type] ?? COLORS.muted;
      const icon  = insightIcons[ins.type]  ?? '•';

      doc.rect(50, iy, 3, 20).fill(clr);
      doc.fillColor(clr).fontSize(9).font('Helvetica-Bold')
         .text(icon, 60, iy + 2);
      doc.fillColor(COLORS.text).fontSize(9).font('Helvetica')
         .text(ins.text, 76, iy + 2, { width: W - 30, lineGap: 2 });
    });

    // ── FOOTER ────────────────────────────────────────────────────────────────
    const footerY = doc.page.height - 45;
    doc.rect(0, footerY, doc.page.width, 45).fill(COLORS.dark);
    doc.fillColor(COLORS.white).fontSize(8).font('Helvetica')
       .text('WealthFlux · AI-powered personal finance', 50, footerY + 14,
             { align: 'center', width: doc.page.width - 100 });
    doc.fillColor(COLORS.muted).fontSize(7)
       .text('This report is auto-generated and for informational purposes only.',
             50, footerY + 26, { align: 'center', width: doc.page.width - 100 });

    doc.end();
  });
}

module.exports = { generateReport };