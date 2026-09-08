// เก็บรายการติดตามพัสดุใน Supabase
//
// ของเดิมเขียนเป็นไฟล์ JSON ลง /tmp ซึ่งบน Render เป็น ephemeral
// พอ deploy ใหม่หรือคอนเทนเนอร์รีสตาร์ท รายการติดตามหายเกลี้ยง
// ลูกค้าหยุดได้รับแจ้งเตือนโดยที่บอทไม่ error อะไรเลย ไม่มีใครรู้จนกว่าจะมีคนทัก
//
// ฟังก์ชันทั้งหมดเป็น async แล้ว — ผู้เรียกต้อง await
// (ของเดิมเป็น sync เพราะอ่านไฟล์)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'ต้องตั้ง SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY ใน environment ก่อน\n' +
    'หาได้ที่ Supabase Dashboard → Project Settings → API'
  );
}

// service_role ข้าม RLS ได้ ใช้ได้เฉพาะฝั่งเซิร์ฟเวอร์เท่านั้น
// ห้ามเอา key นี้ไปไว้ในโค้ดฝั่งเบราว์เซอร์เด็ดขาด
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const TABLE = 'parcel_subscriptions';

/** เริ่มติดตามพัสดุ (ถ้ามีอยู่แล้วจะทับของเดิม) */
async function subscribe(trackingNumber, userId, lastStatus) {
  const { error } = await supabase
    .from(TABLE)
    .upsert(
      {
        tracking_number: trackingNumber,
        line_user_id: userId,
        last_status: lastStatus != null ? String(lastStatus) : null,
      },
      { onConflict: 'tracking_number' }
    );

  if (error) throw new Error(`subscribe ล้มเหลว: ${error.message}`);
}

async function unsubscribe(trackingNumber) {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('tracking_number', trackingNumber);

  if (error) throw new Error(`unsubscribe ล้มเหลว: ${error.message}`);
}

/**
 * คืนรูปแบบเดิม { [trackingNumber]: { userId, lastStatus } }
 * เพื่อให้โค้ดที่เรียกอยู่เดิมใช้ต่อได้โดยไม่ต้องรื้อ
 */
async function getAll() {
  const { data, error } = await supabase
    .from(TABLE)
    .select('tracking_number, line_user_id, last_status, order_id');

  if (error) throw new Error(`getAll ล้มเหลว: ${error.message}`);

  const result = {};
  for (const row of data || []) {
    result[row.tracking_number] = {
      userId: row.line_user_id,
      lastStatus: row.last_status,
      orderId: row.order_id,
    };
  }
  return result;
}

async function updateStatus(trackingNumber, newStatus) {
  const { error } = await supabase
    .from(TABLE)
    .update({ last_status: newStatus != null ? String(newStatus) : null })
    .eq('tracking_number', trackingNumber);

  if (error) throw new Error(`updateStatus ล้มเหลว: ${error.message}`);
}

/**
 * ขั้นสถานะที่ร้านเลือกให้แจ้งเตือน (ตั้งได้จากหน้าตั้งค่า ไม่ต้อง deploy)
 *
 * แคชสั้น ๆ เพราะ cron เรียกทุก 3 นาที ไม่จำเป็นต้องยิงฐานข้อมูลทุกรอบ
 * อ่านไม่ได้ = คืน null ให้ผู้เรียกใช้ค่าเริ่มต้นในโค้ด ดีกว่าเงียบใส่ลูกค้า
 */
let tierCache = null;
let tierCachedAt = 0;
const TIER_CACHE_MS = 5 * 60 * 1000;

async function getPushTiers() {
  if (tierCache && Date.now() - tierCachedAt < TIER_CACHE_MS) return tierCache;

  const { data, error } = await supabase
    .from('settings')
    .select('parcel_push_tiers')
    .limit(1)
    .maybeSingle();

  if (error || !data?.parcel_push_tiers) {
    if (error) console.error('[STORE] อ่าน parcel_push_tiers ไม่สำเร็จ:', error.message);
    return tierCache;
  }

  tierCache = data.parcel_push_tiers;
  tierCachedAt = Date.now();
  return tierCache;
}

/**
 * ปิดบิลเมื่อไปรษณีย์แจ้งนำจ่ายสำเร็จ
 *
 * เดิมร้านต้องไล่กด "ถึงแล้ว" เองทุกใบ ทั้งที่บอทรู้อยู่แล้วว่าถึงเมื่อไหร่
 *
 * เขียนเฉพาะบิลที่ยังเป็น pending/shipped — ห้ามทับบิลที่ยกเลิกไปแล้ว
 * และทำให้เรียกซ้ำได้ด้วย เพราะรอบสองจะไม่มีแถวไหนเข้าเงื่อนไขอีก
 */
async function markDelivered(orderId) {
  if (!orderId) return;

  const { error } = await supabase
    .from('orders')
    .update({ status: 'delivered', delivered_at: new Date().toISOString() })
    .eq('id', orderId)
    .in('status', ['pending', 'shipped']);

  if (error) console.error(`[STORE] ปิดบิล ${orderId} ไม่สำเร็จ:`, error.message);
}

module.exports = { subscribe, unsubscribe, getAll, updateStatus, getPushTiers, markDelivered };
