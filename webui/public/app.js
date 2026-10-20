/* kgcheckin webui 前端逻辑（无框架，原生 JS） */
/* eslint-env browser */
'use strict'

const $ = sel => document.querySelector(sel)
const $$ = sel => Array.from(document.querySelectorAll(sel))

/* ────────────────── 基础工具 ────────────────── */

let AUTH = sessionStorage.getItem('kc_auth') || ''
if (AUTH) $('#auth-state').textContent = '已解锁'

let authResolvers = []
// 弹窗已打开时复用的 Promise：否则 5 秒一次的 refreshStatus 会在每次 401 时
// 重新压入 resolver 并重置输入框，把用户正在输入的内容清掉。
let authPromise = null

function askAuth() {
  if (authPromise) return authPromise
  $('#auth-err').textContent = ''
  $('#auth-input').value = AUTH
  authPromise = new Promise(resolve => {
    authResolvers.push(resolve)
    $('#auth-dialog').showModal()
  })
  return authPromise
}

function resolveAuth(ok) {
  if ($('#auth-dialog').open) $('#auth-dialog').close()
  authResolvers.forEach(r => r(ok))
  authResolvers = []
  authPromise = null
}

$('#btn-auth-ok').addEventListener('click', submitAuth)
$('#auth-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth() })
$('#btn-auth-cancel').addEventListener('click', () => resolveAuth(false))
// Esc：拦截默认关闭行为，改为让等待中的请求以「取消」结束，避免 Promise 永久悬挂
$('#auth-dialog').addEventListener('cancel', e => { e.preventDefault(); resolveAuth(false) })

/**
 * 用给定密码探测 /api/status，只关心「通不通过」。
 * 不能走 api()：api() 遇 401 会 await askAuth()，而此刻正是弹窗在等待本次结果，
 * 两边互等即死锁（密码错误时界面无反应）。
 *
 * @param {string} key 待验证的访问密码
 * @returns {Promise<object>} 通过时返回响应体
 */
async function probeAuth(key) {
  const headers = { 'Content-Type': 'application/json' }
  if (key) headers['X-WebUI-Key'] = key
  const res = await fetch('/api/status', { headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

async function submitAuth() {
  AUTH = $('#auth-input').value.trim()
  try {
    await probeAuth(AUTH)
    sessionStorage.setItem('kc_auth', AUTH)
    $('#auth-state').textContent = '已解锁'
    $('#auth-err').textContent = ''
    resolveAuth(true)
    refreshAll()
  } catch (e) {
    $('#auth-err').textContent = `// 密码错误：${e.message}`
  }
}

let ACCOUNTS_KEY = sessionStorage.getItem('kc_accts') || ''
let ACCOUNTS_ID = sessionStorage.getItem('kc_accts_id') || ''

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  if (AUTH) headers['X-WebUI-Key'] = AUTH
  // 显式传入的账号凭据优先：避免账号管理面板已解锁时的全局 ACCOUNTS_KEY
  // 覆盖本次调用专门指定的 admin 密码（否则会用上一次的凭据去验全量签到）
  if (!headers['X-Accounts-Key'] && ACCOUNTS_KEY) headers['X-Accounts-Key'] = ACCOUNTS_KEY
  if (!headers['X-Accounts-Id'] && ACCOUNTS_ID) headers['X-Accounts-Id'] = ACCOUNTS_ID
  const res = await fetch(path, { ...opts, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    // 全局访问密码未通过：弹窗后重试。
    // 账号管理模块的 401（code=accounts-auth）不走这里，由对应面板自行展示锁屏/倒计时
    if (res.status === 401 && data.code === 'webui-auth') {
      const granted = await askAuth()
      if (granted) return api(path, opts)
    }
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

let toastTimer = null
function toast(msg, type = '') {
  const el = $('#toast')
  el.textContent = msg
  el.className = `toast show ${type}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.className = 'toast' }, 4000)
}

/** 按钮冷却倒计时：禁用并在按钮上显示剩余时间（用于验证码 / 二维码的服务端限流） */
function cooldownButton(btn, seconds, idleLabel) {
  const total = Math.max(1, Math.ceil(Number(seconds) || 0))
  clearInterval(btn._coolTimer)
  btn.disabled = true
  let left = total
  const render = () => {
    if (left <= 0) {
      clearInterval(btn._coolTimer)
      btn.disabled = false
      btn.textContent = idleLabel
      return
    }
    const mm = Math.floor(left / 60)
    const ss = left % 60
    btn.textContent = mm > 0
      ? `[ 冷却中(${mm}:${String(ss).padStart(2, '0')}) ]`
      : `[ 冷却中(${left}s) ]`
    left--
  }
  render()
  btn._coolTimer = setInterval(render, 1000)
}

/* ────────────────── 标签页 ────────────────── */

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.toggle('active', t === tab))
    $$('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab.dataset.tab}`))
    if (tab.dataset.tab === 'accounts') loadAccounts()
  })
})

/* ────────────────── 状态徽章 / 账号列表 ────────────────── */

function setChip(id, text, cls) {
  const el = $(id)
  el.textContent = text
  el.className = `chip ${cls || ''}`
}

let lastStatus = null

async function refreshStatus() {
  let s
  try {
    s = await api('/api/status')
  } catch (e) {
    setChip('#chip-cred', `▮ 服务: ${e.message}`, 'err')
    return
  }
  lastStatus = s

  const n = s.accountCount
  setChip('#chip-cred', `▮ 凭据: ${n > 0 ? `${n} 个账号` : '未配置'}`, n > 0 ? 'ok' : 'warn')

  const sched = s.schedule
  setChip(
    '#chip-cron',
    sched.valid ? `▮ 计划: ${sched.cron} → ${sched.nextRuns[0] || '--'}` : '▮ 计划: 无效',
    sched.valid ? 'info' : 'err'
  )
  $('#cron-tip').textContent = sched.valid
    ? (sched.previewSupported === false
        ? `⏰ 定时签到：${sched.cron}（${sched.timezone}）· 该表达式不支持预览执行时间`
        : `⏰ 定时签到：${sched.cron}（${sched.timezone}），接下来执行：${sched.nextRuns.join(' / ') || '-'}`)
    : '⚠ CRON_SCHEDULE 无效，定时签到未启用，只能手动签到'

  setChip('#chip-run', `▮ 签到: ${s.checkin.running ? '运行中' : s.checkin.lastRun ? (s.checkin.lastRun.ok ? '上次成功' : '上次失败') : '从未运行'}`,
    s.checkin.running ? 'warn' : s.checkin.lastRun ? (s.checkin.lastRun.ok ? 'ok' : 'err') : '')
  // 运行中时禁用两个签到按钮，避免重复触发
  const running = s.checkin.running
  const one = $('#btn-run-one')
  const all = $('#btn-run-all')
  if (one && !running) one.disabled = false
  if (all && !running) all.disabled = false
  if (running) { if (one) one.disabled = true; if (all) all.disabled = true }
  $('#run-state').textContent = running
    ? '// 签到任务运行中…'
    : s.checkin.lastRun
      ? `// 上次运行：${s.checkin.lastRun.trigger === 'cron' ? '定时' : s.checkin.lastRun.trigger === 'startup' ? '启动' : '手动'} · 退出码 ${s.checkin.lastRun.exitCode}`
      : '// 空闲'
}

/* ────────────────── 账号管理（独立密码锁）────────────────── */

let accountsTimer = null

function showAccountsLock(msg, isErr) {
  $('#accounts-lock').hidden = false
  $('#accounts-content').hidden = true
  const el = $('#accounts-lock-msg')
  el.textContent = msg || ''
  el.className = isErr ? 'err' : 'dim'
}

/** 账号列表的原始数据与当前搜索词（重新渲染时复用，避免搜索后刷新丢失） */
let accountsCache = []
let accountsAdmin = false
let accountsSearch = ''

/**
 * 按昵称或酷狗ID 过滤账号。
 * 两种字段都做「包含」匹配，且忽略大小写，便于输入部分 ID 或昵称片段。
 * @param {Array} list
 * @param {string} keyword
 */
function filterAccounts(list, keyword) {
  const kw = String(keyword || '').trim().toLowerCase()
  if (!kw) return list
  return list.filter(a => {
    const id = String(a.rawUserid || '')
    const nick = String(a.nickname || '')
    return id.toLowerCase().includes(kw) || nick.toLowerCase().includes(kw)
  })
}

function renderAccounts(accounts, admin, mustChangePassword) {
  accountsCache = accounts
  accountsAdmin = admin
  // 以默认密码（酷狗ID）登录：提示尽快修改，避免他人凭 ID 登录并改密
  const warn = $('#accounts-default-pwd-warn')
  if (warn) {
    warn.hidden = !mustChangePassword
    warn.textContent = mustChangePassword
      ? '⚠ 当前使用的是默认密码（酷狗ID）。酷狗ID 对他人可见，请立即点击「修改密码」设置自己的密码。'
      : ''
  }
  renderAccountList()
}

/** 仅重绘列表部分（搜索时调用，不重复处理外层状态） */
function renderAccountList() {
  const box = $('#account-list')
  const accounts = accountsCache
  const admin = accountsAdmin
  $('#accounts-lock').hidden = true
  $('#accounts-content').hidden = false
  $('#accounts-who').textContent = admin ? '// 当前身份：admin（管理员）' : `// 当前身份：${ACCOUNTS_ID}`
  $('#btn-accounts-passwd').hidden = false

  if (!accounts.length) {
    box.innerHTML = '<div class="empty dim">// 暂无账号，请先在「扫码登录」或「手机号登录」中添加</div>'
    const cnt = $('#accounts-search-count')
    if (cnt) cnt.textContent = ''
    return
  }

  const shown = filterAccounts(accounts, accountsSearch)
  const cntEl = $('#accounts-search-count')
  if (cntEl) {
    cntEl.textContent = accountsSearch.trim()
      ? `// 匹配 ${shown.length} / ${accounts.length} 个账号`
      : `// 共 ${accounts.length} 个账号`
  }

  if (!shown.length) {
    box.innerHTML = `<div class="empty dim">// 没有匹配「${escapeHtml(accountsSearch.trim())}」的账号</div>`
    return
  }

  box.innerHTML = ''
  shown.forEach(acct => {
    const div = document.createElement('div')
    div.className = 'account-item'
    // 昵称（完整，后端已按面板授权返回）显示在 userid 左侧；无昵称时保持原布局
    const nameHtml = acct.nickname
      ? `<span class="acct-name">${escapeHtml(acct.nickname)}</span><span class="acct-sep">·</span>`
      : ''
    const noPwdHint = acct.hasPassword
      ? ''
      : '<div class="acct-sub warn">⚠ 仍在使用默认密码（酷狗ID），建议尽快修改</div>'
    // VIP 到期时间：签到不再把到期时间刷进日志，统一在此展示
    const vipHtml = acct.vipExpiry
      ? `<div class="acct-sub">VIP 到期: <span class="vip-expiry">${escapeHtml(String(acct.vipExpiry))}</span></div>`
      : '<div class="acct-sub dim">VIP 到期: 未获取（下次签到后显示）</div>'
    // userid 完整显示（面板本身受独立密码保护）；搜索高亮匹配片段
    const idHtml = highlightMatch(String(acct.userid), accountsSearch)
    div.innerHTML = `
      <div class="acct-main">
        <div class="acct-id"><span class="idx">[${acct.index}]</span>${nameHtml}userid: ${idHtml}</div>
        <div class="acct-sub">token: ****（${acct.tokenLength} 字符）· 每周日签到时自动刷新</div>
        ${vipHtml}
        ${noPwdHint}
      </div>`
    const btn = document.createElement('button')
    btn.className = 'btn danger-ghost'
    btn.textContent = '[ 删除 ]'
    btn.addEventListener('click', async () => {
      if (!confirm(`确认删除账号 ${acct.userid}？`)) return
      try {
        // 按 userid 删除：避免列表在操作期间变化导致误删他人账号
        await api(`/api/accounts/by-id/${encodeURIComponent(acct.rawUserid)}`, { method: 'DELETE' })
        toast('账号已删除', 'ok')
        loadAccounts()
        refreshStatus()
      } catch (e) {
        if (e.status === 423) lockdownAccounts(e.data && e.data.retryAfter, e.message)
        else toast(e.message, 'err')
      }
    })
    div.appendChild(btn)
    box.appendChild(div)
  })
}

/** 把文本中与搜索词匹配的部分包成高亮 span（先转义再做匹配，避免 XSS） */
function highlightMatch(text, keyword) {
  const safe = escapeHtml(text)
  const kw = String(keyword || '').trim()
  if (!kw) return safe
  const safeKw = escapeHtml(kw)
  const idx = safe.toLowerCase().indexOf(safeKw.toLowerCase())
  if (idx === -1) return safe
  return `${safe.slice(0, idx)}<mark class="hit">${safe.slice(idx, idx + safeKw.length)}</mark>${safe.slice(idx + safeKw.length)}`
}

/** 锁定倒计时：禁用输入与按钮，结束自动恢复 */
function lockdownAccounts(seconds, msg) {
  const idInput = $('#accounts-id')
  const input = $('#accounts-pwd')
  const btn = $('#btn-accounts-unlock')
  showAccountsLock(msg || '', true)
  idInput.disabled = true
  input.disabled = true
  btn.disabled = true
  clearInterval(accountsTimer)
  let remain = Math.max(1, parseInt(seconds, 10) || 300)
  const tick = () => {
    if (remain <= 0) {
      clearInterval(accountsTimer)
      idInput.disabled = false
      input.disabled = false
      btn.disabled = false
      $('#accounts-lock-msg').textContent = '// 锁定已解除，请输入密码'
      $('#accounts-lock-msg').className = 'dim'
      return
    }
    const mm = String(Math.floor(remain / 60)).padStart(2, '0')
    const ss = String(remain % 60).padStart(2, '0')
    $('#accounts-lock-msg').textContent = `⏳ ${msg ? msg + ' · ' : ''}剩余 ${mm}:${ss}`
    remain--
  }
  tick()
  accountsTimer = setInterval(tick, 1000)
}

async function loadAccounts() {
  clearInterval(accountsTimer)
  try {
    const r = await api('/api/accounts')
    renderAccounts(r.accounts, r.admin, r.mustChangePassword)
  } catch (e) {
    if (e.status === 423) {
      lockdownAccounts(e.data && e.data.retryAfter, e.message)
      return
    }
    // 401：需要输入凭据（未提供凭据不计失败次数）
    showAccountsLock(e.status === 401 ? '' : `// 加载失败：${e.message}`, e.status !== 401)
  }
}

async function tryUnlock() {
  const idInput = $('#accounts-id')
  const input = $('#accounts-pwd')
  const btn = $('#btn-accounts-unlock')
  if (input.disabled) return
  const id = idInput.value.trim()
  const pwd = input.value.trim()
  if (!id || !pwd) {
    showAccountsLock('// 请输入酷狗ID和密码', true)
    return
  }
  btn.disabled = true
  try {
    const r = await api('/api/accounts/unlock', { method: 'POST', body: JSON.stringify({ userid: id, password: pwd }) })
    ACCOUNTS_ID = id
    ACCOUNTS_KEY = pwd
    sessionStorage.setItem('kc_accts_id', id)
    sessionStorage.setItem('kc_accts', pwd)
    input.value = ''
    await loadAccounts()
  } catch (e) {
    if (e.status === 423) {
      lockdownAccounts(e.data && e.data.retryAfter, e.message)
      return
    }
    showAccountsLock(`// ${e.message}`, true)
    btn.disabled = false
  }
}

$('#btn-accounts-unlock').addEventListener('click', tryUnlock)
$('#accounts-pwd').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock() })
$('#accounts-id').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock() })

