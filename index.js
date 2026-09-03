require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const axios = require('axios');
const { trackParcel, trackParcels } = require('./thaipost');
const store = require('./store');
const { getPendingOrders, buildOrdersReply, orderLink } = require('./slips');
const { flushNotifications } = require('./notifications');
const { cleanupOldSlips, cleanupOrphanFiles } = require('./cleanup');
const { render } = require('./templates');

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

  // รูปที่ลูกค้าส่งเข้ามา
  //
  // ไม่รับสลิปทางแชทแล้ว — รับที่หน้าใบสรุปทางเดียว
  // เพราะหน้านั้นรู้ตั้งแต่แรกว่าเป็นบิลไหน ส่วนทางแชทต้องเดา และเดาได้เฉพาะ
  // ตอนลูกค้ามีบิลค้างใบเดียว มากกว่านั้นร้านต้องมานั่งจับคู่เอง
  //
  // แต่ห้ามเงียบ คนส่งรูปสลิปมาแล้วไม่มีอะไรตอบจะเข้าใจว่าร้านได้รับแล้ว
  // แล้วนั่งรอการยืนยันที่ไม่มีวันมา — ส่งลิงก์บิลไปให้เขาไปต่อได้เลย
  //
  // ไม่มีบิลค้าง = ไม่ได้กำลังจะจ่าย เงียบไว้ ปล่อยให้แอดมินคุยเอง
  // เหมือนที่ทำกับข้อความที่ไม่ใช่คำสั่ง
  //
  // ตอบด้วย replyMessage เท่านั้น (ฟรี ไม่กินโควต้า push)
  if (event.message.type === 'image') {
    let pending;
    try {
      pending = await getPendingOrders(event.source.userId);
    } catch (err) {
      console.error('[SLIP] หาบิลค้างไม่สำเร็จ:', err.message);
      return;
    }
    if (pending.length === 0) return;

    const lines =
      pending.length === 1
        ? [
            await render('slip_via_chat', {}, '🧾 ถ้าเป็นสลิปโอนเงิน รบกวนแนบที่หน้าใบสรุปแทนนะครับ'),
            '',
            `${pending[0].order_number} — ฿${Number(pending[0].total_amount).toLocaleString()}`,
            orderLink(pending[0].id),
            '',
            'กดลิงก์ → เลื่อนหาปุ่ม "แนบสลิปโอนเงิน" ได้เลยครับ 🙏',
          ]
        : [
            await render('slip_via_chat', {}, '🧾 ถ้าเป็นสลิปโอนเงิน รบกวนแนบที่หน้าใบสรุปของบิลนั้นนะครับ'),
            '',
            'บิลที่ยังไม่ได้ชำระ:',
            ...pending.flatMap((o) => [
              '',
              `${o.order_number} — ฿${Number(o.total_amount).toLocaleString()}`,
              orderLink(o.id),
            ]),
            '',
            'กดลิงก์ → เลื่อนหาปุ่ม "แนบสลิปโอนเงิน" ได้เลยครับ 🙏',
          ];

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: lines.join('\n') }],
    });
  }

  if (event.message.type !== 'text') return;

  const userText = event.message.text.trim();
  const userId = event.source.userId;

  // คำสั่ง: พัสดุของฉัน — กดเดียวรู้เลยว่าของถึงไหน
  // รับคำที่เคยเขียนอยู่บนปุ่มริชเมนูไว้ทั้งหมด ปุ่มเก่ายังกดได้เหมือนเดิม
  if (
    userText === 'พัสดุของฉัน' ||
    userText === 'รายการ' ||
    userText === 'รายการติดตาม' ||
    userText === 'ติดตามพัสดุ' ||
    userText === 'list'
  ) {
    return replyMyParcels(event, userId);
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
        messages: [{ type: 'text', text: await render('cancel_ok', { tracking: num }, `✅ ยกเลิกการติดตามพัสดุ ${num} แล้วครับ`) }],
      });
    } else {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: await render('cancel_not_found', { tracking: num }, `ไม่พบพัสดุ ${num} ในรายการติดตามของคุณครับ`) }],
      });
    }
  }

  // คำสั่ง: บิลค้างชำระ
  if (userText === 'บิล' || userText === 'บิลของฉัน' || userText === 'บิลค้างชำระ') {
    try {
      const orders = await getPendingOrders(userId);
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: await buildOrdersReply(orders) }],
      });
    } catch (err) {
      console.error('[ORDERS]', err.message);
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: 'ขออภัยครับ ดึงข้อมูลบิลไม่สำเร็จ\nรบกวนลองใหม่อีกครั้ง หรือทักหาแอดมินได้เลยครับ 🙏' }],
      });
    }
  }

  // คำสั่ง: ช่องทางติดตามร้าน
  // ลิงก์อยู่ในข้อความที่ร้านแก้เองได้ ไม่ได้ฝังในโค้ด — เพิ่มเพจใหม่ไม่ต้อง deploy
  // LINE ทำ URL ในข้อความให้กดได้อยู่แล้ว ไม่ต้องทำเป็นปุ่ม
  if (userText === 'ช่องทางติดตาม' || userText === 'ช่องทาง' || userText === 'ติดตามร้าน' || userText === 'เพจร้าน') {
    const text = await render('cmd_channels', {}, '');
    // ยังไม่ได้ตั้งค่า = เงียบไว้ ดีกว่าส่งข้อความเปล่าให้ลูกค้างง
    if (!text) return;
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text }],
    });
  }

  // คำสั่ง: ช่วยเหลือ
  if (userText === 'ช่วยเหลือ' || userText === 'help' || userText === '?') {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: await render('cmd_help', {}, '📌 พิมพ์เลขพัสดุเพื่อติดตาม หรือ "บิล" เพื่อดูบิลค้างชำระครับ'),
      }],
    });
  }

  const trackingNumber = extractTrackingNumber(userText);

  // ไม่ใช่เลขพัสดุและไม่ใช่คำสั่ง → เงียบไว้ ปล่อยให้แอดมินคุยกับลูกค้าเอง
  if (!trackingNumber) return;

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
        messages: [{ type: 'text', text: await render('track_not_found', { tracking: trackingNumber }, `ไม่พบข้อมูลพัสดุ ${trackingNumber} ครับ`) }],
      });
    }

    const flexMessage = buildFlexMessage(trackingNumber, result);
    let notifyText = '';

    if (isDelivered(latest.status)) {
      notifyText = await render('parcel_delivered', { tracking: trackingNumber }, `✅ พัสดุ ${trackingNumber} นำจ่ายสำเร็จแล้วครับ`);
    } else {
      const existing = (await store.getAll())[trackingNumber];
      await store.subscribe(trackingNumber, userId, latest.status);
      notifyText = existing
        ? `🔔 อัปเดตการติดตามพัสดุ ${trackingNumber} แล้วครับ`
        : await render('track_subscribed', { tracking: trackingNumber }, `🔔 ระบบจะแจ้งเตือนอัตโนมัติเมื่อสถานะพัสดุ ${trackingNumber} เปลี่ยนแปลงครับ`);
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
      messages: [{ type: 'text', text: await render('track_error', { tracking: trackingNumber }, `ไม่สามารถตรวจสอบพัสดุ ${trackingNumber} ได้`) }],
    });
  }
}

