const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'subscriptions.json');

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
