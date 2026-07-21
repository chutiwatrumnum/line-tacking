// ส่งข้อความในคิว line_notifications ที่หน้าแอดมินหยอดไว้
//
// แอดมิน (เบราว์เซอร์) ส่ง LINE เองไม่ได้เพราะไม่มี channel token
// บอทตัวนี้เป็นคนส่งด้วย token ของมัน โดย poll คิวเป็นระยะ
//
// push นับโควต้า LINE — คิวนี้จึงใช้เฉพาะเหตุการณ์สำคัญ (ยืนยันเงิน) ไม่ใช่ทุกความเคลื่อนไหว

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

/**
 * ดึงคิวที่ค้าง แล้วส่งทีละรายการ
 * client = LINE messaging client จาก index.js (จะได้ใช้ token ตัวเดียวกัน)
 */
async function flushNotifications(client) {
  const { data: pending, error } = await supabase
    .from('line_notifications')
    .select('id, line_user_id, message')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(20);

  if (error) {
    console.error('[NOTIFY] ดึงคิวไม่สำเร็จ:', error.message);
    return;
  }
  if (!pending || pending.length === 0) return;

  for (const row of pending) {
    try {
      await client.pushMessage({
        to: row.line_user_id,
        messages: [{ type: 'text', text: row.message }],
      });

      await supabase
        .from('line_notifications')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', row.id);
    } catch (err) {
      // push ล้มเหลวที่พบบ่อยสุดคือลูกค้ายังไม่ได้แอด OA เป็นเพื่อน
      // เก็บ error ไว้ดูได้ แต่ไม่ลองใหม่ไม่จบไม่สิ้น
      const reason = err?.originalError?.response?.data?.message || err.message;
      console.error(`[NOTIFY] ส่งไม่สำเร็จ (${row.id}):`, reason);

      await supabase
        .from('line_notifications')
        .update({ status: 'failed', error: String(reason).slice(0, 500) })
        .eq('id', row.id);
    }
  }
}

module.exports = { flushNotifications };
