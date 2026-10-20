/**
 * 签到状态文件（data/checkin_status.json）读写。
 *
 * 用途：记录每个账号最近一次查到的 VIP 到期时间，供 WebUI「账号管理」面板展示。
 * 由 main.js 在签到结束时写入，webui/server.js 在 GET /api/accounts 时读取。
 *
 * 文件内容形如：
 *   { "updatedAt": "2026-10-20T00:00:00.000Z", "date": "2026-10-20",
 *     "vipExpiry": { "123456789": "2026-12-31 23:59:59" },
 *     "vipExpiryAt": { "123456789": "2026-10-20" } }
 *
 * 关键约束（这里出过 bug，勿回退）：
 *   1. 写盘必须与文件已有内容**合并**，不能整份覆盖。手动触发会跳过当日已签到的账号，
 *      被跳过的账号本轮不查询 VIP 详情，覆盖写会把之前写好的到期时间全部抹掉，
 *      面板随即退回「未获取」。
 *   2. 「未知」表示本轮没查到有效值，不能拿它覆盖已有的正确值。
 *   3. vipExpiryAt 记录该到期时间是哪天查到的，用于避免每次手动触发都对
 *      全部已签到账号重查一遍 VIP 详情（跳过机制本就是为了减少重复请求）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 无效到期时间的占位值（main.js 查不到时使用），不写入状态文件、也不覆盖已有值 */
const UNKNOWN_EXPIRY = '未知'

/** 是否为可用的到期时间值（非空字符串且不是「未知」占位） */
function isValidExpiry(value) {
  return typeof value === 'string' && value.trim() !== '' && value !== UNKNOWN_EXPIRY
}

/**
 * 读取完整状态：到期时间映射 + 各映射的取得日期。
 * 文件缺失 / JSON 损坏 / 结构不符时返回空结构（不抛异常，调用方无需 try）。
 * @param {string} file 状态文件路径
 * @returns {{vipExpiry: Record<string,string>, vipExpiryAt: Record<string,string>}}
 */
export function readCheckinStatus(file) {
  const empty = { vipExpiry: {}, vipExpiryAt: {} }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const vipExpiry = parsed?.vipExpiry
    const vipExpiryAt = parsed?.vipExpiryAt
    return {
      vipExpiry: vipExpiry && typeof vipExpiry === 'object' && !Array.isArray(vipExpiry) ? vipExpiry : {},
      vipExpiryAt: vipExpiryAt && typeof vipExpiryAt === 'object' && !Array.isArray(vipExpiryAt) ? vipExpiryAt : {},
    }
  } catch {
    return empty
  }
}

/**
 * 只读取到期时间映射（WebUI 账号管理面板只需要这一项）。
 * @param {string} file 状态文件路径
 * @returns {Record<string, string>} userid -> 到期时间
 */
export function readVipExpiries(file) {
  return readCheckinStatus(file).vipExpiry
}

/**
 * 合并本轮查到的到期时间与文件已有映射（新值覆盖同名旧值，未出现于本轮的旧值保留）。
 * fresh 里的空值 / 非字符串 / 「未知」会被忽略，避免把正确值抹成无效值。
 * @param {Record<string, string>} existing 文件里已有的映射
 * @param {Record<string, string>} fresh 本轮新查到的映射
 * @returns {Record<string, string>} 合并结果
 */
export function mergeVipExpiries(existing, fresh) {
  const merged = { ...(existing && typeof existing === 'object' ? existing : {}) }
  for (const [uid, exp] of Object.entries(fresh || {})) {
    if (isValidExpiry(exp)) merged[uid] = exp
  }
  return merged
}

/**
 * 原子写入状态文件（tmp + rename）。
 * 合并结果为空时不写盘（避免无意义地刷新 updatedAt / date）。
 * @param {string} file 状态文件路径
 * @param {{date: string, vipExpiry: Record<string,string>, vipExpiryAt?: Record<string,string>}} payload
 * @returns {{ok: true} | {ok: false, error: string}} 写入结果；失败不抛异常，由调用方决定是否告警
 */
export function writeCheckinStatus(file, { date, vipExpiry, vipExpiryAt }) {
  if (!vipExpiry || Object.keys(vipExpiry).length === 0) return { ok: true }
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const payload = { updatedAt: new Date().toISOString(), date, vipExpiry }
    if (vipExpiryAt && Object.keys(vipExpiryAt).length > 0) payload.vipExpiryAt = vipExpiryAt
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略清理失败 */ }
    return { ok: false, error: error?.message || String(error) }
  }
}

/** 导出给调用方做「今天是否已查过」判断，与写入时的有效值口径保持一致 */
export { isValidExpiry, UNKNOWN_EXPIRY }