$('#btn-accounts-lock').addEventListener('click', () => {
  ACCOUNTS_KEY = ''
  ACCOUNTS_ID = ''
  sessionStorage.removeItem('kc_accts')
  sessionStorage.removeItem('kc_accts_id')
  showAccountsLock('')
})

/* ── 修改密码 ── */
$('#btn-accounts-passwd').addEventListener('click', async () => {
  const isAdmin = ACCOUNTS_ID === 'admin'
  const targetUserid = isAdmin
    ? prompt('输入要修改密码的账号酷狗ID（留空取消）：')
    : ACCOUNTS_ID
  if (!targetUserid) return
  const newPassword = prompt(`为账号 ${targetUserid} 设置新密码（4-64 位）：`)
  if (newPassword == null) return
  if (newPassword.length < 4 || newPassword.length > 64) {
    toast('新密码长度需为 4-64 位', 'err')
    return
  }
  try {
    await api('/api/accounts/password', {
      method: 'POST',
      body: JSON.stringify({ newPassword, ...(isAdmin ? { targetUserid } : {}) }),
    })
    toast('密码已更新', 'ok')
    // 若修改的是自己的密码，更新本地凭据
    if (!isAdmin) {
      ACCOUNTS_KEY = newPassword
      sessionStorage.setItem('kc_accts', newPassword)
    }
  } catch (e) {
    toast(e.message, 'err')
  }
})

