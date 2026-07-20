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
    .select('tracking_number, line_user_id, last_status');

  if (error) throw new Error(`getAll ล้มเหลว: ${error.message}`);

  const result = {};
  for (const row of data || []) {
    result[row.tracking_number] = {
      userId: row.line_user_id,
      lastStatus: row.last_status,
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

module.exports = { subscribe, unsubscribe, getAll, updateStatus };
