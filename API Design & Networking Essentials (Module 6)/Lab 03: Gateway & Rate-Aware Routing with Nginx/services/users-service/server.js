const express = require('express');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

const users = [
  { id: 10, name: "Alice Johnson", role: "Engineering Lead", email: "alice@example.com" },
  { id: 11, name: "Bob Smith", role: "Site Reliability Engineer", email: "bob@example.com" }
];

app.get('/api/v1/users', (req, res) => {
  console.log(`[USERS SERVICE] Received GET /api/v1/users from Client IP: ${req.header('x-real-ip') || req.ip}`);
  res.json({
    service: "Users Microservice",
    port: PORT,
    data: users
  });
});

app.get('/api/v1/users/:id', (req, res) => {
  const user = users.find(u => u.id === parseInt(req.params.id, 10));
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  res.json({ service: "Users Microservice", data: user });
});

app.listen(PORT, () => {
  console.log(`Users Microservice listening on internal port ${PORT}`);
});
