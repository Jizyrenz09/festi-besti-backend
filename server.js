require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const axios = require("axios");

const app = express();

/* ======================
   GLOBAL MIDDLEWARE
====================== */
app.use(cors({ origin: "http://yourfestibesti.com" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ======================
   BREVO EMAIL
====================== */
async function sendBrevoEmail(payload) {
  return axios.post(
    "https://api.brevo.com/v3/smtp/email",
    payload,
    {
      headers: {
        "api-key": process.env.BREVO_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 10_000,
    }
  );
}

/* ======================
   STARTUP CHECKS
====================== */
async function runStartupChecks() {
  console.log("\n=== STARTUP CHECKS ===");

  // Env keys
  const keys = {
    STRIPE: process.env.STRIPE_SECRET_KEY,
    BREVO_KEY: process.env.BREVO_API_KEY,
    BREVO_SENDER: process.env.BREVO_SENDER,
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  };
  for (const [name, value] of Object.entries(keys)) {
    console.log(`${name}:`, value ? "Loaded ✅" : "Missing ❌");
  }

  // Brevo test email
  try {
    if (keys.BREVO_KEY && keys.BREVO_SENDER && keys.ADMIN_EMAIL) {
      await sendBrevoEmail({
        sender: { email: keys.BREVO_SENDER, name: "Festi Besti" },
        to: [{ email: keys.ADMIN_EMAIL, name: "Admin" }],
        subject: "Startup Test Email",
        htmlContent: "<p>Brevo check successful ✅</p>",
      });
      console.log("Brevo email test: ✅ Passed");
    } else {
      console.log("Brevo email test: ⚠️ Skipped (missing keys)");
    }
  } catch {
    console.log("Brevo email test: ❌ Failed (check API key & sender)");
  }

  // Stripe test
  try {
    if (keys.STRIPE) {
      await stripe.paymentIntents.create({
        amount: 1,
        currency: "usd",
        payment_method_types: ["card"],
      });
      console.log("Stripe API test: ✅ Passed");
    } else {
      console.log("Stripe API test: ⚠️ Skipped (missing key)");
    }
  } catch {
    console.log("Stripe API test: ❌ Failed");
  }

  console.log("======================\n");
}

/* ======================
   STRIPE WEBHOOK
====================== */
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const signature = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === "payment_intent.succeeded") {
      await handleSuccessfulPayment(event.data.object);
    }

    res.json({ received: true });
  } catch (err) {
    // Minimal logging
    res.status(400).send("Webhook Error");
  }
});

/* ======================
   PAYMENT LOGIC
====================== */
function validateOrderPayload(body) {
  const { selections, days, customer } = body;
  if (!Array.isArray(selections) || !selections.length) throw new Error("Invalid selections");
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("Invalid rental duration");
  if (!customer?.email || !customer.email.includes("@")) throw new Error("Invalid customer email");
}

app.post("/create-payment-intent", async (req, res) => {
  try {
    validateOrderPayload(req.body);
    const { selections, days, customer } = req.body;
    const amount = calculateTotal(selections, days);

    const intent = await stripe.paymentIntents.create(
      {
        amount,
        currency: "usd",
        receipt_email: customer.email,
        automatic_payment_methods: { enabled: true },
        metadata: {
          order: JSON.stringify(req.body),
        },
      },
      { idempotencyKey: crypto.randomUUID() }
    );

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

async function handleSuccessfulPayment(paymentIntent) {
  try {
    const data = JSON.parse(paymentIntent.metadata.order || "{}");
    const customer = data.customer || {};
    const order = data;

    const sender = { email: process.env.BREVO_SENDER, name: "Festi Besti" };

    // Send emails silently
    await sendBrevoEmail({
      sender,
      to: [{ email: customer.email, name: customer.name }],
      subject: "Payment Received – Your Rental Invoice",
      htmlContent: customerEmailTemplate(paymentIntent, order, customer),
    });

    await sendBrevoEmail({
      sender,
      to: [{ email: process.env.ADMIN_EMAIL, name: "Admin" }],
      subject: "New Paid Order",
      htmlContent: adminEmailTemplate(paymentIntent, order, customer),
    });

  } catch {
    // Suppress errors in production
  }
}

/* ======================
   PRICING LOGIC
====================== */
function calculateTotal(items, days) {
  let total = 0;
  items.forEach(item => total += calculateItemPrice(item) * getMultiplier(item, days));
  return Math.max(total * 100, 0);
}

function calculateItemPrice(item) {
  const pricing = {
    "Lightning Box": 35,
    "Winter Box": 25,
    "Sun Thieves": 30,
    "Snuggle Seat": 12,
  };
  const lower = item.toLowerCase();
  let price = 0;

  const key = Object.keys(pricing).find(p => lower.includes(p.toLowerCase()));
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
  await runStartupChecks();
});


