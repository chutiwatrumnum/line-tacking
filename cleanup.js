// ลบสลิปที่จัดการแล้ว (ยืนยัน/ปฏิเสธ) เกิน 90 วัน
//
// สลิปมีเลขบัญชีและชื่อลูกค้า เก็บนานเกินจำเป็นเป็นภาระด้าน privacy
// ไม่ใช่เรื่องพื้นที่ — 1 GB จุได้เป็นหมื่นใบ แต่ไม่ควรถือข้อมูลการเงินคนอื่นไว้ตลอดกาล
//
// สลิปที่ยัง pending ไม่ลบ (ยังไม่จบเรื่อง)

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const RETENTION_DAYS = 90;

async function cleanupOldSlips() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: old, error } = await supabase
    .from('payment_slips')
    .select('id, image_path')
    .in('status', ['confirmed', 'rejected'])
    .lt('reviewed_at', cutoff)
    .limit(200);

  if (error) {
    console.error('[CLEANUP] ดึงสลิปเก่าไม่สำเร็จ:', error.message);
    return;
  }
  if (!old || old.length === 0) return;

  // ลบไฟล์ใน storage ก่อน แล้วค่อยลบแถว
  // ถ้าลบแถวก่อนแล้วลบไฟล์พลาด จะเหลือไฟล์กำพร้าที่ไม่มีใครอ้างถึงอีก
  const paths = old.map(s => s.image_path);
  const { error: storageError } = await supabase.storage.from('slips').remove(paths);
  if (storageError) {
    console.error('[CLEANUP] ลบไฟล์ไม่สำเร็จ:', storageError.message);
    return;
  }

  const { error: rowError } = await supabase
    .from('payment_slips')
    .delete()
    .in('id', old.map(s => s.id));

  if (rowError) {
    console.error('[CLEANUP] ลบแถวไม่สำเร็จ:', rowError.message);
    return;
  }

  console.log(`[CLEANUP] ลบสลิปเก่า ${old.length} รายการ`);
}

module.exports = { cleanupOldSlips };
