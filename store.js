const fs = require('fs');
const path = require('path');

// ใช้ /tmp บน Railway เพราะ writable, ใช้ __dirname บน local
const FILE = process.env.RAILWAY_ENVIRONMENT
  ? '/tmp/subscriptions.json'
  : path.join(__dirname, 'subscriptions.json');

function load() {
  try {
    if (fs.existsSync(FILE)) {
      return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function subscribe(trackingNumber, userId, lastStatus) {
  const data = load();
  data[trackingNumber] = { userId, lastStatus };
  save(data);
}

function unsubscribe(trackingNumber) {
  const data = load();
  delete data[trackingNumber];
  save(data);
}

function getAll() {
  return load();
}

function updateStatus(trackingNumber, newStatus) {
  const data = load();
  if (data[trackingNumber]) {
    data[trackingNumber].lastStatus = newStatus;
    save(data);
  }
}

module.exports = { subscribe, unsubscribe, getAll, updateStatus };
