import { printBlue, printGreen, printMagenta, printRed, printYellow } from "./utils/colorOut.js";
import { hasSecretWriteToken, setRepoSecret } from "./utils/githubSecrets.js";
import { maskDisplayName, maskIdentifier, sanitizeForLog, summarizeResponse } from "./utils/safeLog.js";
import { sendNotify } from "./utils/notify.js";
import { close_api, delay, send, startService, waitForApi } from "./utils/utils.js";
import { writeUserinfoFile, parseUserinfoJson } from "./utils/userinfo.js";
import { beijingDateStr, isBeijingSunday } from "./utils/date.js";
import { checkinStateEnabled, loadDoneToday, saveDoneToday } from "./utils/checkinState.js";
import { mergeVipExpiries, readCheckinStatus, writeCheckinStatus } from "./utils/checkinStatus.js";

/**
 * 读取进程 stdin 的全部内容（用于从父进程安全接收凭据）。
 * 环境变量可被同容器/同主机的其他进程通过 /proc/<pid>/environ 读取，
 * 因此 WebUI 调用签到子进程时改用 stdin 传递凭据。
 * @returns {Promise<string>} 去除首尾空白后的文本
 */
function readStdin() {
  return new Promise(resolve => {
    // 无 stdin（如 Actions/定时任务不设置该标记时不会走到这里）
    if (!process.stdin || process.stdin.isTTY) return resolve('')
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', () => resolve(data.trim()))
    process.stdin.on('error', () => resolve(data.trim()))
  })
}

/**
 * 获取 USERINFO 原始文本。优先级：
 *   1. USERINFO 环境变量（GitHub Actions / Docker entrypoint 兼容路径）
 *   2. USERINFO_STDIN=1 时从 stdin 读取（WebUI 子进程路径，避免凭据进入环境变量）
 * @returns {Promise<string>}
 */
async function loadUserinfoRaw() {
  const fromEnv = process.env.USERINFO
  if (fromEnv && fromEnv.trim()) return fromEnv
  if (['1', 'true', 'yes', 'on'].includes(String(process.env.USERINFO_STDIN || '').trim().toLowerCase())) {
    return await readStdin()
  }
  return ''
}

