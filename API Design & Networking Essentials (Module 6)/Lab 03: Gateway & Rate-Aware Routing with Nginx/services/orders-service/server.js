const express = require('express');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

let orders = [
  { id: 1, item: "Mechanical Keyboard", price: 120.00, status: "SHIPPED" },
  { id: 2, item: "4K Monitor 27-inch", price: 350.00, status: "PROCESSING" }
];

app.get('/api/v1/orders', (req, res) => {
  console.log(`[ORDERS SERVICE] Received GET /api/v1/orders from Client IP: ${req.header('x-real-ip') || req.ip}`);
  res.json({
    service: "Orders Microservice",
    port: PORT,
    data: orders
  });
});

app.post('/api/v1/orders', (req, res) => {
  const { item, price } = req.body || {};
  const newOrder = {
    id: orders.length + 1,
    item: item || "Standard Item",
    price: price || 99.99,
    status: "CREATED"
  };
  orders.push(newOrder);
  res.status(201).json(newOrder);
});

app.listen(PORT, () => {
  console.log(`Orders Microservice listening on internal port ${PORT}`);
});
