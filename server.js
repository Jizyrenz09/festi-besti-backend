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
const PRODUCT_PRICES = {
  "winter-box": 25,
  "lightning-box": 35,
  "sun-thieves": 30,
  "snuggle-seat": 12,
};

const DELIVERY_FEES = {
  Oakland: 5.0,
  Berkeley: 6.0,
  Emeryville: 6.5,
  Piedmont: 5.5,
  "San Francisco": 12.0,
  Alameda: 6.0,
  "San Leandro": 7.5,
  Albany: 7.0,
  "El Cerrito": 8.0,
  Richmond: 9.0,
};

const D20_PRICE = 20;       // one-time
const INQUISITIVE_DISCOUNT = 10; // one-time flat discount
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
function validateOrder(order) {
  if (!Array.isArray(order.items) || order.items.length === 0) return false;
  if (!Number.isInteger(order.days) || order.days < 1 || order.days > MAX_DAYS) return false;
  if (!order.customer?.email?.includes("@")) return false;

  for (const item of order.items) {
    if (!PRODUCT_PRICES[item.id]) return false;
    if (!Number.isInteger(item.quantity) || item.quantity < 1) return false;
  }

  if (order.deliveryCity && !DELIVERY_FEES[order.deliveryCity]) return false;

  return true;
}




/* ======================
   PRICING ENGINE (BACKEND ONLY)
====================== */
function calculateOrderTotal(order) {
  let subtotal = 0;

  // Product pricing (per day)
  for (const item of order.items) {
    const pricePerDay = PRODUCT_PRICES[item.id];
    subtotal += pricePerDay * item.quantity * order.days;
  }

  // Delivery (one-time)
  const deliveryFee = order.deliveryCity
    ? DELIVERY_FEES[order.deliveryCity]
    : 0;

  // Offers
  let offersTotal = 0;
  if (order.offers?.d20) {
    offersTotal += D20_PRICE;
  }

  // Discounts
  let discountTotal = 0;
  if (order.offers?.inquisitive) {
    discountTotal += INQUISITIVE_DISCOUNT;
  }

  const total = Math.max(subtotal + deliveryFee + offersTotal - discountTotal, 0);

  return {
    subtotal,
    deliveryFee,
    offersTotal,
    discountTotal,
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
    htmlContent: customerEmailTemplate(paymentIntent, order),
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
   EMAIL TEMPLATES (AUTHORITATIVE)
====================== */

function buildInvoiceRows(order) {
  const rows = [];
  const pricing = order.pricing;

  // Product rows
  for (const item of order.items) {
    const pricePerDay = PRODUCT_PRICES[item.id];
    const subtotal = pricePerDay * item.quantity * order.days;

    rows.push(`
      <tr>
        <td>${formatProductName(item.id)}</td>
        <td>$${pricePerDay.toFixed(2)}</td>
        <td>${item.quantity} × ${order.days} days</td>
        <td>$${subtotal.toFixed(2)}</td>
      </tr>
    `);
  }

  // Delivery
  if (pricing.deliveryFee > 0) {
    rows.push(`
      <tr>
        <td>Delivery (${order.deliveryCity})</td>
        <td>-</td>
        <td>-</td>
        <td>$${pricing.deliveryFee.toFixed(2)}</td>
      </tr>
    `);
  }

  // D20 Offer
  if (order.offers?.d20) {
    rows.push(`
      <tr>
        <td>Roll a Crit on a D20</td>
        <td>-</td>
        <td>-</td>
        <td>$${D20_PRICE.toFixed(2)}</td>
      </tr>
    `);
  }

  // Discount
  if (order.offers?.inquisitive) {
    rows.push(`
      <tr>
        <td>Inquisitive Discount</td>
        <td>-</td>
        <td>-</td>
        <td>-$${INQUISITIVE_DISCOUNT.toFixed(2)}</td>
      </tr>
    `);
  }

  return rows.join("");
}

function formatProductName(id) {
  return id
    .split("-")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function customerEmailTemplate(pi, order) {
  const pricing = order.pricing;
  const rows = buildInvoiceRows(order);

  return `
  <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; color: #333; }
        table { border-collapse: collapse; width:100%; margin-top:15px; }
        th, td { border:1px solid #ddd; padding:8px; text-align:left; }
        th { background-color:#f4f4f4; }
        .total { font-weight:bold; font-size:16px; }
      </style>
    </head>
    <body>
      <h2>Payment Received</h2>
      <p>Hi ${order.customer.name || "Customer"},</p>
      <p>Thank you for your rental booking.</p>

      <p><strong>Rental Duration:</strong> ${order.days} day(s)</p>
      <p><strong>Delivery City:</strong> ${order.deliveryCity || "Pickup"}</p>

      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Rate</th>
            <th>Details</th>
            <th>Subtotal</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>

      <p><strong>Subtotal:</strong> $${pricing.subtotal.toFixed(2)}</p>
      <p><strong>Delivery:</strong> $${pricing.deliveryFee.toFixed(2)}</p>
      <p><strong>Offers:</strong> $${pricing.offersTotal.toFixed(2)}</p>
      <p><strong>Discounts:</strong> -$${pricing.discountTotal.toFixed(2)}</p>

      <p class="total">Total Paid: $${(pi.amount / 100).toFixed(2)}</p>

      <p><strong>Payment ID:</strong> ${pi.id}</p>
      <hr/>
      <p>If you have any questions, reply to this email.</p>
    </body>
  </html>
  `;
}

function adminEmailTemplate(pi, order) {
  return customerEmailTemplate(pi, order);
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