// ลบสลิปเก่าวันละครั้ง ตี 3 เวลาไทย (ช่วงคนไม่ใช้งาน)
cron.schedule('0 20 * * *', async () => {
  try {
    await cleanupOldSlips();
    await cleanupOrphanFiles();
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
// แจ้งเตือนเฉพาะ 8:00-23:00 (เวลาไทย)
//
// เวลาไทย ไม่ใช่เวลาเครื่อง — Render รันที่ UTC ถ้าอ่านชั่วโมงจากเครื่องตรง ๆ
// ช่วงที่เงียบจะเลื่อนไป 7 ชั่วโมง กลายเป็นเงียบกลางวันแล้วไปแจ้งตอนดึกแทน
const NOTIFY_FROM_HOUR = 8;
const NOTIFY_TO_HOUR = 23;

function inNotifyHours() {
  const hour = parseInt(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok', hour: 'numeric', hour12: false })
  );
  return hour >= NOTIFY_FROM_HOUR && hour < NOTIFY_TO_HOUR;
}

cron.schedule('*/3 * * * *', async () => {
  if (!inNotifyHours()) {
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
                text: await render(
                  'parcel_update',
                  {
                    tracking: trackingNumber,
                    status: latest.status_description,
                    location: latest.location || '',
                    time: formatDate(latest.status_date),
                  },
                  `🔔 อัปเดตพัสดุ ${trackingNumber}`
                ),
              },
              flexMessage,
            ],
          });
        }

        // เลิกติดตามเมื่อถึงมือผู้รับจริงเท่านั้น
        // เดิมเลิกตั้งแต่ 3xx (กำลังนำจ่าย) ลูกค้าเลยไม่เคยได้แจ้งตอนของถึงจริง
        if (isDelivered(latest.status)) {
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

/**
 * ตอบว่าพัสดุของลูกค้าอยู่ไหนแล้ว จบในกดเดียว
 *
 * เดิมแยกเป็นสองปุ่ม แล้วไม่มีปุ่มไหนตอบคำถามนี้ได้จริง
 *   "ติดตามพัสดุ"   ตอบว่าให้พิมพ์เลขมา — ปุ่มริชเมนูส่งข้อความตายตัว
 *                   ส่งเลขแทนลูกค้าไม่ได้ ปุ่มจึงทำได้แค่สั่งให้ลูกค้าพิมพ์เอง
 *   "รายการติดตาม"  ตอบมาเป็นเลขพัสดุเปล่า ๆ ไม่มีสถานะ
 *                   ต้องก๊อปเลขจากคำตอบส่งกลับเข้ามาอีกที ถึงจะรู้ว่าของอยู่ไหน
 *
 * ลูกค้าไม่เคยพิมพ์เลขเอง ร้านเป็นคนใส่ตอนส่งของแล้วระบบผูกให้เอง
 * แจ้งเตือนอัตโนมัติเด้งเฉพาะตอนสถานะเปลี่ยน — ช่วงที่ยังไม่เปลี่ยนคือช่วงที่คนเปิดมาเช็กเอง
 * ตรงนั้นแหละที่ต้องตอบให้ได้
 *
 * ยิง API ไปรษณีย์ครั้งเดียวต่อการกด ไม่ว่าจะติดตามอยู่กี่ชิ้น
 */
async function replyMyParcels(event, userId) {
  const subs = await store.getAll();
  const myNumbers = Object.entries(subs)
    .filter(([, v]) => v.userId === userId)
    .map(([num]) => num);

  if (myNumbers.length === 0) {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: await render('list_empty', {}, '📭 ไม่มีพัสดุที่กำลังติดตามอยู่ครับ') }],
    });
  }

  let items;
  try {
    items = await trackParcels(myNumbers);
  } catch (err) {
    // ไปรษณีย์ล่มก็ยังบอกได้ว่ากำลังตามเลขอะไรอยู่ ดีกว่าเงียบใส่ลูกค้า
    console.error('[MY_PARCELS]', err.message);
    const lines = [await render('list_header', {}, '📦 พัสดุที่กำลังติดตาม:'), ''];
    myNumbers.forEach((num, i) => lines.push(`${i + 1}. ${num}`));
    lines.push('', 'ตอนนี้ดึงสถานะจากไปรษณีย์ไม่ได้ รบกวนลองใหม่อีกครั้งครับ 🙏');
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: lines.join('\n') }],
    });
  }

  // ชิ้นเดียว ส่งการ์ดเต็มพร้อมประวัติการเคลื่อนไหว
  if (myNumbers.length === 1 && (items[myNumbers[0]] || []).length > 0) {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildFlexMessage(myNumbers[0], items[myNumbers[0]])],
    });
  }

  // หลายชิ้น เรียงการ์ดให้ปัดดูทีละใบ
  // ของเดิมตกไปเป็นข้อความเปล่า ๆ ทั้งที่ชิ้นเดียวได้การ์ดสวย ๆ
  // กลายเป็นว่ายิ่งมีของหลายชิ้น ยิ่งดูยาก ทั้งที่ควรจะกลับกัน
  const shown = myNumbers.slice(0, CAROUSEL_MAX);
  const bubbles = shown.map(
    (num) => buildParcelBubble(num, items[num] || [], true) || buildPendingBubble(num)
  );

  const messages = [{
    type: 'flex',
    altText: `📦 พัสดุที่กำลังติดตาม ${myNumbers.length} ชิ้น`,
    contents: { type: 'carousel', contents: bubbles },
  }];

  // เกินที่ carousel รับได้ บอกไปตรง ๆ ว่ายังมีอีก ดีกว่าหายเงียบ
  const footer = await render('list_footer', {}, '');
  const extra = myNumbers.length - shown.length;
  const note = [
    extra > 0 ? `ยังมีอีก ${extra} ชิ้น ส่งเลขพัสดุมาเพื่อดูทีละชิ้นได้ครับ` : '',
    footer,
  ].filter(Boolean).join('\n');
  if (note) messages.push({ type: 'text', text: note });

  return client.replyMessage({ replyToken: event.replyToken, messages });
}

