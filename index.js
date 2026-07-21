require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const axios = require('axios');
const { trackParcel, trackParcels } = require('./thaipost');
const store = require('./store');
const { handleSlipImage, buildSlipReply } = require('./slips');
const { flushNotifications } = require('./notifications');
const { cleanupOldSlips } = require('./cleanup');

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
  if (event.type !== 'message') return;

  // รูปที่ลูกค้าส่งมา = สลิปโอนเงิน
  // ตอบด้วย replyMessage เท่านั้น (ฟรี ไม่กินโควต้า push)
  if (event.message.type === 'image') {
    try {
      const result = await handleSlipImage({
        messageId: event.message.id,
        userId: event.source.userId,
      });
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: buildSlipReply(result) }],
      });
    } catch (err) {
      console.error('[SLIP]', err.message);
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: 'ขออภัยครับ บันทึกสลิปไม่สำเร็จ\nรบกวนส่งใหม่อีกครั้ง หรือทักหาแอดมินได้เลยครับ 🙏' }],
      });
    }
  }

  if (event.message.type !== 'text') return;

  const userText = event.message.text.trim();
  const userId = event.source.userId;
  console.log(`[USER] userId: ${userId}`);

  // คำสั่ง: ดูรายการ
  if (userText === 'รายการ' || userText === 'list') {
    const subs = await store.getAll();
    const myParcels = Object.entries(subs).filter(([, v]) => v.userId === userId);
    if (myParcels.length === 0) {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '📭 ไม่มีพัสดุที่กำลังติดตามอยู่ครับ\nส่งเลขพัสดุมาได้เลย' }],
      });
    }
    const lines = ['📦 พัสดุที่กำลังติดตาม:\n'];
    myParcels.forEach(([num], i) => {
      lines.push(`${i + 1}. ${num}`);
    });
    lines.push('\nพิมพ์ "ยกเลิก [เลขพัสดุ]" เพื่อหยุดติดตาม');
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: lines.join('\n') }],
    });
  }

  // คำสั่ง: ยกเลิกติดตาม
  const cancelMatch = userText.match(/^ยกเลิก\s+([A-Z]{2}\d{9}[A-Z]{2})/i);
  if (cancelMatch) {
    const num = cancelMatch[1].toUpperCase();
    const subs = await store.getAll();
    if (subs[num] && subs[num].userId === userId) {
      await store.unsubscribe(num);
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: `✅ ยกเลิกการติดตามพัสดุ ${num} แล้วครับ` }],
      });
    } else {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: `ไม่พบพัสดุ ${num} ในรายการติดตามของคุณครับ` }],
      });
    }
  }

  // คำสั่ง: ช่วยเหลือ
  if (userText === 'ช่วยเหลือ' || userText === 'help' || userText === '?') {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: '📌 วิธีใช้งาน\n\n🔍 ติดตามพัสดุ\nส่งเลขพัสดุ เช่น EF123456789TH\n\n📋 ดูรายการที่ติดตาม\nพิมพ์: รายการ\n\n❌ ยกเลิกติดตาม\nพิมพ์: ยกเลิก EF123456789TH\n\n🔔 ระบบจะแจ้งเตือนอัตโนมัติเมื่อสถานะเปลี่ยน',
      }],
    });
  }

  const trackingNumber = extractTrackingNumber(userText);

  if (!trackingNumber) {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: 'ไม่พบเลขพัสดุครับ\n\nส่งเลขพัสดุ เช่น EF123456789TH\nหรือพิมพ์ "ช่วยเหลือ" เพื่อดูวิธีใช้' }],
    });
  }

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: `🔍 กำลังตรวจสอบพัสดุ ${trackingNumber} ...` }],
  });

  try {
    const result = await trackParcel(trackingNumber);
    const sorted = [...result].reverse();
    const latest = sorted[0];

    // ถ้าไม่พบข้อมูล
    if (!latest) {
      return await client.pushMessage({
        to: userId,
        messages: [{ type: 'text', text: `ไม่พบข้อมูลพัสดุ ${trackingNumber} ครับ\nกรุณาตรวจสอบเลขพัสดุอีกครั้ง` }],
      });
    }

    const flexMessage = buildFlexMessage(trackingNumber, result);
    let notifyText = '';

    if (parseInt(latest.status) >= 300) {
      notifyText = `✅ พัสดุ ${trackingNumber} นำจ่ายสำเร็จแล้วครับ`;
    } else {
      const existing = (await store.getAll())[trackingNumber];
      await store.subscribe(trackingNumber, userId, latest.status);
      notifyText = existing
        ? `🔔 อัปเดตการติดตามพัสดุ ${trackingNumber} แล้วครับ`
        : `🔔 ระบบจะแจ้งเตือนอัตโนมัติเมื่อสถานะพัสดุ ${trackingNumber} เปลี่ยนแปลงครับ`;
    }

    // รวมเป็นคำขอเดียว: LINE นับโควต้าตาม "จำนวนคนที่ส่งถึง" ไม่ใช่จำนวนข้อความในคำขอ
    // แยกเป็น 2 คำขอแบบเดิมจึงโดนนับ 2 ทั้งที่ส่งให้คนเดียว
    // (ส่งได้สูงสุด 5 ข้อความต่อคำขอ ตรงนี้ใช้ 2)
    await client.pushMessage({
      to: userId,
      messages: [flexMessage, { type: 'text', text: notifyText }],
    });
  } catch (err) {
    console.error(err);
    await client.pushMessage({
      to: userId,
      messages: [{ type: 'text', text: `ไม่สามารถตรวจสอบพัสดุ ${trackingNumber} ได้\nกรุณาลองใหม่อีกครั้ง` }],
    });
  }
}

