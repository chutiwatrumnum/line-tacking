// บิลค้างชำระ และลิงก์ใบสรุปที่ใช้ตอบลูกค้าในแชท
//
// เดิมไฟล์นี้รับสลิปที่ลูกค้าส่งเข้าไลน์ด้วย ตอนนี้ตัดออกแล้ว
// สลิปรับที่หน้าใบสรุปทางเดียว เพราะหน้านั้นรู้ตั้งแต่แรกว่าเป็นบิลไหน
// (ดู RPC submit_order_slip ฝั่ง guppy-order)
// ทางแชทต้องเดา และเดาได้เฉพาะตอนลูกค้ามีบิลค้างใบเดียว มากกว่านั้นร้านต้องจับคู่เอง
//
// ยังจงใจไม่อ่านตัวเลขจากรูปมาตัดสินใจแทนคน — สลิปเป็นไฟล์ภาพ แก้ยอดได้ใน 30 วินาที
// ระบบที่เชื่อ OCR คือระบบที่ยืนยันสลิปปลอมให้เอง คนต้องเป็นคนกดยืนยัน

const { createClient } = require('@supabase/supabase-js');
const { render } = require('./templates');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const LIFF_ID = process.env.LIFF_ID || '2010766267-xz9flUvC';

/** บิลที่ลูกค้าคนนี้ยังไม่ได้ชำระ */
async function getPendingOrders(userId) {
  const { data, error } = await supabase
    .rpc('pending_orders_for_line_user', { p_line_user_id: userId });

  if (error) throw new Error(`หาบิลค้างไม่สำเร็จ: ${error.message}`);
  return data || [];
}

/** ลิงก์ใบสรุปออเดอร์ — รูปแบบเดียวกับที่ร้านส่งให้ลูกค้าตอนปิดบิล */
function orderLink(orderId) {
  return `https://liff.line.me/${LIFF_ID}/o/${orderId}`;
}

/**
 * ข้อความตอบปุ่ม "บิลค้างชำระ"
 * ลิงก์ที่ร้านส่งตอนปิดบิลจมหายไปในแชทง่าย ตรงนี้ดึงกลับมาให้เอง
 */
async function buildOrdersReply(orders) {
  if (orders.length === 0) {
    return render('bills_empty', {}, '🧾 ตอนนี้ไม่มีบิลค้างชำระครับ');
  }

  const lines = ['🧾 บิลที่ยังไม่ได้ชำระ'];
  for (const o of orders) {
    lines.push(
      '',
      `${o.order_number} — ฿${Number(o.total_amount).toLocaleString()}`,
      orderLink(o.id)
    );
  }
  lines.push('', await render('bills_footer', {}, ''));
  return lines.join('\n');
}

module.exports = { getPendingOrders, buildOrdersReply, orderLink, LIFF_ID };