/* ────────────────── 扫码登录 ────────────────── */

let qrPolling = false
let qrKeys = [] // { key, card, done }

$('#btn-qr-gen').addEventListener('click', async () => {
  const btn = $('#btn-qr-gen')
  const number = parseInt($('#qr-count').value, 10) || 1
  btn.disabled = true
  $('#qr-hint').textContent = '// 正在生成…'
  let cooling = false
  try {
    const { items } = await api('/api/qr/gen', { method: 'POST', body: JSON.stringify({ number }) })
    const list = $('#qr-list')
    list.innerHTML = ''
    qrKeys = items.map((item, i) => {
      const card = document.createElement('div')
      card.className = 'qr-card'
      card.innerHTML = `
        <h3>账号 ${i + 1}/${items.length} <span class="dim">· 请用酷狗音乐 APP 扫码</span></h3>
        <div class="qr-img-wrap"><img alt="登录二维码" src="${item.dataUrl}" /></div>
        <div class="qr-status wait">⏳ 等待扫描…</div>`
      list.appendChild(card)
      return { key: item.key, card, done: false }
    })
    $('#qr-hint').textContent = `// 已生成 ${items.length} 个二维码，等待扫码确认（约 2 分钟有效）`
    startQrPolling()
    toast('二维码已生成，请扫码', 'ok')
  } catch (e) {
    $('#qr-hint').textContent = ''
    if (e.status === 429 && e.data && e.data.retryAfter) {
      // 服务端限流：按真实剩余时间冷却，不再由 finally 重新启用按钮
      cooling = true
      $('#qr-hint').textContent = `// ${e.message}`
      cooldownButton(btn, e.data.retryAfter, '[ 生成二维码 ]')
    } else {
      toast(e.message, 'err')
    }
  } finally {
    if (!cooling) btn.disabled = false
  }
})