/** ใบสำหรับพัสดุที่ไปรษณีย์ยังไม่มีข้อมูล — ไม่งั้นการ์ดหายไปเฉย ๆ โดยไม่บอกอะไร */
function buildPendingBubble(trackingNumber) {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#999999',
      paddingAll: 'lg',
      contents: [
        { type: 'text', text: '📦 ติดตามพัสดุไปรษณีย์ไทย', color: '#FFFFFF', weight: 'bold', size: 'md' },
        { type: 'text', text: trackingNumber, color: '#EEEEEE', size: 'sm', margin: 'xs' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: 'lg',
      contents: [
        { type: 'text', text: 'ยังไม่มีข้อมูลจากไปรษณีย์', size: 'sm', color: '#111111', weight: 'bold', wrap: true },
        { type: 'text', text: 'ปกติขึ้นหลังร้านนำของเข้าระบบแล้วครับ', size: 'xs', color: '#888888', margin: 'sm', wrap: true },
      ],
    },
  };
}

function extractTrackingNumber(text) {
  const match = text.match(/[A-Z]{2}\d{9}[A-Z]{2}/i);
  return match ? match[0].toUpperCase() : null;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  return dateStr.replace(/\+07:00$/, '').trim();
}

// รหัสสถานะของไปรษณีย์ไทย อ้างอิงจากที่ API คืนมาจริง ไม่ใช่การเดา
//   1xx  รับฝาก                      103 รับฝากสิ่งของ
//   2xx  ระหว่างขนส่ง                201 ออกจากที่ทำการ · 206 ถึงที่ทำการปลายทาง · 211 เข้าศูนย์คัดแยก
//   3xx  อยู่ระหว่างการนำจ่าย        301 — ของอยู่กับบุรุษไปรษณีย์ ยังไม่ถึงมือผู้รับ
//   5xx  นำจ่ายสำเร็จ                501
//
// เดิมโค้ดนี้ตีว่า 2xx = ออกไปนำจ่าย และ 3xx = สำเร็จ ซึ่งผิดทั้งคู่
// ผลคือลูกค้าได้ข้อความว่าของถึงแล้วตั้งแต่ตอนพัสดุยังอยู่บนรถ
// แล้วระบบก็เลิกติดตามต่อ ทำให้ไม่มีใครได้แจ้ง "นำจ่ายสำเร็จ" ของจริงเลย
const DELIVERED_CODE = 500;

