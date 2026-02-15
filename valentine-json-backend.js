const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Connect to Render Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {postgresql://valentine_json_db_user:r0JFAsP5Z0RVMJvtwx0veaCUdyDS6Vmg@dpg-d68oms7pm1nc7395knmg-a/valentine_json_db } // required on Render
});

// Default passwords
const passwords = {
  Jerik: "12345",
  Joemar: "121801",
  Dave: "192002",
  Jess: "666666"
};

// Submit password endpoint
app.post("/submit-password", async (req, res) => {
  const { person, password } = req.body;

  if (!passwords[person] || passwords[person] !== password) {
    return res.status(400).json({ success: false, message: "Invalid person or password" });
  }

  try {
    await pool.query(
      "INSERT INTO submissions(person) VALUES($1) ON CONFLICT (person) DO NOTHING",
      [person]
    );

    const { rowCount } = await pool.query("SELECT * FROM submissions");
    const completed = rowCount === 4;

    res.json({ success: true, completed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Check status endpoint
app.get("/status", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT person FROM submissions");
    res.json({ submitted: rows.map(r => r.person), completed: rows.length === 4 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ submitted: [], completed: false });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Valentine JSON backend running on port ${PORT}`));
