#!/usr/bin/env node
//
// เติมชื่อ LINE ให้บิลเก่าที่ผูกบัญชีไว้ก่อนจะมีคอลัมน์ line_display_name
//
// บิลพวกนั้นมี line_user_id อยู่แล้วแต่ไม่มีชื่อ เพราะตอนนั้นโค้ดทิ้ง displayName ไป
// ที่นี่ดึงชื่อกลับมาจาก LINE Messaging API แล้วเติมให้ครบทีเดียว
//
// ดึงได้เฉพาะคนที่ยังเป็นเพื่อนกับ OA อยู่ — ใครบล็อกหรือลบเพื่อนไปแล้ว LINE คืน 404
// ซึ่งไม่ใช่ error ของเรา ข้ามไปแล้วนับไว้ในสรุป
//
// ใช้:
//   node scripts/backfill-line-names.js --dry-run   ดูว่าจะเติมอะไรบ้าง ไม่เขียนจริง
//   node scripts/backfill-line-names.js             เขียนจริง

require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.argv.includes('--dry-run');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ดึงชื่อจาก LINE — คืน null เมื่อดึงไม่ได้ ไม่โยน error ให้ทั้งงานหยุด */
async function fetchDisplayName(userId) {
  const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });

  if (res.status === 404) return { name: null, reason: 'ไม่ได้เป็นเพื่อนกับ OA แล้ว' };
  if (res.status === 429) return { name: null, reason: 'โดน rate limit' };
  if (!res.ok) return { name: null, reason: `LINE ตอบ ${res.status}` };

  const data = await res.json();
  return { name: data.displayName || null, reason: null };
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('ขาด SUPABASE_URL หรือ SUPABASE_SERVICE_ROLE_KEY ใน .env');
    process.exit(1);
  }
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.error('ขาด LINE_CHANNEL_ACCESS_TOKEN ใน .env');
    process.exit(1);
  }

  console.log(DRY_RUN ? '── โหมดทดลอง ไม่เขียนอะไรลงฐานข้อมูล ──\n' : '── เริ่มเติมชื่อ ──\n');

  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, order_number, line_user_id')
    .not('line_user_id', 'is', null)
    .is('line_display_name', null);

  if (error) {
    console.error('ดึงบิลไม่สำเร็จ:', error.message);
    process.exit(1);
  }

  if (!orders || orders.length === 0) {
    console.log('ไม่มีบิลที่ต้องเติมชื่อ');
    return;
  }

  // คนเดียวอาจมีหลายบิล ยิง LINE ครั้งเดียวต่อคนพอ
  const byUser = new Map();
  for (const o of orders) {
    if (!byUser.has(o.line_user_id)) byUser.set(o.line_user_id, []);
    byUser.get(o.line_user_id).push(o);
  }

  console.log(`พบ ${orders.length} บิล จาก ${byUser.size} บัญชี LINE\n`);

  let filled = 0;
  let skipped = 0;

  for (const [userId, userOrders] of byUser) {
    const { name, reason } = await fetchDisplayName(userId);
    const bills = userOrders.map((o) => o.order_number).join(', ');

    if (!name) {
      console.log(`✗ ${userId.slice(0, 10)}… — ${reason}  (${bills})`);
      skipped += userOrders.length;
      await sleep(120);
      continue;
    }

    console.log(`✓ ${name}  →  ${userOrders.length} บิล  (${bills})`);

    if (!DRY_RUN) {
      const ids = userOrders.map((o) => o.id);
      const { error: upErr } = await supabase
        .from('orders')
        .update({ line_display_name: name })
        .in('id', ids);

      if (upErr) {
        console.log(`  ⚠️ เขียนไม่สำเร็จ: ${upErr.message}`);
        skipped += userOrders.length;
        await sleep(120);
        continue;
      }

      // เก็บที่ลูกค้าด้วย ออเดอร์ถัดไปจะได้รู้จักชื่อตั้งแต่แรก
      await supabase
        .from('customers')
        .update({ line_display_name: name })
        .eq('line_user_id', userId)
        .is('line_display_name', null);
    }

    filled += userOrders.length;
    // LINE จำกัดอัตราการเรียกอยู่ เว้นจังหวะไว้หน่อย
    await sleep(120);
  }

  console.log(`\n── สรุป ──`);
  console.log(`เติมชื่อได้:  ${filled} บิล`);
  console.log(`ข้าม:        ${skipped} บิล`);
  if (DRY_RUN) console.log('\n(โหมดทดลอง ยังไม่ได้เขียนอะไรจริง — เอาออก --dry-run เพื่อเขียน)');
}

main().catch((err) => {
  console.error('พัง:', err.message);
  process.exit(1);
});
