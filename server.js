require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();

/* ======================
   GLOBAL MIDDLEWARE
====================== */
app.use(cors({ origin: "http://yourfestibesti.com" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ======================
   BREVO EMAIL SENDER
====================== */
async function sendBrevoEmail(payload) {
  try {
    const res = await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      payload,
      {
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 10000,
      }
    );
    console.log("📨 Brevo email sent:", payload.subject);
    return res.data;
  } catch (err) {
    console.error(
      `❌ Brevo email failed:`,
      err.response?.data || err.message
    );
    throw err;
  }
}

/* ======================
   STARTUP CHECKS
====================== */
async function startupChecks() {
  console.log("\n=== STARTUP CHECKS ===");
  console.log(process.env.STRIPE_SECRET_KEY ? "✅ Stripe key loaded" : "❌ Stripe key missing!");
  console.log(process.env.BREVO_API_KEY ? "✅ Brevo key loaded" : "❌ Brevo API key missing!");
  console.log(process.env.BREVO_SENDER ? "✅ Brevo sender loaded" : "❌ Brevo sender missing!");
  console.log(process.env.ADMIN_EMAIL ? "✅ Admin email loaded" : "❌ Admin email missing!");
  console.log(process.env.STRIPE_WEBHOOK_SECRET ? "✅ Stripe webhook secret loaded" : "❌ Stripe webhook secret missing!");
  console.log("======================\n");
}

/* ======================
   TEST EMAIL ENDPOINT
====================== */
app.get("/test-email", async (req, res) => {
  try {
    await sendBrevoEmail({
      sender: { email: process.env.BREVO_SENDER, name: "Festi Besti" },
      to: [{ email: process.env.ADMIN_EMAIL, name: "Admin" }],
      subject: "Brevo Test Email",
      htmlContent: "<p>If you see this, Brevo is working ✅</p>",
    });
    res.send("✅ Test email sent");
  } catch {
    res.status(500).send("❌ Test email failed (check API key or sender)");
  }
});

/* ======================
   ORDER VALIDATION
====================== */
function validateOrderPayload(body) {
  const { selections, days, customer } = body;
  if (!Array.isArray(selections) || !selections.length) return false;
  if (!Number.isInteger(days) || days < 1 || days > 30) return false;
  if (!customer?.email || !customer.email.includes("@")) return false;
  return true;
}

/* ======================
   PAYMENT INTENT
====================== */
app.post("/create-payment-intent", async (req, res) => {
  try {
    if (!validateOrderPayload(req.body))
      return res.status(400).json({ error: "Invalid order data" });

    const { selections, days, customer } = req.body;
    const amount = calculateTotal(selections, days);

    const intent = await stripe.paymentIntents.create(
      {
        amount,
        currency: "usd",
        receipt_email: customer.email,
        automatic_payment_methods: { enabled: true },
        metadata: { order: JSON.stringify(req.body) },
      },
      { idempotencyKey: crypto.randomUUID() }
    );

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error("PaymentIntent error:", err.message);
    res.status(500).json({ error: "Payment processing failed" });
  }
});

/* ======================
   HANDLE PAYMENT SUCCESS (DEBUG VERSION)
====================== */
async function handleSuccessfulPayment(paymentIntent) {
  const order = JSON.parse(paymentIntent.metadata.order || "{}");
  const customer = order.customer || {};
  const sender = { email: process.env.BREVO_SENDER, name: "Festi Besti" };

  console.log("📧 Sending emails for paymentIntent:", paymentIntent.id);
  console.log("👤 Customer info:", customer);

  if (!customer.email) {
    throw new Error("Customer email missing");
  }

  try {
    console.log("✉️ Sending email to customer:", customer.email);
    const customerRes = await sendBrevoEmail({
      sender,
      to: [{ email: customer.email, name: customer.name }],
      subject: "Payment Received – Your Rental Invoice",
      htmlContent: customerEmailTemplate(paymentIntent, order, customer),
    });
    console.log("✅ Customer email response:", customerRes);
  } catch (err) {
    console.error("❌ Customer email failed:", err.response?.data || err.message);
  }

  try {
    console.log("✉️ Sending email to admin:", process.env.ADMIN_EMAIL);
    const adminRes = await sendBrevoEmail({
      sender,
      to: [{ email: process.env.ADMIN_EMAIL, name: "Admin" }],
      subject: "New Paid Order",
      htmlContent: adminEmailTemplate(paymentIntent, order, customer),
    });
    console.log("✅ Admin email response:", adminRes);
  } catch (err) {
    console.error("❌ Admin email failed:", err.response?.data || err.message);
  }

  console.log(`📌 Emails finished for payment ${paymentIntent.id}`);
}

/* ======================
   STRIPE WEBHOOK (DEBUG VERSION)
====================== */
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  console.log("🔔 Webhook received:", req.headers);

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log("✅ Webhook signature verified:", event.type);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object;
    console.log("💰 PaymentIntent succeeded:", paymentIntent.id);
    console.log("📄 Metadata:", paymentIntent.metadata);

    // Check that metadata exists and is parsable
    let orderData;
    try {
      orderData = JSON.parse(paymentIntent.metadata.order || "{}");
      console.log("📦 Order data parsed:", orderData);
    } catch (err) {
      console.error("❌ Failed to parse order metadata:", err.message);
      return res.status(400).send("Invalid metadata JSON");
    }

    // Check customer email
    if (!orderData.customer?.email) {
      console.error("❌ Customer email missing in metadata:", orderData.customer);
      return res.status(400).send("Customer email missing");
    }

    try {
      await handleSuccessfulPayment(paymentIntent);
      console.log("✅ handleSuccessfulPayment completed");
    } catch (err) {
      console.error("❌ Error in handleSuccessfulPayment:", err.response?.data || err.message);
      return res.status(500).send("Internal server error");
    }
  } else {
    console.log("ℹ️ Event ignored (not payment_intent.succeeded):", event.type);
  }

  res.json({ received: true });
});