async function main() {

  const USERINFO = await loadUserinfoRaw()
  let needRefresh = false
  const userinfo = parseUserinfoJson(USERINFO)
  if (!userinfo) {
    throw new Error("未配置或 USERINFO 格式错误（应为 [{\"userid\":\"...\",\"token\":\"...\"}]）")
  }

  // 启动服务并等待就绪（避免冷启动竞态导致首个请求失败）
  const api = startService()
  try {
    await waitForApi()
  } catch (e) {
    close_api(api)
    throw e
  }

  // 日期/星期统一按北京时间计算（与运行环境时区无关，兼容 UTC 的 Actions 与任意时区的 Docker/本地）
  const now = new Date()
  const date = beijingDateStr(now)

  // 手动触发（WebUI「立即签到」/ scheduler.js once）时跳过当日已完成签到的账号；
  // 定时任务与 GitHub Actions 不设置该标记，保持完整执行。
  const skipDone = ['1', 'true', 'yes', 'on'].includes(String(process.env.CHECKIN_SKIP_DONE || '').trim().toLowerCase())
  const stateEnabled = checkinStateEnabled(skipDone)
  const doneSet = stateEnabled ? loadDoneToday(date) : new Set()
  let skippedCount = 0

  // WebUI 拉起时把各账号 VIP 到期时间写盘（供「账号管理」展示）；Actions/命令行不设置该变量。
  const statusFile = process.env.CHECKIN_STATUS_FILE
  // 文件里已有的映射：用于①跳过账号的到期时间刷新判断 ②写盘时与旧数据合并（绝不能整份覆盖）
  const existingStatus = statusFile ? readCheckinStatus(statusFile) : { vipExpiry: {}, vipExpiryAt: {} }
  // 本轮实际查到（或保留了旧值）的到期时间，写盘时与 existingStatus.vipExpiry 合并
  const vipExpiryAt = { ...existingStatus.vipExpiryAt }

  const errorMsg = {}
  // 通知结果收集（并行完成后按账号原始顺序填充）
  const notifyResults = []
  // userid -> VIP 到期时间（仅 WebUI 模式：设置 CHECKIN_STATUS_FILE 时收集并写盘）
  const vipExpiries = {}
  let hasError = false

  // 单账号完整签到流程：并行时各账号独立执行，账号内部保持原有请求节奏（VIP 领取间隔 30s）
  async function processAccount(user, index) {
    const tag = `[#${String(index + 1).padStart(String(userinfo.length).length, '0')}/${userinfo.length}]`
    const accountErrors = {} // 该账号的错误集（键名含账号标识，账号之间互不冲突，可安全并行写入）
    try {
      // 手动触发：当日已完成签到（无任何错误）的账号直接跳过，不再请求酷狗 API
      if (skipDone && doneSet.has(String(user.userid))) {
        const safeUserId = maskIdentifier(user.userid)
        printYellow(`${tag} 账号 ${safeUserId} 今日已签到，跳过`)
        skippedCount++
        // 刷新账号管理面板的 VIP 到期时间：今日已签到的账号本轮不会再走下面的
        // VIP 详情查询，若不补一次，面板会一直停在旧值或「未获取」。
        // 为了避免每次手动触发都对全部已签到账号重查（跳过机制本就是为了减少请求），
        // 仅当该账号的到期时间不是今天查到的时候才补一次。
        if (statusFile && vipExpiryAt[String(user.userid)] !== date) {
          try {
            const headers = { 'cookie': 'token=' + user.token + '; userid=' + user.userid }
            const vipInfo = await send(`/user/vip/detail?timestrap=${Date.now()}`, "GET", headers)
            const end = vipInfo?.status === 1 && Array.isArray(vipInfo.data?.busi_vip) && vipInfo.data.busi_vip.length > 0
              ? vipInfo.data.busi_vip[0].vip_end_time
              : null
            if (end) {
              vipExpiries[String(user.userid)] = end
              vipExpiryAt[String(user.userid)] = date
            }
          } catch { /* 刷新失败不影响跳过，保留文件里的旧值 */ }
        }
        return {
          nickname: safeUserId, status: '跳过', listen: '今日已签到',
          vipClaim: '-', vipExpiry: '-', error: ''
        }
      }

      // 单账号异常隔离：任何一个账号的请求/解析出错，只记录该账号失败，不影响其余账号继续执行
      try {
        let headers = { 'cookie': 'token=' + user.token + '; userid=' + user.userid }
        const userDetail = await send(`/user/detail?timestrap=${Date.now()}`, "GET", headers)
        if (userDetail?.data?.nickname == null) {
          const safeUserId = maskIdentifier(user.userid)
          printRed(`${tag} token过期或账号不存在, userid: ${safeUserId}`)
          accountErrors[safeUserId] = {
            msg: `token过期或账号不存在, userid: ${safeUserId}`,
            data: summarizeResponse(userDetail)
          }
          return {
            nickname: safeUserId, status: '失败', listen: '账号不存在',
            vipClaim: '0/8', vipExpiry: '未知', error: 'token过期或账号不存在'
          }
        }
        const safeNickname = maskDisplayName(userDetail.data.nickname)
        printMagenta(`${tag} 账号 ${safeNickname} 开始签到`)

        // 周日刷新token
        if (isBeijingSunday(now)) {
          const refreshToken = await send(`/login/token?timestrap=${Date.now()}`, "POST", headers)
          // 必须校验新 token 确实是非空字符串：上游偶发返回 status=1 却不带 data.token，
          // 旧写法 `data.token !== user.token` 在此时成立（undefined !== 旧值），会把
          // user.token 赋成 undefined；随后整份凭据数组被 JSON.stringify 写回（undefined
          // 字段直接消失），该账号永久失效、只能手工重新登录。
          // 结论：宁可这次不刷新，也绝不能把空值写进凭据。
          const rawNewToken = refreshToken?.status == 1 ? refreshToken?.data?.token : null
          const newToken = typeof rawNewToken === 'string' ? rawNewToken.trim() : ''
          if (newToken && newToken !== String(user.token || '').trim()) {
            needRefresh = true
            printYellow(`${tag} 账号 ${safeNickname} 需要刷新token`)
            user.token = newToken
            // 用新 token 重建本次请求的 headers，使后续听歌/VIP 领取使用刷新后的凭证
            headers = { 'cookie': 'token=' + user.token + '; userid=' + user.userid }
          } else if (refreshToken?.status == 1 && !newToken) {
            // 刷新接口返回成功但没给有效 token：保持原 token 继续本次签到
            printYellow(`${tag} 账号 ${safeNickname} token 刷新响应缺少有效 token，已保留原 token`)
          }
        }

        // 开始听歌
        printYellow(`${tag} 账号 ${safeNickname} 开始听歌领取VIP...`)
        // 听歌获取vip
        const listen = await send(`/youth/listen/song?timestrap=${Date.now()}`, "GET", headers)

        let listenStatus = '未知'
        // 听歌是否成功（含"今日已领取"）：决定该账号当日是否已被标记为完成
        let listenOk = false
        if (listen.status === 1) {
          printGreen(`${tag} 账号 ${safeNickname} 听歌领取成功`)
          listenStatus = '成功'
          listenOk = true
        } else if (listen.error_code === 130012) {
          printGreen(`${tag} 账号 ${safeNickname} 今日已领取`)
          listenStatus = '今日已领取'
          listenOk = true
        } else {
          accountErrors[`${safeNickname} listen`] = summarizeResponse(listen)
          printRed(`${tag} 账号 ${safeNickname} 听歌领取失败`)
          listenStatus = '失败'
        }

        let claimCount = 0
        let claimTotal = 0
        // 领取阶段是否出现"非预期"失败：仅此类失败阻止当天标记完成。
        // 次数用光（30002）属于正常终态，不算失败。
        let claimFailed = false
        for (let i = 1; i <= 8; i++) {
          const ad = await send(`/youth/vip?timestrap=${Date.now()}`, "GET", headers)
          claimTotal = i
          if (ad.status === 1) {
            printGreen(`${tag} 账号 ${safeNickname} 第${i}次领取成功`)
            claimCount++
            if (i != 8) {
              await delay(30 * 1000)
            }
          } else if (ad.error_code === 30002) {
            printGreen(`${tag} 账号 ${safeNickname} 今天次数已用光`)
            // 次数用光：把总次数记为已尝试次数，避免通知里出现 3/7 这类含混计数
            claimTotal = claimCount
            break
          } else {
            printRed(`${tag} 账号 ${safeNickname} 第${i}次领取失败`)
            accountErrors[`${safeNickname} ad`] = summarizeResponse(ad)
            claimFailed = true
            claimTotal = claimCount
            break
          }
        }

        let vipExpiry = '未知'
        const vip_details = await send(`/user/vip/detail?timestrap=${Date.now()}`, "GET", headers)
        if (vip_details.status === 1 && Array.isArray(vip_details.data?.busi_vip) && vip_details.data.busi_vip.length > 0) {
          vipExpiry = vip_details.data.busi_vip[0].vip_end_time
          // 到期时间不再刷进实时日志（改在 WebUI「账号管理」查看，避免每账号 2 行刷屏），
          // 但仍会写入通知内容与账号状态文件；WebUI 模式下通过 CHECKIN_STATUS_FILE 上报。
          if (!process.env.CHECKIN_STATUS_FILE) {
            printBlue(`${tag} 账号 ${safeNickname} VIP到期时间：${vipExpiry}\n`)
          }
        } else {
          printRed(`${tag} 账号 ${safeNickname} VIP 详情获取失败\n`)
          accountErrors[`${safeNickname} vip_details`] = summarizeResponse(vip_details)
        }

        // 当日"已完成"的判定口径：
        //   听歌成功（含今日已领取）即视为当日该做的已完成——后续 8 次领取广告位失败
        //   多为酷狗侧限流/风控（如 20028），手动重跑也不会成功，只会重复请求并报错。
        //   因此仅当「听歌本身失败」或「VIP 详情查询失败」时才不标记完成，保留重试机会。
        // 注意：领取失败仍会写入 accountErrors 并出现在"异常信息如下"中，只是不再阻止跳过。
        const vipDetailFailed = Boolean(accountErrors[`${safeNickname} vip_details`])
        if (listenOk && !vipDetailFailed && stateEnabled) {
          doneSet.add(String(user.userid))
          if (claimFailed) {
            printYellow(`${tag} 账号 ${safeNickname} 今日听歌已完成，领取失败不影响标记`)
          }
        }

        // 通知中的领取次数：统一显示 "已领取 N 次"，仅在成功 8 次时展示总次数上限
        // 顺带记录到期时间，供 WebUI「账号管理」展示（仅在有状态文件时收集）
        if (process.env.CHECKIN_STATUS_FILE) {
          vipExpiries[String(user.userid)] = vipExpiry
          if (vipExpiry !== '未知') vipExpiryAt[String(user.userid)] = date
        }
        return {
          nickname: safeNickname,
          status: listenStatus === '失败' || claimCount === 0 ? '部分失败' : '成功',
          listen: listenStatus,
          vipClaim: claimTotal > 0 ? `${claimCount}/${claimTotal}` : `${claimCount}`,
          vipExpiry,
          error: ''
        }
      } catch (err) {
        const safeUserId = maskIdentifier(user.userid || '未知')
        printRed(`${tag} 账号 ${safeUserId} 处理异常：${err && err.message ? err.message : String(err)}`)
        accountErrors[safeUserId] = { msg: '处理异常', error: err && err.message ? err.message : String(err) }
        return {
          nickname: safeUserId, status: '失败', listen: '异常',
          vipClaim: '0/8', vipExpiry: '未知',
          error: err && err.message ? err.message : String(err)
        }
      }
    } finally {
      // 各账号错误统一合并到全局（键名含账号标识互不冲突），保证"异常信息如下"输出与原有格式一致
      Object.assign(errorMsg, accountErrors)
    }
  }

  try {
    // 并发数（账号级并行）：默认不限制——有几个账号就几路全部并行；
    // CHECKIN_CONCURRENCY 可选限流：设 N = 最多 N 路，设 1 = 逐个串行（与旧版行为一致）
    const rawConcurrency = String(process.env.CHECKIN_CONCURRENCY || '').trim().toLowerCase()
    let CONCURRENCY
    if (!rawConcurrency || rawConcurrency === 'max' || rawConcurrency === '0') {
      CONCURRENCY = userinfo.length
    } else {
      const n = parseInt(rawConcurrency, 10)
      CONCURRENCY = Math.min(Math.max(1, n || 1), Math.max(1, userinfo.length))
    }
    if (userinfo.length > 1) {
      const source = (!rawConcurrency || rawConcurrency === 'max' || rawConcurrency === '0')
        ? '全部账号同时并行'
        : `限流 ${CONCURRENCY} 路（CHECKIN_CONCURRENCY，1 为逐个串行）`
      printYellow(`多账号并行签到：${CONCURRENCY} 个账号同时进行（${source}）`)
    }

    // 工作池：CONCURRENCY 个 worker 从队列取账号执行；results 始终按账号原始顺序排列
    const results = new Array(userinfo.length)
    let cursor = 0
    const worker = async () => {
      while (cursor < userinfo.length) {
        const index = cursor++
        results[index] = await processAccount(userinfo[index], index)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, userinfo.length) }, worker))

    notifyResults.push(...results)
    // 仅「听歌/凭据/VIP详情」类错误算失败；广告位领取失败（键名以 " ad" 结尾）属降级告警：
    // 该账号当日仍被标记完成、不会重跑，因此不应让整轮运行判定为异常。
    hasError = Object.keys(errorMsg).some(k => !k.endsWith(' ad'))
  } finally {
    close_api(api)
  }

  // 把本轮查到的 VIP 到期时间写盘，供 WebUI「账号管理」展示。
  // 仅在 WebUI 拉起签到子进程时设置 CHECKIN_STATUS_FILE；Actions/命令行不写。
  // 必须与文件里已有数据合并而不是整份覆盖：手动触发会跳过当日已签到的账号，
  // 被跳过的账号本轮不查询 VIP 详情，覆盖写会把之前（定时任务）写好的到期时间全部抹掉。
  if (statusFile) {
    const result = writeCheckinStatus(statusFile, {
      date,
      vipExpiry: mergeVipExpiries(existingStatus.vipExpiry, vipExpiries),
      vipExpiryAt,
    })
    // 写盘失败不影响签到结果，但必须显式告警，否则面板会一直停在旧值
    if (!result.ok) printYellow(`警告：账号状态写入失败（${result.error}）`)
  }

  // 持久化当日已完成签到的账号（跨天自动失效），供手动触发时跳过
  if (stateEnabled) {
    if (saveDoneToday(date, doneSet)) {
      printYellow(`今日已完成签到的账号已记录（${doneSet.size} 个），手动触发时将自动跳过`)
    } else {
      // 写盘失败不应中断签到，但必须显式告警：静默失败会让"手动触发跳过已签到"
      // 悄悄失效（如 Actions 环境下无 USERINFO_FILE、默认 data 目录不可写）。
      printYellow(`警告：当日签到状态写入失败（${doneSet.size} 个账号未记录），手动触发将不会跳过已签到账号`)
    }
  }

  // 刷新后的凭据持久化：Docker 部署写入 USERINFO_FILE 文件（挂载卷），
  // Actions 部署写入 GitHub Secret <USERINFO>（使用完整 userinfo 数组，保留所有用户包括过期账号）
  let secretError = null
  // 兜底校验：写回前确认每个账号的 token 都是非空字符串。
  // 凭据文件/Secret 是整份覆盖写的，写进一次 undefined（JSON 序列化会直接丢掉该字段）
  // 就意味着该账号永久失效，所以宁可本次不写回也不要把残缺数组落盘。
  const invalidUsers = needRefresh
    ? userinfo.filter(u => !u || typeof u.token !== 'string' || !u.token.trim())
    : []
  if (invalidUsers.length > 0) {
    printRed(`凭据校验失败：${invalidUsers.length} 个账号的 token 无效，已跳过本次凭据写回（原凭据保持不变）`)
  }
  if (needRefresh && invalidUsers.length === 0) {
    const userinfoJSON = JSON.stringify(userinfo)
    // 优先写本地凭据文件（Docker 模式），写失败时降级走 PAT
    let savedToFile = false
    if (process.env.USERINFO_FILE) {
      savedToFile = writeUserinfoFile(userinfoJSON)
    }
    if (savedToFile) {
      printGreen("USERINFO 文件 token 刷新成功")
    } else if (hasSecretWriteToken()) {
      try {
        setRepoSecret("USERINFO", userinfoJSON)
        printGreen("secret <USERINFO> token刷新成功")
      } catch (error) {
        printRed("token刷新失败")
        console.dir(sanitizeForLog({ message: error.message }), { depth: null })
        secretError = new Error("secret <USERINFO> token刷新失败")
      }
    } else {
      printYellow("存在账号需要刷新token，但是未配置PAT，未刷新token最多两个月后过期")
    }
  }

  // 构建通知内容（放在 secret 更新之后、错误抛出之前，确保始终执行）
  const skipCount = notifyResults.filter(r => r.status === '跳过').length
  const allSkipped = skippedCount > 0 && skippedCount === notifyResults.length

  // 手动触发且全部账号均已签到：不重复发送通知，避免冗余打扰
  if (allSkipped) {
    printGreen(`当日（${date}）所有账号均已签到，本次共跳过 ${skipCount} 个账号，无需发送通知`)
    if (Object.keys(errorMsg).length > 0) {
      printRed("异常信息如下:")
      console.dir(sanitizeForLog(errorMsg), { depth: null })
      // 只剩广告位失败时不视为异常（该账号当日已标记完成，重跑无意义）
      if (Object.keys(errorMsg).some(k => !k.endsWith(' ad'))) {
        throw new Error("领取异常")
      }
    }
    if (secretError) {
      throw secretError
    }
    return
  }

  const title = `酷狗签到${hasError ? '异常' : '成功'} ${date}`
  let content = `📅 日期: ${date}\n`
  content += `📊 账号数: ${notifyResults.length}\n`
  const successCount = notifyResults.filter(r => r.status === '成功').length
  const failCount = notifyResults.length - successCount - skipCount
  content += `✅ 成功: ${successCount}  ⏭ 跳过: ${skipCount}  ❌ 失败: ${failCount}\n`

  for (const r of notifyResults) {
    content += `\n【${r.nickname}】\n`
    content += `  🎵 听歌领取: ${r.listen}\n`
    if (r.status === '跳过') {
      content += `  ⏭ 当日已完成签到，本次跳过\n`
      continue
    }
    content += `  🎁 VIP领取: ${r.vipClaim} 次\n`
    content += `  ⏰ VIP到期: ${r.vipExpiry}\n`
    if (r.error) {
      content += `  ⚠️ 错误: ${r.error}\n`
    }
  }

  // 发送通知（确保即使 secret 更新失败也能发出）
  try {
    await sendNotify(title, content)
  } catch (e) {
    printYellow(`通知发送异常: ${e.message}`)
  }

  if (Object.keys(errorMsg).length > 0) {
    printRed("异常信息如下:")
    console.dir(sanitizeForLog(errorMsg), { depth: null })
    // 仅广告位失败（已标记完成、次日才重试）不抛出，避免把正常完成误报为失败
    if (Object.keys(errorMsg).some(k => !k.endsWith(' ad'))) {
      throw new Error("领取异常")
    }
    printYellow("以上仅为领取广告位失败，账号当日已标记完成，次日再试")
  }

  if (secretError) {
    throw secretError
  }

}

// 以 exitCode 标记结果、等事件循环自然排空后退出：
// 避免 Windows 下 process.exit() 与子进程 stdio 管道清理竞态触发 libuv 断言崩溃；
// api 子进程已被 close_api 终止，管道关闭后进程会正常退出。
main().then(() => { process.exitCode = 0 }).catch(e => { console.error(e); process.exitCode = 1 })
