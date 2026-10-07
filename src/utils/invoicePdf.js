const PDFDocument = require("pdfkit");

const FONT_LATIN_REGULAR =
  require.resolve("@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff");
const FONT_LATIN_BOLD =
  require.resolve("@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff");

/**
 * Generate a clean, branded A4 Tax Invoice PDF for a subscription payment
 * @param {Object} payment - Prisma SubscriptionPayment record with user info
 * @param {Object} res - Express response stream
 */
async function sendSubscriptionInvoicePdf(res, payment) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 40,
    bufferPages: true,
    autoFirstPage: true,
  });

  doc.registerFont("NotoRegular", FONT_LATIN_REGULAR);
  doc.registerFont("NotoBold", FONT_LATIN_BOLD);

  const chunks = [];
  const pdfBuffer = await new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const invoiceNo = payment.invoiceNumber || payment.orderId;
    const invoiceDate = payment.paidAt
      ? new Date(payment.paidAt).toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : new Date(payment.createdAt).toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
        });

    const user = payment.user || {};
    const userName = user.name || "Subscriber";
    const firmName = user.firmName || "";
    const email = user.email || "";
    const phone = user.contactPhone || "";
    const planName = `${payment.plan} Plan (${payment.billingCycle === "YEARLY" ? "Annual" : "Monthly"})`;

    const pageWidth = doc.page.width;
    const margin = 40;
    const contentWidth = pageWidth - margin * 2;

    // --- Header Top Bar ---
    doc.rect(margin, 40, contentWidth, 4).fill("#0d9488"); // Teal brand line
    doc.y = 54;

    // Company Name / Logo Area
    doc.font("NotoBold").fontSize(20).fillColor("#0f172a");
    doc.text("SAUDA BOOK", margin, doc.y);

    doc.font("NotoRegular").fontSize(9).fillColor("#64748b");
    doc.text("Digital Brokerage Ledger & Management Platform", margin, doc.y + 2);
    doc.text("support@saudabook.co.in • www.saudabook.co.in", margin, doc.y + 2);

    // Invoice Meta (Right Aligned)
    const topY = 54;
    doc.font("NotoBold").fontSize(16).fillColor("#0d9488");
    doc.text("TAX INVOICE", margin, topY, { align: "right", width: contentWidth });

    doc.font("NotoBold").fontSize(9).fillColor("#334155");
    doc.text(`Invoice No: ${invoiceNo}`, margin, topY + 22, { align: "right", width: contentWidth });
    doc.font("NotoRegular").fontSize(9).fillColor("#64748b");
    doc.text(`Date: ${invoiceDate}`, margin, topY + 36, { align: "right", width: contentWidth });
    doc.text(`Status: PAID`, margin, topY + 50, { align: "right", width: contentWidth });

    // Divider Line
    doc.y = 125;
    doc.moveTo(margin, doc.y).lineTo(margin + contentWidth, doc.y).strokeColor("#e2e8f0").stroke();

    // --- Bill To & Payment Info (Two Columns) ---
    doc.y = 140;
    const colWidth = (contentWidth - 20) / 2;

    // Left Column: Bill To
    doc.font("NotoBold").fontSize(10).fillColor("#0d9488").text("BILLED TO", margin, doc.y);
    doc.y += 4;
    doc.font("NotoBold").fontSize(11).fillColor("#0f172a").text(firmName ? `${firmName}` : userName, margin, doc.y);
    if (firmName && userName) {
      doc.font("NotoRegular").fontSize(9).fillColor("#475569").text(`Contact: ${userName}`, margin, doc.y + 2);
    }
    if (email) {
      doc.font("NotoRegular").fontSize(9).fillColor("#475569").text(`Email: ${email}`, margin, doc.y + 2);
    }
    if (phone) {
      doc.font("NotoRegular").fontSize(9).fillColor("#475569").text(`Phone: ${phone}`, margin, doc.y + 2);
    }

    // Right Column: Payment Details
    const rightColX = margin + colWidth + 20;
    doc.font("NotoBold").fontSize(10).fillColor("#0d9488").text("PAYMENT DETAILS", rightColX, 140);
    let rightY = 140 + 14;
    doc.font("NotoRegular").fontSize(9).fillColor("#475569");
    doc.text(`Payment Gateway: Razorpay`, rightColX, rightY);
    rightY += 14;
    if (payment.paymentId) {
      doc.text(`Payment ID: ${payment.paymentId}`, rightColX, rightY);
      rightY += 14;
    }
    if (payment.orderId) {
      doc.text(`Transaction Reference: ${payment.orderId}`, rightColX, rightY);
      rightY += 14;
    }
    doc.text(`Mode: Online (UPI / NetBanking / Cards)`, rightColX, rightY);

    // --- Line Items Table ---
    const tableTop = 230;
    doc.y = tableTop;

    // Header Row
    doc.rect(margin, tableTop, contentWidth, 24).fill("#f8fafc");
    doc.rect(margin, tableTop, contentWidth, 24).strokeColor("#cbd5e1").stroke();

    doc.font("NotoBold").fontSize(9).fillColor("#334155");
    doc.text("ITEM / DESCRIPTION", margin + 12, tableTop + 7);
    doc.text("SAC CODE", margin + 280, tableTop + 7);
    doc.text("CYCLE", margin + 360, tableTop + 7);
    doc.text("AMOUNT (INR)", margin, tableTop + 7, { align: "right", width: contentWidth - 12 });

    // Item Row
    const itemRowY = tableTop + 24;
    doc.rect(margin, itemRowY, contentWidth, 34).strokeColor("#e2e8f0").stroke();

    doc.font("NotoBold").fontSize(9).fillColor("#0f172a");
    doc.text(`Sauda Book SaaS - ${planName}`, margin + 12, itemRowY + 7);
    doc.font("NotoRegular").fontSize(8).fillColor("#64748b");
    doc.text("Cloud Ledger, Brokerage Automation & Order Tracking", margin + 12, itemRowY + 19);

    doc.font("NotoRegular").fontSize(9).fillColor("#475569");
    doc.text("998313", margin + 280, itemRowY + 11);
    doc.text(payment.billingCycle === "YEARLY" ? "Annual" : "Monthly", margin + 360, itemRowY + 11);

    doc.font("NotoBold").fontSize(9).fillColor("#0f172a");
    doc.text(`Rs. ${Number(payment.amount).toFixed(2)}`, margin, itemRowY + 11, {
      align: "right",
      width: contentWidth - 12,
    });

    // Summary Box (Subtotal & Total)
    const summaryTop = itemRowY + 34;
    const summaryWidth = 230;
    const summaryX = margin + contentWidth - summaryWidth;

    let currY = summaryTop + 10;
    doc.font("NotoRegular").fontSize(9).fillColor("#64748b");
    doc.text("Net Taxable Amount:", summaryX, currY);
    doc.text(`Rs. ${Number(payment.amount).toFixed(2)}`, margin, currY, {
      align: "right",
      width: contentWidth - 12,
    });

    currY += 16;
    doc.text("GST / Applicable Taxes:", summaryX, currY);
    doc.text("Inclusive (Rs. 0.00)", margin, currY, {
      align: "right",
      width: contentWidth - 12,
    });

    currY += 18;
    // Highlight Total Box
    doc.rect(summaryX - 10, currY - 6, summaryWidth + 10, 28).fill("#f0fdf4");
    doc.rect(summaryX - 10, currY - 6, summaryWidth + 10, 28).strokeColor("#86efac").stroke();

    doc.font("NotoBold").fontSize(11).fillColor("#15803d");
    doc.text("Total Paid:", summaryX, currY);
    doc.text(`Rs. ${Number(payment.amount).toFixed(2)}`, margin, currY, {
      align: "right",
      width: contentWidth - 12,
    });

    // Notes & Terms
    const notesY = currY + 60;
    doc.font("NotoBold").fontSize(9).fillColor("#0f172a").text("Notes & Terms:", margin, notesY);
    doc.font("NotoRegular").fontSize(8).fillColor("#64748b");
    doc.text(
      "1. This is a computer-generated tax invoice and payment receipt. No physical signature is required.",
      margin,
      notesY + 14
    );
    doc.text(
      "2. Subscription services are activated immediately upon receipt of online payment.",
      margin,
      notesY + 26
    );
    doc.text(
      "3. For queries or billing inquiries, please reach out to support@saudabook.co.in or your account executive.",
      margin,
      notesY + 38
    );

    // Footer
    const footerY = doc.page.height - 65;
    doc.moveTo(margin, footerY).lineTo(margin + contentWidth, footerY).strokeColor("#e2e8f0").stroke();
    doc.font("NotoRegular").fontSize(8).fillColor("#94a3b8");
    doc.text(
      "Thank you for choosing Sauda Book! • Keep your ledger accurate, simple, and connected.",
      margin,
      footerY + 10,
      { align: "center", width: contentWidth, lineBreak: false }
    );

    doc.end();
  });

  const filename = `Invoice-${payment.invoiceNumber || payment.orderId}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.end(pdfBuffer);
}

module.exports = {
  sendSubscriptionInvoicePdf,
};