function startQrPolling() {
  if (qrPolling) return
  qrPolling = true
  const timer = setInterval(async () => {
    const pending = qrKeys.filter(k => !k.done)
    if (!pending.length) {
      clearInterval(timer)
      qrPolling = false
      return
    }
    await Promise.all(pending.map(async item => {
      try {
        const r = await api(`/api/qr/status?qrcode=${encodeURIComponent(item.key)}`)
        const statusEl = item.card.querySelector('.qr-status')
        if (r.status === 1) {
          statusEl.textContent = '⏳ 等待扫描…'
          statusEl.className = 'qr-status wait'
        } else if (r.status === 2) {
          statusEl.textContent = '👀 已扫描，请在手机上确认登录'
          statusEl.className = 'qr-status wait'
        } else if (r.status === 4) {
          item.done = true
          item.card.classList.add('done')
          statusEl.textContent = `✓ 登录成功 · 账号 ${r.userid}${r.saved ? ' 已保存' : ''}`
          statusEl.className = 'qr-status ok'
          toast(`账号 ${r.userid} 登录成功`, 'ok')
          refreshStatus()
        } else {
          item.done = true
          statusEl.textContent = r.status === 0 ? '✗ 二维码已过期，请重新生成' : `✗ 异常状态（${r.status}），请重新生成`
          statusEl.className = 'qr-status err'
        }
      } catch (e) {
        const statusEl = item.card.querySelector('.qr-status')
        statusEl.textContent = `✗ ${e.message}`
        statusEl.className = 'qr-status err'
        item.done = true
      }
    }))
  }, 3000)
}

