// Simple in-memory store for tracking subscriptions
// Format: { trackingNumber: { userId, lastStatus } }
const subscriptions = {};

function subscribe(trackingNumber, userId, lastStatus) {
  subscriptions[trackingNumber] = { userId, lastStatus };
}

function unsubscribe(trackingNumber) {
  delete subscriptions[trackingNumber];
}

function getAll() {
  return subscriptions;
}

function updateStatus(trackingNumber, newStatus) {
  if (subscriptions[trackingNumber]) {
    subscriptions[trackingNumber].lastStatus = newStatus;
  }
}

module.exports = { subscribe, unsubscribe, getAll, updateStatus };
