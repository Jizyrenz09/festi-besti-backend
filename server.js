require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();

/* ======================
   GLOBAL LOGS / CHECKERS
====================== */
let lastWebhook = null;
let lastEmailLog = null;

/* ======================
   PRICE CONFIG (SINGLE SOURCE OF TRUTH)
====================== */
const PRICE_CATALOG = {
  "lightning-box": 35,
  "winter-box": 25,
  "sun-thieves": 30,
  "snuggle-seat": 12,
};

const DISCOUNTS = {
  MAP10: { type: "percent", value: 10 },
  VIP50: { type: "flat", value: 50 },
};

const DELIVERY_FEE = 6;
const MAX_DAYS = 30;

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

    lastEmailLog = {
      time: new Date().toISOString(),
      subject: payload.subject,
      to: payload.to.map(t => t.email),
    };

    return res.data;
  } catch (err) {
    lastEmailLog = {
      time: new Date().toISOString(),
      error: err.response?.data || err.message,
    };
    throw err;
  }
}

/* ======================
   STARTUP CHECKS (DO NOT REMOVE)
====================== */
async function startupChecks() {
  console.log("\n=== STARTUP CHECKS ===");
  console.log(process.env.STRIPE_SECRET_KEY ? "✅ Stripe key loaded" : "❌ Stripe key missing!");
  console.log(process.env.BREVO_API_KEY ? "✅ Brevo key loaded" : "❌ Brevo key missing!");
  console.log(process.env.BREVO_SENDER ? "✅ Brevo sender loaded" : "❌ Brevo sender missing!");
  console.log(process.env.ADMIN_EMAIL ? "✅ Admin email loaded" : "❌ Admin email missing!");
  console.log(process.env.STRIPE_WEBHOOK_SECRET ? "✅ Stripe webhook secret loaded" : "❌ Stripe webhook secret missing!");
  console.log("======================\n");
}

/* ======================
   ORDER VALIDATION (STRICT)
====================== */
function validateOrder(body) {
  if (!Array.isArray(body.items) || !body.items.length) return false;
  if (!Number.isInteger(body.days) || body.days < 1 || body.days > MAX_DAYS) return false;
  if (!body.customer?.email?.includes("@")) return false;

  for (const item of body.items) {
    if (!PRICE_CATALOG[item.id]) return false;
    if (!Number.isInteger(item.quantity) || item.quantity < 1) return false;
  }

  return true;
}

/* ======================
   PRICING ENGINE (BACKEND ONLY)
====================== */
function calculateOrderTotal(order) {
  let subtotal = 0;

  for (const item of order.items) {
    const pricePerDay = PRICE_CATALOG[item.id];
    subtotal += pricePerDay * item.quantity * order.days;
  }

  let discountTotal = 0;
  for (const d of order.discounts || []) {
    const def = DISCOUNTS[d.code];
    if (!def) continue;

    if (def.type === "percent") {
      discountTotal += subtotal * (def.value / 100);
    } else {
      discountTotal += def.value;
    }
  }

  const delivery = order.delivery?.enabled ? DELIVERY_FEE : 0;
  const total = Math.max(subtotal - discountTotal + delivery, 0);

  return {
    subtotal,
    discountTotal,
    delivery,
    total,
    amountCents: Math.round(total * 100),
  };
}

/* ======================
   STRIPE WEBHOOK
====================== */
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    lastWebhook = { time: new Date().toISOString(), type: event.type };
  } catch (err) {
    lastWebhook = { time: new Date().toISOString(), error: err.message };
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "payment_intent.succeeded") {
    try {
      await handleSuccessfulPayment(event.data.object);
    } catch {}
  }

  res.json({ received: true });
});

/* ======================
   GLOBAL MIDDLEWARE
====================== */
app.use(cors({ origin: "http://yourfestibesti.com" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ======================
   CREATE PAYMENT INTENT (AUTHORITATIVE)
====================== */
app.post("/create-payment-intent", async (req, res) => {
  if (!validateOrder(req.body)) {
    console.error("❌ Invalid order payload:", req.body);
    return res.status(400).json({ error: "Invalid order payload" });
  }

  const pricing = calculateOrderTotal(req.body);

  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: pricing.amountCents,
        currency: "usd",
        receipt_email: req.body.customer.email,
        automatic_payment_methods: { enabled: true },
        metadata: {
          order: JSON.stringify({
            ...req.body,
            pricing,
          }),
        },
      },
      { idempotencyKey: crypto.randomUUID() }
    );

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error("Stripe error:", err.message);
    res.status(500).json({ error: "Stripe failure" });
  }
});

/* ======================
   HANDLE SUCCESSFUL PAYMENT
====================== */
async function handleSuccessfulPayment(paymentIntent) {
  const order = JSON.parse(paymentIntent.metadata.order || "{}");
  if (!order.customer?.email) return;

  await sendBrevoEmail({
    sender: { email: process.env.BREVO_SENDER, name: "Festi Besti" },
    to: [{ email: order.customer.email, name: order.customer.name }],
    subject: "Payment Successful – Festi Besti",
    htmlContent: `
      <h2>Payment Received</h2>
      <p>Total Paid: <strong>$${(paymentIntent.amount / 100).toFixed(2)}</strong></p>
      <p>Thank you for your order.</p>
    `,
  });
}

/* ======================
   TEST EMAIL
====================== */
app.get("/test-email", async (req, res) => {
  try {
    await sendBrevoEmail({
      sender: { email: process.env.BREVO_SENDER, name: "Festi Besti" },
      to: [{ email: process.env.ADMIN_EMAIL, name: "Admin" }],
      subject: "Brevo Test Email",
      htmlContent: "<p>If you see this, Brevo is working ✅</p>",
    });
    res.json({ message: "✅ Test email sent" });
  } catch {
    res.status(500).json({ error: "❌ Test email failed" });
  }
});

/* ======================
   HEALTH CHECK
====================== */
app.get("/webhook-health", (req, res) => {
  res.json({
    status: "ok",
    lastWebhook,
    lastEmailLog,
    timestamp: new Date().toISOString(),
  });
});



































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











