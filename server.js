require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { TransactionalEmailsApi, Configuration } = require("@getbrevo/brevo");

// Initialize Brevo client correctly
const brevoClient = new TransactionalEmailsApi(
  new Configuration({ apiKey: process.env.BREVO_API_KEY })
);

const app = express();


/* ======================
   SERVICE STATUS + TEST EMAIL
====================== */
console.log("=== SERVICE STATUS ===");
console.log("Stripe Key:", process.env.STRIPE_SECRET_KEY ? "Loaded ✅" : "Missing ❌");
console.log("Brevo API Key:", process.env.BREVO_API_KEY ? "Loaded ✅" : "Missing ❌");



/* ====================== GLOBAL MIDDLEWARE ====================== */
app.use(cors({ origin: "http://yourfestibesti.com" }));
// NOTE: We do NOT use express.json() globally because Stripe webhooks need RAW body

/* ====================== STRIPE WEBHOOK (RAW BODY ONLY) ====================== */
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      const signature = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook signature verification failed:", err.message);
      return res.status(400).send("Webhook Error");
    }

    if (event.type === "payment_intent.succeeded") {
      await handleSuccessfulPayment(event.data.object);
    }
    res.json({ received: true });
  }
);

/* ====================== JSON MIDDLEWARE (NON-WEBHOOK ROUTES ONLY) ====================== */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));













/* ======================
   TEST EMAIL ENDPOINT
====================== */
app.get("/test-email", async (req, res) => {
  try {
    const emailData = {
      sender: { email: process.env.BREVO_SENDER, name: "Festi Besti" },
      to: [{ email: process.env.ADMIN_EMAIL, name: "Admin" }],
      subject: "Test Email from Render",
      htmlContent: "<p>If you see this, emails are working ✅</p>",
    };

    const response = await brevoClient.sendTransacEmail(emailData);
    console.log("✅ Test email response:", response);
    res.send("✅ Test email sent. Check your inbox.");
  } catch (err) {
    console.error("❌ Test email failed:", err.response ? err.response.body : err.message);
    res.status(500).send("❌ Test email failed: " + err.message);
  }
});
















/* ====================== CREATE PAYMENT INTENT ====================== */
function validateOrderPayload(body) {
  const { selections, days, customer } = body;
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new Error("Invalid selections");
  }
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    throw new Error("Invalid rental duration");
  }
  if (!customer || typeof customer.email !== "string" || !customer.email.includes("@")) {
    throw new Error("Valid customer email required");
  }
}

app.post("/create-payment-intent", async (req, res) => {
  try {
    validateOrderPayload(req.body);
    const { selections, startDate, endDate, days, customer } = req.body;
    const amount = calculateTotal(selections, days);
    if (amount <= 0) return res.status(400).json({ error: "Invalid payment amount" });

    const intent = await stripe.paymentIntents.create(
      {
        amount,
        currency: "usd",
        receipt_email: customer.email,
        automatic_payment_methods: { enabled: true },
        metadata: {
          order: JSON.stringify({ selections, startDate, endDate, days }),
          customer: JSON.stringify({
            name: customer.name,
            email: customer.email,
            phone: customer.phone || "",
          }),
        },
      },
      { idempotencyKey: crypto.randomUUID() }
    );

    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error("❌ PaymentIntent error:", err.message);
    res.status(400).json({ error: err.message });
  }
});














/* ======================
   HANDLE SUCCESSFUL PAYMENT (FIXED FOR BREVO)
====================== */
async function handleSuccessfulPayment(paymentIntent) {
  try {
    // Parse order and customer info from Stripe metadata
    const order = JSON.parse(paymentIntent.metadata.order || "{}");
    const customer = JSON.parse(paymentIntent.metadata.customer || "{}");

    const customerEmail = customer.email;

    // === Send email to customer ===
    try {
      const customerResponse = await brevoClient.sendTransacEmail({
        sender: { email: process.env.BREVO_SENDER, name: "Festi Besti" },
        to: [{ email: customerEmail, name: customer.name }],
        subject: "Payment Received – Your Rental Invoice",
        htmlContent: customerEmailTemplate(paymentIntent, order, customer),
      });
      console.log("✅ Customer email sent successfully:", customerResponse);
    } catch (err) {
      console.error(
        "❌ Customer email failed:",
        err.response ? err.response.body : err.message
      );
    }

    // === Send email to admin ===
    try {
      const adminResponse = await brevoClient.sendTransacEmail({
        sender: { email: process.env.BREVO_SENDER, name: "Festi Besti" },
        to: [{ email: process.env.ADMIN_EMAIL, name: "Admin" }],
        subject: "New Paid Order Received",
        htmlContent: adminEmailTemplate(paymentIntent, order, customer),
      });
      console.log("✅ Admin email sent successfully:", adminResponse);
    } catch (err) {
      console.error(
        "❌ Admin email failed:",
        err.response ? err.response.body : err.message
      );
    }

    console.log(`🚀 Payment processed: ${paymentIntent.id}`);
  } catch (err) {
    console.error(
      "❌ Unexpected error in handleSuccessfulPayment:",
      err.message
    );
  }
}














/* ====================== PRICING LOGIC ====================== */
function calculateTotal(items, days) {
  let total = 0;
  items.forEach((item) => {
    total += calculateItemPrice(item) * getMultiplier(item, days);
  });
  return Math.max(total * 100, 0);
}

/* ====================== HELPER: Calculate price per item (daily rate or one-time) ====================== */
function calculateItemPrice(item) {
  const pricing = {
    "Lightning Box": 35,
    "Winter Box": 25,
    "Sun Thieves": 30,
    "Snuggle Seat": 12,
  };

  const lower = item.toLowerCase();
  let price = 0;

  const key = Object.keys(pricing).find((p) => lower.includes(p.toLowerCase()));
  if (key) price += pricing[key];

  if (lower.includes("delivery")) price += 6;
  if (lower.includes("d20")) price += 20; // one-time
  if (lower.includes("inquisitive")) price -= 10; // discount

  return price;
}

// Helper: returns 1 for one-time offers, or full rental days for daily items
function getMultiplier(item, days) {
  const lower = item.toLowerCase();

  if (
    lower.includes("delivery") ||
    lower.includes("d20") ||
    lower.includes("inquisitive")
  ) {
    return 1; // one-time
  }

  return days; // per-day rental
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
app.get("/", (req, res) => {
  res.send("Server running (Stripe + Brevo TEST MODE)");
});

/* ======================
   START SERVER
====================== */
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
