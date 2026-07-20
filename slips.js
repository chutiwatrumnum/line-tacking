// รับสลิปโอนเงินที่ลูกค้าส่งเข้าไลน์
//
// จงใจไม่อ่านตัวเลขจากรูปมาตัดสินใจแทนคน
// สลิปเป็นไฟล์ภาพ แก้ยอดได้ใน 30 วินาที ระบบที่เชื่อ OCR คือระบบที่ยืนยันสลิปปลอมให้เอง
// ที่นี่แค่เก็บสลิปไว้ + จับคู่บิลที่น่าจะใช่ แล้วให้คนกดยืนยัน
//
// ตอบลูกค้าด้วย replyMessage เสมอ = ไม่กินโควต้า push

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'https://ecommerce-guppy.web.app';
const LIFF_ID = process.env.LIFF_ID || '2010766267-xz9flUvC';

/** ดาวน์โหลดรูปที่ลูกค้าส่งมาจาก LINE Content API */
async function downloadLineImage(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } }
  );

  if (!res.ok) {
    throw new Error(`ดึงรูปจาก LINE ไม่สำเร็จ (${res.status})`);
  }

  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

/**
 * เก็บสลิปแล้วเดาว่าเป็นของบิลไหน
 * ผูกให้อัตโนมัติเฉพาะตอนที่ลูกค้ามีบิลค้างใบเดียว — มากกว่านั้นปล่อยว่างให้ร้านเลือก
 */
async function handleSlipImage({ messageId, userId }) {
  const { buffer, contentType } = await downloadLineImage(messageId);

  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const path = `${userId}/${Date.now()}-${messageId}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from('slips')
    .upload(path, buffer, { contentType, upsert: false });

  if (uploadError) throw new Error(`อัปโหลดสลิปไม่สำเร็จ: ${uploadError.message}`);

  const { data: pending, error: pendingError } = await supabase
    .rpc('pending_orders_for_line_user', { p_line_user_id: userId });

  if (pendingError) throw new Error(`หาบิลค้างไม่สำเร็จ: ${pendingError.message}`);

  const orders = pending || [];
  // ผูกอัตโนมัติเมื่อไม่มีอะไรให้กำกวม
  const matched = orders.length === 1 ? orders[0] : null;

  const { error: insertError } = await supabase.from('payment_slips').insert({
    line_user_id: userId,
    image_path: path,
    order_id: matched?.id || null,
  });

  if (insertError) throw new Error(`บันทึกสลิปไม่สำเร็จ: ${insertError.message}`);

  return { matched, pendingCount: orders.length };
}

/** ข้อความตอบลูกค้า — บอกตามจริงว่ายังไม่ได้ยืนยัน ไม่ให้เข้าใจผิดว่าจ่ายเสร็จแล้ว */
function buildSlipReply({ matched, pendingCount }) {
  if (matched) {
    return [
      '🧾 ได้รับสลิปแล้วครับ',
      `บิล ${matched.order_number} ยอด ฿${Number(matched.total_amount).toLocaleString()}`,
      '',
      'ทางร้านกำลังตรวจสอบ เมื่อยืนยันแล้วสถานะในใบสรุปจะเปลี่ยนเป็น "ชำระเงินแล้ว" ครับ 🙏',
    ].join('\n');
  }

  if (pendingCount === 0) {
    return [
      '🧾 ได้รับสลิปแล้วครับ',
      '',
      'แต่ระบบไม่พบบิลที่ค้างชำระของคุณ',
      'ทางร้านจะตรวจสอบให้อีกครั้งครับ 🙏',
    ].join('\n');
  }

  return [
    '🧾 ได้รับสลิปแล้วครับ',
    `พบบิลค้างชำระ ${pendingCount} รายการ`,
    '',
    'ทางร้านจะตรวจสอบว่าเป็นของบิลไหนแล้วอัปเดตให้ครับ 🙏',
  ].join('\n');
}

module.exports = { handleSlipImage, buildSlipReply, PUBLIC_APP_URL, LIFF_ID };
