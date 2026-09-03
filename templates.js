// ข้อความที่ส่งหาลูกค้า — ร้านแก้เองได้จากหน้าตั้งค่า
//
// เดิมข้อความฝังอยู่ในโค้ด แก้คำทีต้อง deploy ที
// ตอนนี้อยู่ในตาราง message_templates ที่หน้าตั้งค่าเขียนได้
//
// แคชไว้ในหน่วยความจำ ไม่ยิงฐานข้อมูลทุกข้อความ — บอทตอบแชทบ่อยมาก
// แคชสั้น ๆ พอ ร้านแก้คำแล้วเห็นผลภายในไม่กี่นาที ไม่ต้องรีสตาร์ต

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const CACHE_MS = 60 * 1000;

let cache = null;
let cachedAt = 0;

async function load() {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;

  const { data, error } = await supabase.from('message_templates').select('key, body');
  if (error) {
    // ฐานข้อมูลล่มไม่ควรทำให้บอทเงียบ — ใช้ของเก่าที่แคชไว้ต่อถ้ามี
    console.error('[TEMPLATE] โหลดไม่สำเร็จ:', error.message);
    return cache || {};
  }

  cache = Object.fromEntries((data || []).map((r) => [r.key, r.body]));
  cachedAt = Date.now();
  return cache;
}

/**
 * ดึงข้อความตาม key แล้วแทนค่าตัวแปร {{ชื่อ}}
 *
 * fallback คือข้อความที่ใช้ตอนหาใน DB ไม่เจอ — กันเคสที่ยังไม่ได้รัน migration
 * หรือร้านเผลอลบแถวทิ้ง บอทจะได้ไม่ตอบว่างเปล่าออกไป
 */
async function render(key, vars = {}, fallback = '') {
  const templates = await load();
  let body = templates[key] || fallback;
  if (!body) return '';

  for (const [k, v] of Object.entries(vars)) {
    body = body.split(`{{${k}}}`).join(v == null ? '' : String(v));
  }
  return body;
}

/** ล้างแคชทันที ใช้ตอนเทสหรือถ้าอยากให้เห็นผลเดี๋ยวนั้น */
function clearCache() {
  cache = null;
  cachedAt = 0;
}

module.exports = { render, clearCache };
