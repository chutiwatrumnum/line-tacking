require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { trackParcel } = require('./thaipost');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

const app = express();

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userText = event.message.text.trim();
  const trackingNumber = extractTrackingNumber(userText);

  if (!trackingNumber) {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: 'กรุณาส่งเลขพัสดุที่ต้องการติดตาม\nตัวอย่าง: EF123456789TH' }],
    });
  }

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: `กำลังตรวจสอบพัสดุ ${trackingNumber} ...` }],
  });

  try {
    const result = await trackParcel(trackingNumber);
    const message = formatTrackingResult(trackingNumber, result);

    await client.pushMessage({
      to: event.source.userId,
      messages: [{ type: 'text', text: message }],
    });
  } catch (err) {
    await client.pushMessage({
      to: event.source.userId,
      messages: [{ type: 'text', text: `ไม่สามารถตรวจสอบพัสดุ ${trackingNumber} ได้\nกรุณาลองใหม่อีกครั้ง` }],
    });
  }
}

function extractTrackingNumber(text) {
  // Thai Post tracking numbers: 13 chars, pattern like EF123456789TH or RR123456789TH
  const match = text.match(/[A-Z]{2}\d{9}[A-Z]{2}/i);
  return match ? match[0].toUpperCase() : null;
}

function formatTrackingResult(trackingNumber, items) {
  if (!items || items.length === 0) {
    return `ไม่พบข้อมูลพัสดุหมายเลข ${trackingNumber}`;
  }

  const latest = items[0];
  const lines = [
    `📦 พัสดุหมายเลข: ${trackingNumber}`,
    `📍 สถานะล่าสุด: ${latest.status_description || latest.status}`,
    `🏢 สถานที่: ${latest.location || '-'}`,
    `📅 เวลา: ${latest.status_date || '-'}`,
    `📝 รายละเอียด: ${latest.status_detail || '-'}`,
    '',
    '--- ประวัติการเคลื่อนไหว ---',
  ];

  items.slice(0, 5).forEach((item) => {
    lines.push(`• ${item.status_date || '-'} - ${item.status_description || item.status} (${item.location || '-'})`);
  });

  return lines.join('\n');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
