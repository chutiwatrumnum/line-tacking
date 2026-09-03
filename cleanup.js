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

// ── ไฟล์กำพร้า: อยู่ใน storage แต่ไม่มีแถวไหนอ้างถึง ────────────────
//
// หน้าใบสรุปอัปไฟล์ขึ้นก่อน แล้วค่อยเรียก submit_order_slip
// ถ้า RPC ไม่บันทึกแถว (สลิปซ้ำ / บิลส่งไปแล้ว / เกินโควต้าใบต่อบิล)
// ไฟล์จะค้างอยู่โดยไม่มีใครอ้างถึง — cleanupOldSlips เดินจากแถวในตาราง จึงไม่เห็นมัน
//
// ลบเองจากฝั่งลูกค้าไม่ได้ด้วย เพราะ anon มีสิทธิ์แค่ insert ในบัคเก็ตนี้ (ตั้งใจให้เป็นแบบนั้น)
// เก็บกวาดฝั่งเซิร์ฟเวอร์จึงเป็นที่เดียวที่ทำได้

/** ไฟล์ต้องเก่ากว่านี้ถึงจะถือว่ากำพร้าจริง กันลบไฟล์ที่เพิ่งอัปแล้วแถวยังตามมาไม่ทัน */
const ORPHAN_MIN_AGE_HOURS = 24;

/** เดินไฟล์ในบัคเก็ต — path มี 2 แบบ: <lineUserId>/ไฟล์ และ p/<token>/ไฟล์ */
async function listAllFiles(prefix = '', depth = 0) {
  if (depth > 2) return [];

  const { data, error } = await supabase.storage.from('slips').list(prefix, { limit: 1000 });
  if (error || !data) return [];

  const files = [];
  for (const entry of data) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    // โฟลเดอร์ไม่มี id — ของจริงถึงจะมี
    if (entry.id) files.push({ path, created_at: entry.created_at });
    else files.push(...(await listAllFiles(path, depth + 1)));
  }
  return files;
}

async function cleanupOrphanFiles() {
  const files = await listAllFiles();
  if (files.length === 0) return;

  const { data: rows, error } = await supabase.from('payment_slips').select('image_path');
  if (error) {
    console.error('[CLEANUP] ดึงรายการสลิปไม่สำเร็จ:', error.message);
    return;
  }

  const known = new Set((rows || []).map((r) => r.image_path));
  const cutoff = Date.now() - ORPHAN_MIN_AGE_HOURS * 60 * 60 * 1000;

  const orphans = files
    .filter((f) => !known.has(f.path))
    .filter((f) => !f.created_at || new Date(f.created_at).getTime() < cutoff)
    .map((f) => f.path)
    .slice(0, 200);

  if (orphans.length === 0) return;

  const { error: removeError } = await supabase.storage.from('slips').remove(orphans);
  if (removeError) {
    console.error('[CLEANUP] ลบไฟล์กำพร้าไม่สำเร็จ:', removeError.message);
    return;
  }

  console.log(`[CLEANUP] ลบไฟล์กำพร้า ${orphans.length} ไฟล์`);
}

module.exports = { cleanupOldSlips, cleanupOrphanFiles };