/* ────────────────── 手机号登录 ────────────────── */

$('#btn-send-code').addEventListener('click', async () => {
  const btn = $('#btn-send-code')
  const phone = $('#phone').value.trim()
  if (!/^1[3-9]\d{9}$/.test(phone)) { toast('手机号格式不正确', 'err'); return }
  btn.disabled = true
  try {
    await api('/api/phone/send', { method: 'POST', body: JSON.stringify({ phone }) })
    toast('验证码已发送，请查收短信', 'ok')
    cooldownButton(btn, 60, '[ 发送验证码 ]')
  } catch (e) {
    toast(e.message, 'err')
    if (e.status === 429 && e.data && e.data.retryAfter) {
      // 服务端限流：按真实剩余时间冷却，避免反复点击徒增无效请求
      cooldownButton(btn, e.data.retryAfter, '[ 发送验证码 ]')
    } else {
      btn.disabled = false
    }
  }
})

$('#btn-phone-login').addEventListener('click', async () => {
  const btn = $('#btn-phone-login')
  const phone = $('#phone').value.trim()
  const code = $('#code').value.trim()
  btn.disabled = true
  $('#phone-hint').textContent = '// 登录中…'
  try {
    const r = await api('/api/phone/login', { method: 'POST', body: JSON.stringify({ phone, code }) })
    $('#phone-hint').textContent = `// ✓ 登录成功，账号 ${r.userid} 已保存`
    $('#code').value = ''
    toast(`账号 ${r.userid} 登录成功`, 'ok')
    refreshStatus()
  } catch (e) {
    $('#phone-hint').textContent = `// ${e.message}`
    toast(e.message, 'err')
  } finally {
    btn.disabled = false
  }
})

/* ────────────────── 一键签到 + 实时日志 ────────────────── */