// ลบสลิปเก่าวันละครั้ง ตี 3 เวลาไทย (ช่วงคนไม่ใช้งาน)
cron.schedule('0 20 * * *', async () => {
  try {
    await cleanupOldSlips();
  } catch (err) {
    console.error('[CLEANUP] cron error:', err.message);
  }
});

// ส่งคิวข้อความที่หน้าแอดมินหยอดไว้ (เช่น ยืนยันเงินแล้ว)
// รันทุก 1 นาที ไม่จำกัดเวลา เพราะลูกค้าเพิ่งส่งสลิปแล้วรออยู่
cron.schedule('* * * * *', async () => {
  try {
    await flushNotifications(client);
  } catch (err) {
    console.error('[NOTIFY] cron error:', err.message);
  }
});

// ตรวจสถานะทุก 3 นาที (batch ทุกเลขในคำขอเดียว)
// แจ้งเตือนเฉพาะ 8:00-20:00 (เวลาไทย)
cron.schedule('*/3 * * * *', async () => {
  const hour = new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok', hour: 'numeric', hour12: false });
  if (parseInt(hour) < 8 || parseInt(hour) >= 20) {
    console.log('[CRON] Outside notify hours, skipping...');
    return;
  }
  const subs = await store.getAll();
  const keys = Object.keys(subs);
  if (keys.length === 0) return;

  console.log(`[CRON] Batch checking ${keys.length} parcel(s) in 1 API call...`);

  try {
    // 1 API call สำหรับทุกเลขพัสดุ
    const allResults = await trackParcels(keys);

    for (const trackingNumber of keys) {
      const { userId, lastStatus } = subs[trackingNumber];
      const result = allResults[trackingNumber] || [];
      const sorted = [...result].reverse();
      const latest = sorted[0];
      if (!latest) continue;

      if (latest.status !== lastStatus) {
        // เก็บสถานะล่าสุดเสมอ (DB write ถูก) แต่ push เฉพาะตอน "ขึ้นกลุ่มใหม่"
        // Thai Post status เป็นเลข: 1xx ระหว่างขนส่ง (เปลี่ยนหลายรอบตามศูนย์คัดแยก),
        // 2xx นำจ่าย, 3xx+ สำเร็จ — จัดกลุ่มตามหลักร้อยแล้ว hop ย่อยใน 1xx ยุบเหลือครั้งเดียว
        // ลดจาก ~5-6 push/พัสดุ เหลือ 2-3 ให้อยู่ในโควต้าฟรี
        await store.updateStatus(trackingNumber, latest.status);

        const currentTier = statusTier(latest.status);
        const lastTier = statusTier(lastStatus);

        if (currentTier > lastTier) {
          const flexMessage = buildFlexMessage(trackingNumber, result);

          await client.pushMessage({
            to: userId,
            messages: [
              {
                type: 'text',
                text: `🔔 อัปเดตพัสดุ ${trackingNumber}\n📍 ${latest.status_description}: ${latest.location || ''}\n🕐 ${formatDate(latest.status_date)}`,
              },
              flexMessage,
            ],
          });
        }

        // Unsubscribe if delivered
        if (parseInt(latest.status) >= 300) {
          await store.unsubscribe(trackingNumber);
          console.log(`[CRON] ${trackingNumber} delivered, unsubscribed.`);
        }
      }
    }
  } catch (err) {
    console.error(`[CRON] Batch error:`, err.message);
  }
});