// LINE รับ carousel ได้สูงสุด 12 ใบ ส่งเกินนี้คือข้อความตีกลับทั้งก้อน
const CAROUSEL_MAX = 12;

/** ถึงมือผู้รับแล้วจริง ๆ — ไม่ใช่แค่ออกไปส่ง */
function isDelivered(status) {
  const code = parseInt(status);
  return Number.isFinite(code) && code >= DELIVERED_CODE;
}

function getStatusStep(statusCode) {
  const code = parseInt(statusCode);
  if (!Number.isFinite(code)) return 1;
  if (code >= DELIVERED_CODE) return 4;
  // 4xx เป็นกลุ่มนำจ่ายไม่สำเร็จ/ตีกลับ ยังนับอยู่ขั้นนำจ่าย และยังต้องติดตามต่อ
  if (code >= 300) return 3;
  if (code >= 200) return 2;
  return 1;
}

function stepColor(current, step) {
  return current >= step ? '#E31837' : '#CCCCCC';
}

/**
 * การ์ดพัสดุหนึ่งใบ
 *
 * compact = ใบที่เอาไปเรียงใน carousel ตอนมีหลายชิ้น
 * ตัดประวัติการเคลื่อนไหวออก ไม่งั้นแต่ละใบสูงไม่เท่ากันจนปัดดูลำบาก
 * อยากดูประวัติเต็ม ส่งเลขพัสดุนั้นมาได้ ยังทำงานเหมือนเดิม
 */
function buildParcelBubble(trackingNumber, items, compact = false) {
  if (!items || items.length === 0) return null;

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
    type: 'bubble',
    size: compact ? 'mega' : 'giga',
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
          ...(compact
            ? []
            : [
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
              ]),
        ],
      },
  };
}

/** ห่อการ์ดใบเดียวให้เป็นข้อความพร้อมส่ง */
function buildFlexMessage(trackingNumber, items) {
  const bubble = buildParcelBubble(trackingNumber, items);
  if (!bubble) return { type: 'text', text: `ไม่พบข้อมูลพัสดุหมายเลข ${trackingNumber}` };

  const latest = [...items].reverse()[0];
  return {
    type: 'flex',
    altText: `พัสดุ ${trackingNumber}: ${latest.status_description || latest.status}`,
    contents: bubble,
  };
}

// Health check endpoint สำหรับ ping ตัวเอง
// เช็กว่าโค้ดที่รันอยู่คือคอมมิตไหน — ping เฉย ๆ บอกได้แค่ว่าเซิร์ฟเวอร์ไม่ตาย
// แต่ไม่บอกว่า deploy ใหม่ขึ้นหรือยัง ที่ผ่านมาต้องเดาเอาทุกครั้ง
// RENDER_GIT_COMMIT เป็นตัวแปรที่ Render ใส่ให้เอง
app.get('/ping', (req, res) =>
  res.send(`pong ${(process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7)}`)
);

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