const ANSI_RE = /\x1B\[([0-9;]*)m/g
const ANSI_CLASS = {
  1: 'bold', 2: 'c-dim',
  30: 'c-dim', 31: 'c-red', 32: 'c-green', 33: 'c-yellow', 34: 'c-blue', 35: 'c-magenta', 36: 'c-blue', 37: 'c-dim',
  90: 'c-dim', 91: 'c-red', 92: 'c-green', 93: 'c-yellow', 94: 'c-blue', 95: 'c-magenta',
}

const ANSI_STRIP_RE = /\x1B\[[0-9;]*m/g

/**
 * 去掉 ANSI 颜色转义，得到用于分类/匹配的纯文本。
 *
 * 日志 text 含原始转义码（colorOut 输出形如 \x1B[33m…\x1B[0m），行尾必然有复位码。
 * 若直接用原文判定，「开始领取VIP...$」这类以行尾结尾的正则永远匹配不上，
 * 导致简化模式失效（过程噪音行全部显示出来）。
 */
function plainOf(text) {
  return String(text || '').replace(ANSI_STRIP_RE, '')
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 把含 ANSI 转义的日志行转换为带颜色的 HTML（colorOut 输出形如 \x1B[31m…\x1B[0m） */
function ansiToHtml(raw) {
  let html = ''
  let open = false
  let last = 0
  ANSI_RE.lastIndex = 0
  let m
  // 必须按 SGR 出现的顺序「开/关」span，不能只取最后一段颜色：
  // colorOut 每行都是 `${color}%s\x1B[0m`，行尾的复位码会把整行颜色清掉。
  const closeSpan = () => { if (open) { html += '</span>'; open = false } }
  while ((m = ANSI_RE.exec(raw)) !== null) {
    html += escapeHtml(raw.slice(last, m.index))
    last = ANSI_RE.lastIndex
    const codes = (m[1] || '0').split(';').map(c => parseInt(c, 10) || 0)
    closeSpan()
    if (codes.includes(0)) continue // \x1B[0m 复位：只关闭当前 span
    const cls = codes.map(c => ANSI_CLASS[c]).filter(Boolean)
    if (cls.length) {
      html += `<span class="${cls.join(' ')}">`
      open = true
    }
  }
  html += escapeHtml(raw.slice(last))
  closeSpan()
  return html
}

/**
 * 判断一行日志是否为「已跳过」行（账号今日已签到）。
 *
 * 账号多时这类行会成批出现（每个账号一行），简化模式下全部收起，
 * 改为在批次结束后输出一行汇总，而不是让 N 行淹没关键信息。
 *
 * @param {string} text 已剥离 ANSI 的纯文本
 * @returns {boolean}
 */
function isSkipLine(text) {
  return /账号\s*\S+\s*今日已签到，跳过/.test(plainOf(text))
}

/**
 * 判断一行日志是否属于「详细」级别（简化模式下隐藏）。
 *
 * 简化模式只保留：任务开始/结束、每个账号的结果（听歌成功/失败、今日已领取、
 * 次数用光、领取失败）、错误、跳过汇总。
 * 隐藏的是高频且可推知的类型：
 *   - 领取流程的阶段性提示（「开始领取VIP...」「开始听歌领取VIP...」）
 *   - 逐次领取进度（「第3次领取成功」）
 *   - 等待提示
 *   - 成批的「已跳过」行
 *   - VIP 到期时间（改在「账号管理」面板查看）
 *
 * @param {string} text 去除 ANSI 后的纯文本
 * @returns {boolean} true = 详细日志（简化模式下隐藏）
 */
function isVerboseLine(text) {
  const t = plainOf(text).trim()
  if (!t) return false
  // 阶段开始提示：每个账号这两行必然出现，属过程噪音，结果行才是有效信息
  if (/开始领取VIP\.{0,3}$/.test(t)) return true
  if (/开始听歌领取VIP\.{0,3}$/.test(t)) return true
  if (/开始签到$/.test(t)) return true
  // 逐次领取成功：「第3次领取成功」——保留最终统计即可，中间过程不显示
  if (/第\s*\d+\s*次领取成功/.test(t)) return true
  // 等待提示（8 次领取之间各等 30 秒）
  if (/等待\s*\d+\s*秒|请稍候/.test(t)) return true
  // 已跳过：账号多时成批刷屏，改用末尾汇总行代替
  if (isSkipLine(t)) return true
  // 「今天是」与「VIP到期时间」：到期时间统一在「账号管理」查看，日志里不再重复
  if (/今天是[：:]/.test(t)) return true
  if (/VIP到期时间[：:]/.test(t)) return true
  return false
}

/**
 * 从「[#4/28] 账号 xxx ...」这类日志中提取账号序号。
 * 用于同一账号的多行日志在视觉上对齐（按序号分组着色/缩进）。
 *
 * @param {string} text
 * @returns {string|null} 如 "4"，无序号时返回 null
 */
function accountKeyOf(text) {
  const m = plainOf(text).match(/\[#(\d+)\/\d+\]/)
  return m ? m[1] : null
}

/**
 * 把「[#N/M]」包装为定宽元素，使后续文字从同一列开始。
 * 必须在 ansiToHtml 之后调用。着色后标签会落在颜色 span 内部，
 * 因此不能用「行首未被 span 包裹」的正则，改为就地插入（合法嵌套，不破坏外层颜色）。
 *
 * @param {string} html ansiToHtml 的输出
 * @param {string} rawText 原始日志文本（用于定位标签）
 * @returns {string}
 */
function wrapAccountTag(html, rawText) {
  const m = String(rawText || '').match(/\[#(\d+)\/\d+\]/)
  if (!m) return html
  const tag = m[0]
  const at = html.indexOf(tag)
  if (at === -1) return html
  const span = `<span class="acct-tag" data-acct="${m[1]}">${tag}</span>`
  return html.slice(0, at) + span + html.slice(at + tag.length)
}

/** 当前是否显示详细日志（默认简化） */
let showVerbose = false

/** 依据 showVerbose 切换终端区域的类名 */
function applyVerboseMode() {
  const term = $('.term')
  if (term) term.classList.toggle('verbose', showVerbose)
  const btn = $('#btn-toggle-verbose')
  if (btn) {
    btn.setAttribute('aria-pressed', showVerbose ? 'true' : 'false')
    btn.textContent = showVerbose ? '[ 简化日志 ]' : '[ 详细日志 ]'
  }
  updateEmptyHint()
}

/**
 * 简化模式下若所有行都被隐藏（例如只跑了一次快速失败的账号），
 * 终端会空白。此处给出提示，避免用户误以为卡住。
 */
function updateEmptyHint() {
  const body = $('#term-body')
  if (!body) return
  // 汇总行在简化模式下是可见内容，算作「有内容」
  const visible = Array.from(body.children).filter(el => {
    if (el.classList.contains('empty-hint')) return false
    if (el.classList.contains('skip-summary')) return !showVerbose
    if (el.classList.contains('muted-line') && !showVerbose) return false
    return true
  })
  const hint = body.querySelector('.empty-hint')
  if (visible.length > 0) {
    if (hint) hint.remove()
    return
  }
  if (!hint && body.children.length > 0) {
    const div = document.createElement('div')
    div.className = 'line dim empty-hint'
    div.textContent = '// 已隐藏详细日志，点击「详细日志」查看完整输出'
    body.appendChild(div)
  }
}

/**
 * 折叠连续的「已跳过」行。
 *
 * 账号多时每个已签到账号都会输出一行「账号 xxx 今日已签到，跳过」，
 * 21 个账号就是 21 行，会把真正有信息量的内容挤走。
 *
 * 做法：原始行仍按原样插入 DOM（切到详细模式即可看到全部明细），
 * 简化模式下在「末尾连续的一段跳过行」之后附加一条汇总行显示数量。
 * 汇总行随本批数量递增就地更新；一旦来了非跳过行，本批结束，
 * 汇总行保留在它应在的位置，后续再出现的跳过行会开启新的一批。
 *
 * @param {HTMLElement} line 刚插入的日志行
 */
function foldSkipLines(line) {
  const body = $('#term-body')
  if (!body) return

  // 本行不是跳过行 → 本批结束（既有汇总行留在原处），无需处理
  if (!isSkipLine(line.textContent)) return

  // 向上回溯本批：连续的跳过行。
  // 需跨过两类非内容行：上一次留下的汇总行、以及简化模式下的空状态提示行
  // （后者在第 1 条跳过行进来时就会插入，若不跨过会把同批切断）。
  const batch = [line]
  for (let el = line.previousElementSibling; el; el = el.previousElementSibling) {
    if (el.classList.contains('skip-summary') || el.classList.contains('empty-hint')) continue
    if (isSkipLine(el.textContent)) batch.push(el)
    else break                                            // 遇到其他日志 → 本批到此
  }

  // 移除本批范围内遗留的所有汇总行（从本批首行到当前行之间），
  // 已结束批次的汇总行不在该区间内，因此不受影响。
  const firstRow = batch[batch.length - 1]
  const stale = []
  for (let el = firstRow; el; el = el.nextElementSibling) {
    if (el.classList.contains('skip-summary')) stale.push(el)
    if (el === line) break
  }
  // 当前行之后也可能残留一条（上一轮插在末尾的）
  const after = line.nextElementSibling
  if (after && after.classList.contains('skip-summary')) stale.push(after)
  for (const el of stale) el.remove()

  const count = batch.length
  const summary = document.createElement('div')
  summary.className = 'line skip-summary'
  summary.textContent = count > 1
    ? `// 本批 ${count} 个账号今日已签到，已跳过（点击「详细日志」查看明细）`
    : '// 该账号今日已签到，已跳过（点击「详细日志」查看明细）'
  line.after(summary)
}

function appendLog(entry) {
  const body = $('#term-body')
  const line = document.createElement('div')
  const ts = entry.ts ? `<span class="ts">${entry.ts.slice(11, 19)}</span> ` : ''
  line.className = `line ${entry.level === 'log' ? '' : entry.level}`.trim()
  // 用纯文本判定详细级别（此时 text 尚未转 HTML，判定更可靠）
  if (isVerboseLine(entry.text)) line.classList.add('muted-line')
  // 同一账号的日志标同一序号，供 CSS 做对齐分组
  const acct = accountKeyOf(entry.text)
  if (acct) line.dataset.acct = acct
  line.innerHTML = ts + wrapAccountTag(ansiToHtml(entry.text), entry.text)
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60
  // 仅移除「等待任务输出」这一条占位提示；空状态提示由 updateEmptyHint 统一管理
  const placeholder = body.querySelector('.dim')
  if (placeholder && placeholder.textContent.includes('等待任务输出')) placeholder.remove()
  body.appendChild(line)
  // 折叠连续的「已跳过」行：原始行保留在 DOM 中，简化模式另加一行数量汇总
  foldSkipLines(line)
  // 限制 DOM 行数
  while (body.children.length > 800) body.removeChild(body.firstChild)
  if (nearBottom) body.scrollTop = body.scrollHeight
  updateEmptyHint()
}

function clearTerm() {
  $('#term-body').innerHTML = ''
}

$('#btn-clear-log').addEventListener('click', clearTerm)

// 详细日志开关：默认关闭（简化显示），用户选择记忆在 localStorage
$('#btn-toggle-verbose').addEventListener('click', () => {
  showVerbose = !showVerbose
  applyVerboseMode()
  try { localStorage.setItem('kg-verbose-log', showVerbose ? '1' : '0') } catch { /* 隐私模式忽略 */ }
})

// 恢复上次选择；默认简化
try { showVerbose = localStorage.getItem('kg-verbose-log') === '1' } catch { showVerbose = false }
applyVerboseMode()

let sse = null

function connectSse() {
  if (sse) return
  const url = AUTH ? `/api/checkin/logs?key=${encodeURIComponent(AUTH)}` : '/api/checkin/logs'
  sse = new EventSource(url)
  sse.addEventListener('hello', ev => {
    const info = JSON.parse(ev.data)
    if (info.lastRun) $('#run-state').textContent = `// 上次运行：退出码 ${info.lastRun.exitCode ?? '-'}`
  })
  sse.onmessage = ev => appendLog(JSON.parse(ev.data))
  sse.addEventListener('start', () => { $('#run-state').textContent = '// 签到任务运行中…' })
  sse.addEventListener('end', ev => {
    const r = JSON.parse(ev.data)
    $('#run-state').textContent = r.ok ? '// ✓ 签到完成' : `// ✗ 签到结束，退出码 ${r.exitCode}`
    toast(r.ok ? '签到任务执行成功' : `签到任务失败（退出码 ${r.exitCode}）`, r.ok ? 'ok' : 'err')
    refreshStatus()
    // 签到结束会写盘 VIP 到期时间：若当前停在账号管理页，直接重拉列表，
    // 否则用户会看到刚签完的账号仍显示「未获取」，必须切标签页才刷新。
    if ($('#panel-accounts').classList.contains('active')) loadAccounts()
  })
  sse.onerror = () => {
    // 401 等致命错误会让连接进入 CLOSED；置空以便输入密码后能带密钥重建连接
    // （普通网络抖动时 readyState 为 CONNECTING，EventSource 会自动重连，无需处理）
    if (sse && sse.readyState === EventSource.CLOSED) sse = null
  }
}

/** 单账号签到：按 userid 触发，受「每 userid 每天 2 次」配额约束 */
$('#btn-run-one').addEventListener('click', async () => {
  const btn = $('#btn-run-one')
  const userid = $('#run-userid').value.trim()
  if (!userid) {
    toast('请先填写酷狗ID（userid）', 'err')
    $('#run-userid').focus()
    return
  }
  if (!/^\d+$/.test(userid)) {
    toast('userid 应为纯数字', 'err')
    $('#run-userid').focus()
    return
  }
  btn.disabled = true
  try {
    const r = await api('/api/checkin/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userid }),
    })
    $('#run-state').textContent = '// 签到任务已启动…'
    toast(`已启动该账号签到${typeof r?.remaining === 'number' ? `（今日剩余 ${r.remaining} 次）` : ''}`, 'ok')
    refreshStatus()
    refreshQuota()
  } catch (e) {
    btn.disabled = false
    toast(e.message, 'err')
    refreshStatus()
  }
})

/** 全部账号签到：必须通过 admin 账号+密码验证 */
$('#btn-run-all').addEventListener('click', async () => {
  const btn = $('#btn-run-all')
  const password = $('#run-admin-key').value
  if (!password) {
    toast('全部账号签到需要输入 admin 密码', 'err')
    $('#run-admin-key').focus()
    return
  }
  btn.disabled = true
  try {
    await api('/api/checkin/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Accounts-Id': 'admin',
        'X-Accounts-Key': password,
      },
      body: '{}',
    })
    $('#run-state').textContent = '// 签到任务已启动…'
    $('#run-admin-key').value = ''
    toast('全部账号签到已启动', 'ok')
    refreshStatus()
  } catch (e) {
    btn.disabled = false
    toast(e.message || 'admin 验证失败：账号或密码错误', 'err')
    refreshStatus()
  }
})

/** 输入 userid 后自动查询今日剩余次数 */
async function refreshQuota() {
  const userid = $('#run-userid').value.trim()
  const el = $('#run-one-quota')
  if (!el) return
  if (!userid || !/^\d+$/.test(userid)) { el.textContent = ''; return }
  try {
    const q = await api(`/api/checkin/quota?userid=${encodeURIComponent(userid)}`)
    el.textContent = `// 今日已用 ${q.used}/${q.limit} 次，剩余 ${q.remaining} 次`
    el.className = q.remaining > 0 ? 'dim' : 'dim warn'
  } catch {
    el.textContent = ''
  }
}

$('#run-userid').addEventListener('input', () => {
  clearTimeout(refreshQuota._t)
  refreshQuota._t = setTimeout(refreshQuota, 350)
})

/* 方案 B：全部账号签到默认隐藏，点右上角 ⚙ 展开/收起。
   刻意不记忆展开状态：管理员密码框不应在下次打开页面时自动出现。 */
$('#btn-run-admin-toggle').addEventListener('click', () => {
  const panel = $('#run-admin-panel')
  const btn = $('#btn-run-admin-toggle')
  const willShow = panel.hidden
  panel.hidden = !willShow
  btn.setAttribute('aria-pressed', willShow ? 'true' : 'false')
  btn.classList.toggle('active', willShow)
  if (willShow) {
    $('#run-admin-key').focus()
  } else {
    // 收起时清空密码，避免停留在 DOM 中
    $('#run-admin-key').value = ''
  }
})

/* 账号搜索：按昵称或酷狗ID 过滤 */
$('#accounts-search').addEventListener('input', ev => {
  accountsSearch = ev.target.value
  clearTimeout($('#accounts-search')._t)
  $('#accounts-search')._t = setTimeout(renderAccountList, 120)
})

/* ────────────────── 启动 ────────────────── */

function refreshAll() {
  refreshStatus()
  connectSse()
}

refreshAll()
setInterval(refreshStatus, 5000)

// 支持 #qr / #phone / #run / #accounts 直达对应标签页
const initialTab = location.hash.replace('#', '')
const initialTabEl = $$('.tab').find(t => t.dataset.tab === initialTab)
if (initialTabEl) initialTabEl.click()
