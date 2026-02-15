const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// PostgreSQL pool
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Default passwords (unchanged)
const passwords = {
  Jerik: "12345",
  Joemar: "121801",
  Dave: "192002",
  Jess: "666666"
};

// Ensure submissions table exists
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      person VARCHAR(50) PRIMARY KEY,
      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
initDB();

// Submit password endpoint
app.post("/submit-password", async (req, res) => {
  const { person, password } = req.body;

  if (!passwords[person] || passwords[person] !== password) {
    return res.status(400).json({ success: false, message: "Invalid person or password" });
  }

  try {
    await pool.query(
      "INSERT INTO submissions (person) VALUES ($1) ON CONFLICT (person) DO NOTHING",
      [person]
    );

    const result = await pool.query("SELECT COUNT(*) FROM submissions");
    const completed = parseInt(result.rows[0].count) === 4;

    res.json({ success: true, completed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Status endpoint
app.get("/status", async (req, res) => {
  try {
    const result = await pool.query("SELECT person FROM submissions");
    const submitted = result.rows.map(r => r.person);
    const completed = submitted.length === 4;
    res.json({ submitted, completed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ submitted: [], completed: false });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Valentine JSON backend running on port ${PORT}`));
