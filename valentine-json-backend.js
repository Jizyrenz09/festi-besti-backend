const express = require("express");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// JSON file path
const DATA_FILE = path.join(__dirname, "submissions.json");

// Default passwords
const passwords = {
  Jerik: "12345",
  Joemar: "121801",
  Dave: "192002",
  Jess: "666666"
};

// Load submissions from file
function loadSubmissions() {
  if (!fs.existsSync(DATA_FILE)) return {};
  return .parse(fs.readFileSync(DATA_FILE, "utf8"));
}

// Save submissions to file
function saveSubmissions(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Submit password endpoint
app.post("/submit-password", (req, res) => {
  const { person, password } = req.body;

  if (!passwords[person] || passwords[person] !== password) {
    return res.status(400).json({ success: false, message: "Invalid person or password" });
  }

  const submissions = loadSubmissions();
  submissions[person] = true;
  saveSubmissions(submissions);

  const completed = Object.keys(submissions).length === 4;
  res.json({ success: true, completed });
});

// Check status endpoint
app.get("/status", (req, res) => {
  const submissions = loadSubmissions();
  res.json({ submitted: Object.keys(submissions), completed: Object.keys(submissions).length === 4 });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Valentine JSON backend running on port ${PORT}`));