// จัดกลุ่มสถานะพัสดุตามหลักร้อย เพื่อยุบ hop ย่อยที่ push ซ้ำ ๆ
// null/ค่าอ่านไม่ได้ = -1 เพื่อให้สถานะจริงครั้งแรกนับเป็น "ขึ้นกลุ่มใหม่" เสมอ
function statusTier(status) {
  const n = parseInt(status);
  return Number.isNaN(n) ? -1 : Math.floor(n / 100);
}

function extractTrackingNumber(text) {
  const match = text.match(/[A-Z]{2}\d{9}[A-Z]{2}/i);
  return match ? match[0].toUpperCase() : null;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  return dateStr.replace(/\+07:00$/, '').trim();
}

function getStatusStep(statusCode) {
  const code = parseInt(statusCode);
  if (code >= 300) return 4;
  if (code >= 200) return 3;
  if (code >= 102) return 2;
  return 1;
}

function stepColor(current, step) {
  return current >= step ? '#E31837' : '#CCCCCC';
}

function buildFlexMessage(trackingNumber, items) {
  if (!items || items.length === 0) {
    return { type: 'text', text: `ไม่พบข้อมูลพัสดุหมายเลข ${trackingNumber}` };
  }

  const sorted = [...items].reverse();
  const latest = sorted[0];
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

  const timelineRows = sorted.slice(0, 8).map((item, i) => ({
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
          ...(i < sorted.slice(0, 8).length - 1
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
            text: formatDate(item.status_date),
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
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: 'สถานะ', size: 'sm', color: '#888888', flex: 2 },
                  { type: 'text', text: latest.status_description || '-', size: 'sm', color: '#111111', flex: 5, weight: 'bold', wrap: true },
                ],
              },
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: 'สถานที่', size: 'sm', color: '#888888', flex: 2 },
                  { type: 'text', text: latest.location || '-', size: 'sm', color: '#111111', flex: 5, wrap: true },
                ],
              },
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: 'เวลา', size: 'sm', color: '#888888', flex: 2 },
                  { type: 'text', text: formatDate(latest.status_date), size: 'sm', color: '#111111', flex: 5, wrap: true },
                ],
              },
              ...(latest.receiver_name ? [{
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: 'ผู้รับ', size: 'sm', color: '#888888', flex: 2 },
                  { type: 'text', text: latest.receiver_name, size: 'sm', color: '#111111', flex: 5, wrap: true },
                ],
              }] : []),
              ...(latest.delivery_officer_name ? [{
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: 'บุรุษไปรษณีย์', size: 'sm', color: '#888888', flex: 2 },
                  { type: 'text', text: latest.delivery_officer_name, size: 'sm', color: '#111111', flex: 5, wrap: true },
                ],
              }] : []),
            ],
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

// Health check endpoint สำหรับ ping ตัวเอง
app.get('/ping', (req, res) => res.send('pong'));

// Test endpoint — จำลองแจ้งเตือนทันที
// ใช้: GET /test-notify?tracking=ED123456789TH&userId=Uxxxx
app.get('/test-notify', async (req, res) => {
  const { tracking, userId } = req.query;
  if (!tracking || !userId) {
    return res.status(400).json({ error: 'ต้องใส่ tracking และ userId' });
  }
  try {
    await client.pushMessage({
      to: userId,
      messages: [{
        type: 'text',
        text: `🔔 [TEST] แจ้งเตือนพัสดุ ${tracking}\n📍 สถานะ: ทดสอบระบบแจ้งเตือน\n✅ ระบบทำงานปกติครับ`,
      }],
    });
    res.json({ success: true, message: `ส่งแจ้งเตือนไปที่ ${userId} แล้ว` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ping ตัวเองทุก 10 นาที ป้องกัน Render sleep
cron.schedule('*/10 * * * *', async () => {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (url) {
    try {
      await axios.get(`${url}/ping`);
      console.log('[PING] Server kept alive');
    } catch (e) {
      console.error('[PING] Failed:', e.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
