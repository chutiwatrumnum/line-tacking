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
    messages: [{ type: 'text', text: `🔍 กำลังตรวจสอบพัสดุ ${trackingNumber} ...` }],
  });

  try {
    const result = await trackParcel(trackingNumber);
    const flexMessage = buildFlexMessage(trackingNumber, result);

    await client.pushMessage({
      to: event.source.userId,
      messages: [flexMessage],
    });
  } catch (err) {
    await client.pushMessage({
      to: event.source.userId,
      messages: [{ type: 'text', text: `ไม่สามารถตรวจสอบพัสดุ ${trackingNumber} ได้\nกรุณาลองใหม่อีกครั้ง` }],
    });
  }
}

function extractTrackingNumber(text) {
  const match = text.match(/[A-Z]{2}\d{9}[A-Z]{2}/i);
  return match ? match[0].toUpperCase() : null;
}

function getStatusStep(statusCode) {
  const code = parseInt(statusCode);
  if (code >= 300) return 4; // นำจ่ายสำเร็จ
  if (code >= 200) return 3; // ออกไปนำจ่าย
  if (code >= 102) return 2; // ระหว่างขนส่ง
  return 1; // รับเข้าระบบ
}

function stepColor(current, step) {
  return current >= step ? '#E31837' : '#CCCCCC';
}

function buildFlexMessage(trackingNumber, items) {
  if (!items || items.length === 0) {
    return { type: 'text', text: `ไม่พบข้อมูลพัสดุหมายเลข ${trackingNumber}` };
  }

  const latest = items[0];
  const currentStep = getStatusStep(latest.status);

  const steps = [
    { label: 'รับเข้าระบบ', step: 1 },
    { label: 'ระหว่างขนส่ง', step: 2 },
    { label: 'ออกไปนำจ่าย', step: 3 },
    { label: 'นำจ่ายสำเร็จ', step: 4 },
  ];

  const stepBoxes = steps.map((s) => ({
    type: 'box',
    layout: 'vertical',
    alignItems: 'center',
    flex: 1,
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: '28px',
        height: '28px',
        cornerRadius: '14px',
        backgroundColor: stepColor(currentStep, s.step),
        justifyContent: 'center',
        alignItems: 'center',
        contents: [
          {
            type: 'text',
            text: currentStep >= s.step ? '✓' : `${s.step}`,
            color: '#FFFFFF',
            size: 'xs',
            weight: 'bold',
            align: 'center',
          },
        ],
      },
      {
        type: 'text',
        text: s.label,
        size: 'xxs',
        color: currentStep >= s.step ? '#E31837' : '#AAAAAA',
        align: 'center',
        wrap: true,
        margin: 'sm',
      },
    ],
  }));

  const timelineRows = items.slice(0, 6).map((item, i) => ({
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    paddingBottom: 'md',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        alignItems: 'center',
        width: '24px',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            width: '12px',
            height: '12px',
            cornerRadius: '6px',
            backgroundColor: i === 0 ? '#E31837' : '#CCCCCC',
            contents: [],
          },
          ...(i < items.slice(0, 6).length - 1
            ? [{
                type: 'box',
                layout: 'vertical',
                width: '2px',
                flex: 1,
                backgroundColor: '#DDDDDD',
                contents: [],
              }]
            : []),
        ],
      },
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        contents: [
          {
            type: 'text',
            text: item.status_detail || item.status_description || '-',
            size: 'sm',
            color: i === 0 ? '#111111' : '#555555',
            weight: i === 0 ? 'bold' : 'regular',
            wrap: true,
          },
          {
            type: 'text',
            text: item.status_date || '-',
            size: 'xxs',
            color: '#AAAAAA',
            margin: 'xs',
          },
        ],
      },
    ],
  }));

  return {
    type: 'flex',
    altText: `พัสดุ ${trackingNumber}: ${latest.status_description || latest.status}`,
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#E31837',
        paddingAll: 'lg',
        contents: [
          {
            type: 'text',
            text: '📦 ติดตามพัสดุไปรษณีย์ไทย',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'md',
          },
          {
            type: 'text',
            text: trackingNumber,
            color: '#FFCCCC',
            size: 'sm',
            margin: 'xs',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        spacing: 'lg',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: stepBoxes,
          },
          { type: 'separator' },
          {
            type: 'text',
            text: 'ประวัติการเคลื่อนไหว',
            weight: 'bold',
            size: 'sm',
            color: '#333333',
          },
          {
            type: 'box',
            layout: 'vertical',
            contents: timelineRows,
          },
        ],
      },
    },
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