/* ======================
   PRICING LOGIC
====================== */
function calculateTotal(items, days) {
  return Math.max(
    items.reduce((sum, item) => sum + calculateItemPrice(item) * getMultiplier(item, days), 0) * 100,
    0
  );
}
function calculateItemPrice(item) {
  const pricing = { "Lightning Box": 35, "Winter Box": 25, "Sun Thieves": 30, "Snuggle Seat": 12 };
  const lower = item.toLowerCase();
  let price = 0;
  const key = Object.keys(pricing).find((p) => lower.includes(p.toLowerCase()));
  if (key) price += pricing[key];
  if (lower.includes("delivery")) price += 6;
  if (lower.includes("d20")) price += 20;
  if (lower.includes("inquisitive")) price -= 10;
  return price;
}
function getMultiplier(item, days) {
  const lower = item.toLowerCase();
  if (lower.includes("delivery") || lower.includes("d20") || lower.includes("inquisitive")) return 1;
  return days;
}











/* ======================
   EMAIL TEMPLATES (EXACT LIKE WEBSITE INVOICE)
====================== */
function generateRows(order) {
  const rows = [];
  const days = order.days || 1;

  order.selections.forEach((item) => {
    const lower = item.toLowerCase();
    let subtotal;
    let rate;

    if (lower.includes("delivery")) {
      rate = "";
      subtotal = "$" + calculateItemPrice(item, 1).toFixed(2); // pass 1 day for one-time
    } else if (lower.includes("d20")) {
      rate = "";
      subtotal = "$" + calculateItemPrice(item, 1).toFixed(2); // pass 1 day for one-time
    } else if (lower.includes("inquisitive")) {
      rate = "";
      subtotal = "-$" + Math.abs(calculateItemPrice(item, 1)).toFixed(2);
    } else {
      rate = "$" + calculateItemPrice(item, 1).toFixed(2);
      subtotal = "$" + (calculateItemPrice(item) * days).toFixed(2);
    }

    rows.push(`
      <tr>
        <td style="padding:5px 10px;border:1px solid #ddd;">${item}</td>
        <td style="padding:5px 10px;border:1px solid #ddd;">${rate}</td>
        <td>${lower.includes("delivery") || lower.includes("d20") || lower.includes("inquisitive") ? "-" : days}</td>
        <td style="padding:5px 10px;border:1px solid #ddd;">${subtotal}</td>
      </tr>
    `);
  });

  return rows.join("");
}

function customerEmailTemplate(pi, order, customer) {
  const totalAmount = (pi.amount / 100).toFixed(2);
  const rows = generateRows(order);

  return `
  <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; color: #333; line-height:1.4; }
        table { border-collapse: collapse; width:100%; margin-top:10px; }
        th, td { border:1px solid #ddd; padding:8px; text-align:left; }
        th { background-color: #f4f4f4; }
        .total { font-weight:bold; font-size:1.1em; }
      </style>
    </head>
    <body>
      <h2>Thank you for your payment, ${customer.name}!</h2>
      <p>Your rental invoice details:</p>

      <h3>Rental Dates</h3>
      <p>${order.startDate} → ${order.endDate} (${order.days} days)</p>

      <h3>Items & Charges</h3>
      <table>
        <thead>
          <tr><th>Item</th><th>Rate</th><th>Days</th><th>Subtotal</th></tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>

      <p class="total">Total Paid: $${totalAmount}</p>
      <p><strong>Payment ID:</strong> ${pi.id}</p>
      <hr>
      <p>Questions? Reply to this email.</p>
    </body>
  </html>
  `;
}

function adminEmailTemplate(pi, order, customer) {
  const totalAmount = (pi.amount / 100).toFixed(2);
  const rows = generateRows(order);

  return `
  <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; color: #333; line-height:1.4; }
        table { border-collapse: collapse; width:100%; margin-top:10px; }
        th, td { border:1px solid #ddd; padding:8px; text-align:left; }
        th { background-color: #f4f4f4; }
        .total { font-weight:bold; font-size:1.1em; }
      </style>
    </head>
    <body>
      <h2>New Paid Order</h2>
      <p><strong>Customer:</strong> ${customer.name}</p>
      <p><strong>Email:</strong> ${customer.email}</p>
      <p><strong>Phone:</strong> ${customer.phone || "N/A"}</p>
      <p><strong>Rental Dates:</strong> ${order.startDate} → ${order.endDate} (${order.days} days)</p>

      <h3>Items & Charges</h3>
      <table>
        <thead>
          <tr><th>Item</th><th>Rate</th><th>Days</th><th>Subtotal</th></tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>

      <p class="total">Total Paid: $${totalAmount}</p>
      <p><strong>Payment ID:</strong> ${pi.id}</p>
    </body>
  </html>
  `;
}










/* ======================
   HEALTH CHECK
====================== */
app.get("/", (req, res) => res.send("Server running (Stripe + Brevo TEST MODE)"));

/* ======================
   START SERVER
====================== */
const PORT = process.env.PORT || 4242;
app.listen(PORT, async () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  await startupChecks();
});







