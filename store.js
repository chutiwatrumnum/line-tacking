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
 * เขียนเฉพาะบิลที่ยังเป็น pending/shipped หรือถึงแล้วแต่ยังไม่มีเวลา — ห้ามทับบิลที่ยกเลิกไปแล้ว
 * และทำให้เรียกซ้ำได้ด้วย เพราะรอบสองจะไม่มีแถวไหนเข้าเงื่อนไขอีก
 */
async function markDelivered(orderId, deliveredAt, trackingNumber) {
  // เวลาที่ไปรษณีย์บันทึกว่าถึง ไม่ใช่เวลาที่บอทเห็น (ตรงกับ comment ของคอลัมน์)
  // ตอนโควต้า LINE เต็ม บิลถูกปิดตอนลูกค้ากดเช็ค ซึ่งอาจช้ากว่าของถึงเป็นวัน
  // ใช้เวลาที่กด ตัวเลข "ส่งกี่วันถึง" ในหน้าแอดมินจะยืดออกไปเอง
  const at = (deliveredAt || new Date()).toISOString();

  // ปิดทั้งใบที่ถือแถวติดตาม และทุกใบที่มีกล่องนี้อยู่ในรายการ
  //
  // แพ็ครวมกล่องแล้ว sync_parcel_subscription ให้ใบแรกถือแถวไว้ใบเดียว ('shared')
  // เดิมปิดแค่ใบนั้น ใบที่รวมกล่องจึงค้าง "ส่งแล้ว" ตลอดไป ทั้งที่อยู่กล่องเดียวกันและถึงพร้อมกัน
  const ids = new Set();
  if (orderId) ids.add(orderId);

  if (trackingNumber) {
    const { data, error } = await supabase
      .from('orders')
      .select('id')
      .contains('tracking_numbers', [trackingNumber]);

    if (error) console.error('[STORE] หาบิลที่ใช้เลขนี้ไม่สำเร็จ:', error.message);
    else for (const row of data || []) ids.add(row.id);
  }

  // บิลเดียวแยกส่งหลายกล่อง ปิดได้ต่อเมื่อถึงครบทุกกล่อง
  // ปิดตั้งแต่กล่องแรกถึง จะทำให้ sync_parcel_subscription เห็นว่าบิลจบแล้ว
  // แล้วเลิกตามกล่องที่เหลือ ลูกค้าที่รอกล่องสองจะไม่มีวันรู้ว่าของถึงไหน
  //
  // ฝั่ง DB เป็นคนนับกล่องที่ยังเดินทางอยู่ ต้องเรียกหลัง unsubscribe ของกล่องนี้แล้วเท่านั้น
  for (const id of ids) {
    const { data, error } = await supabase.rpc('close_order_if_all_delivered', {
      p_order_id: id,
      p_delivered_at: at,
    });

    if (error) console.error(`[STORE] ปิดบิล ${id} ไม่สำเร็จ:`, error.message);
    else if (data && data.reason === 'boxes_in_transit') {
      console.log(`[STORE] บิล ${id} ยังเหลืออีก ${data.remaining} กล่อง ยังไม่ปิด`);
    }
  }
}

/**
 * บิลล่าสุดของลูกค้าคนนี้ที่ไปรษณีย์ส่งถึงภายใน days วัน — null ถ้าไม่มี
 *
 * ของที่ถึงแล้วถูกลบออกจาก parcel_subscriptions ไปแล้ว ต้องมาดูที่บิลแทน
 * delivered_at บอทเป็นคนเขียน บิลที่ร้านกด "ถึงแล้ว" เองไม่มีค่านี้จึงไม่ถูกหยิบมา
 * (ร้านกดตอนไหนก็ได้ บอกลูกค้าว่าของถึงเมื่อไหร่จากตรงนั้นไม่ได้)
 */
async function getLastDelivered(userId, days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('orders')
    .select('order_number, tracking_number, delivered_at')
    .eq('line_user_id', userId)
    .eq('status', 'delivered')
    .not('tracking_number', 'is', null)
    .neq('tracking_number', '')
    .gte('delivered_at', since)
    .order('delivered_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // อ่านไม่ได้ = ตอบแบบไม่มีพัสดุตามเดิม ดีกว่าลูกค้ากดแล้วเงียบ
  if (error) {
    console.error('[STORE] หาบิลที่ส่งถึงล่าสุดไม่สำเร็จ:', error.message);
    return null;
  }
  return data;
}

/**
 * จำบัญชี LINE ที่ทักเข้ามา เพื่อให้หน้าร้านเลือกผูกกับบิลได้เอง
 *
 * บิลผูกบัญชีตอนลูกค้าเปิดลิงก์ใบสรุปในแอป LINE ซึ่งผูกผิดบัญชีได้ง่าย
 * (ลูกค้ามีไลน์สองบัญชี เปิดลิงก์ด้วยอันหนึ่ง ทักแชทด้วยอีกอัน — เจอมาแล้วกับบิล B20261122-0624)
 * ผูกผิดแล้วแจ้งเตือนทุกอย่างหายเงียบ เพราะ LINE ตอบว่าสำเร็จให้ push ที่ส่งหาคนที่ไม่ได้แอด OA
 *
 * ของเดิมแก้ได้ทางเดียวคือให้ลูกค้าเปิดลิงก์ใหม่ ซึ่งต้องไปรบกวนลูกค้าทุกครั้ง
 * ทั้งที่ร้านกำลังเปิดแชทคนนั้นค้างอยู่แล้ว — id ของเขาผ่านมือบอทไปตอนทักมานั่นเอง แค่ไม่เคยเก็บ
 *
 * LINE ไม่มี API ให้ดึงรายชื่อเพื่อนย้อนหลัง (403 สำหรับบัญชีที่ไม่ได้รับรอง)
 * เก็บตอนทักมาจึงเป็นทางเดียวที่มี
 *
 * ล้มเหลวไม่ต้องสนใจ นี่เป็นงานข้างเคียง ห้ามทำให้การตอบลูกค้าพัง
 */
async function rememberContact(trackingUserId, displayName, pictureUrl) {
  const { error } = await supabase.from('line_contacts').upsert(
    {
      line_user_id: trackingUserId,
      display_name: displayName || null,
      picture_url: pictureUrl || null,
      last_message_at: new Date().toISOString(),
    },
    { onConflict: 'line_user_id' }
  );

  if (error) console.error('[STORE] จำบัญชี LINE ไม่สำเร็จ:', error.message);
}

/**
 * ลืมบัญชีที่บล็อกหรือลบ OA ไปแล้ว (LINE ส่ง unfollow มาตอนนั้น)
 *
 * รายการให้ร้านเลือกต้องมีแต่บัญชีที่ push ถึงได้จริง ไม่งั้นก็แค่ย้ายปัญหาเดิมมาไว้ในรายการ
 * — ร้านเลือกชื่อที่คุ้น แล้วข้อความก็หายเงียบเหมือนเดิม
 */
async function forgetContact(trackingUserId) {
  const { error } = await supabase
    .from('line_contacts')
    .delete()
    .eq('line_user_id', trackingUserId);

  if (error) console.error('[STORE] ลบบัญชี LINE ที่เลิกติดตามไม่สำเร็จ:', error.message);
}

module.exports = { subscribe, unsubscribe, getAll, updateStatus, getPushTiers, markDelivered, getLastDelivered, rememberContact, forgetContact };
