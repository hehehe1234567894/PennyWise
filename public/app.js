/* PennyWise PWA 前端（零依赖原生 JS） */
(() => {
  'use strict'

  // 兜底：任何脚本错误直接显示在页面上，避免"点了没反应"的静默失败
  window.addEventListener('error', (e) => {
    try {
      const el = document.getElementById('js-error')
      if (el) {
        el.textContent = '页面脚本出错：' + (e.message || '未知错误')
        el.classList.remove('hidden')
      }
    } catch { /* 忽略 */ }
  })

  const $ = (sel) => /^[#.[]/.test(sel) ? document.querySelector(sel) : document.getElementById(sel)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const fmtMoney = (n) => (n === null || n === undefined) ? '—' : '¥' + Number(n).toFixed(2)
  const DIR_LABEL = { expense: '支出', income: '收入', refund: '退款', transfer: '转账' }
  const ACC_LABEL = { wechat: '微信', alipay: '支付宝', bank: '银行卡', cash: '现金', other: '其他' }
  // 语义化分类配色（环形图/图例/流水芯片统一使用）
  const CAT_HEX = { '餐饮': '#E8A33D', '交通': '#7FB5C9', '购物': '#D98BA3', '娱乐': '#A88BD4', '学习': '#7FBF8E', '日用品': '#A6C86B', '医疗': '#E07B7B', '通讯': '#6FB5B0', '住宿': '#9B8EC4', '运动': '#5FB894', '生活缴费': '#E09B5A', '人情': '#D4B54A', '其他': '#9AA096' }
  const catColor = (n) => CAT_HEX[n] || '#1E7A5A'
  const CAT_COLORS = ['#E8A33D', '#7FB5C9', '#D98BA3', '#A88BD4', '#7FBF8E', '#A6C86B', '#E07B7B', '#6FB5B0']

  const TOKEN_KEY = 'pw_token'
  let token = localStorage.getItem(TOKEN_KEY) || ''
  let categories = { expense: [], income: [] }
  let currentEditor = null

  function uuid() {
    return (crypto.randomUUID && crypto.randomUUID()) || 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  }

  // ---------- 连接管理：探测可用端点，优先局域网 ----------
  let endpoints = []        // {url, kind:'lan'|'tailscale'|'current', ok, ms}
  let activeEndpoint = null // 当前选中的端点
  let apiBase = ''          // 空 = 同源请求

  async function probeUrl(url) {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), 2500)
    const t0 = performance.now()
    try {
      const r = await fetch(url + '/api/reachability', { signal: ctrl.signal, headers: token ? { 'X-Auth-Token': token } : {} })
      clearTimeout(to)
      if (!r.ok) return null
      const j = await r.json().catch(() => null)
      if (!j || !j.ok) return null
      return { data: j, ms: Math.round(performance.now() - t0) }
    } catch (e) { clearTimeout(to); return null }
  }

  function sameScheme(u) {
    try { return new URL(u).protocol === location.protocol } catch { return false }
  }

  async function refreshEndpoints() {
    const cur = location.origin
    let info = null
    try { info = await probeUrl(cur) } catch { /* 服务器不可达，稍后仍用当前地址兜底 */ }
    // 候选地址：当前地址 + 服务器自报的局域网/Tailscale 地址
    const cands = [{ url: cur, kind: 'current' }]
    if (info?.data) {
      for (const x of info.data.lan || []) cands.push({ url: `http://${x.ip}:${info.data.port}`, kind: 'lan' })
      for (const x of info.data.tailscale || []) cands.push({ url: `http://${x.ip}:${info.data.port}`, kind: 'tailscale' })
      if (info.data.tsName) cands.push({ url: `https://${info.data.tsName}`, kind: 'tailscale' })
    }
    // 去重
    const seen = new Set()
    const uniq = []
    for (const c of cands) {
      if (seen.has(c.url)) continue
      seen.add(c.url)
      uniq.push(c)
    }
    // 并发探测。跨 scheme 的地址浏览器会以混合内容拦截，只列不测（ok=null）
    endpoints = await Promise.all(uniq.map(async (c) => {
      if (!sameScheme(c.url)) return { ...c, ok: null, ms: null }
      const r = await probeUrl(c.url)
      return { ...c, ok: !!r, ms: r ? r.ms : null }
    }))
    // 选择优先级：局域网直连 → 当前地址 → 延迟最低者
    const reach = endpoints.filter((e) => e.ok)
    const pick = reach.find((e) => e.kind === 'lan')
      || reach.find((e) => e.url === cur)
      || reach.slice().sort((a, b) => a.ms - b.ms)[0]
      || null
    activeEndpoint = pick
    apiBase = pick && pick.url !== cur ? pick.url : ''
    updateChip()
    renderConnPanel()
    return pick
  }

  // ---------- 模型状态提示（欠费/无效 Key/异常时才显示，正常时完全静默） ----------
  const MODEL_ERR_LABEL = {
    insufficient_balance: 'AI 模型欠费', invalid_key: 'API Key 无效', rate_limited: 'AI 请求过于频繁',
    model_not_found: 'AI 模型不存在', no_key: '未配置 AI 模型', api_error: 'AI 服务异常',
    network: '无法连接 AI 服务', bad_json: 'AI 返回格式异常', all_failed: '识别模型全部不可用', unknown: 'AI 服务异常',
  }
  let modelStatusCache = { text: { ok: true }, vision: { ok: true } }

  function modelAlertMsgs(ms) {
    const parts = []
    const t = ms?.text
    if (t && t.ok === false) parts.push(`文字解析：${MODEL_ERR_LABEL[t.code] || 'AI 服务异常'}，交易将进入手动确认`)
    const v = ms?.vision
    if (v && v.ok === false) parts.push(`截图识别：${MODEL_ERR_LABEL[v.code] || 'AI 服务异常'}`)
    return parts
  }
  function updateModelAlert(ms) {
    if (ms) modelStatusCache = ms
    const el = $('model-alert')
    const msgs = modelAlertMsgs(modelStatusCache)
    if (msgs.length) {
      el.innerHTML = `⚠ ${esc(msgs.join('；'))}。点此查看修复方法`
      el.classList.remove('hidden')
    } else {
      el.classList.add('hidden')
    }
  }
  async function refreshModelAlert() {
    try {
      const h = await api('/api/health')
      updateModelAlert(h.modelStatus)
    } catch (e) { /* 网络问题时不打扰 */ }
  }
  $('model-alert').addEventListener('click', () => showSettings())

  // ---------- 网络层 ----------
  async function api(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {})
    if (token) headers['X-Auth-Token'] = token
    const doFetch = async (base) => {
      let res
      try {
        res = await fetch(base + path, Object.assign({}, opts, { headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }))
      } catch (e) {
        const err = new Error('network'); err.code = 'network'; throw err
      }
      if (res.status === 401) {
        // 令牌失效：清除并重新锁定，无验证不可进入
        token = ''
        localStorage.removeItem(TOKEN_KEY)
        showLock()
        const err = new Error('token'); err.code = 'token'; throw err
      }
      const j = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }))
      if (!j.ok) { const err = new Error(j.error || '请求失败'); err.code = 'api'; throw err }
      return j.data
    }
    try {
      return await doFetch(apiBase || '')
    } catch (e) {
      if (e.code === 'network' && !opts._retried) {
        await refreshEndpoints() // 重探测并切换可用端点后重试一次
        return doFetch(apiBase || '')
      }
      if (e.code === 'token') throw new Error('访问令牌无效，请在设置中填写')
      if (e.code === 'network') throw new Error('网络不可用，稍后重试')
      throw e
    }
  }

  // ---------- UI 基础 ----------
  let toastTimer
  function toast(msg, ms = 2200) {
    const t = $('toast')
    t.textContent = msg
    t.classList.remove('hidden')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => t.classList.add('hidden'), ms)
  }
  function openModal(title, bodyHtml) {
    $('modal-title').textContent = title
    $('modal-body').innerHTML = bodyHtml
    $('modal').classList.remove('hidden')
  }
  function closeModal() {
    $('modal').classList.add('hidden')
    currentEditor = null
  }

  // ---------- 响应式：手机单页竖排 / 电脑左右两栏（细指针 + 较宽视口才算电脑） ----------
  const mqDesktop = window.matchMedia('(min-width: 760px) and (pointer: fine)')
  let isDesktop = mqDesktop.matches
  function applyLayout() {
    isDesktop = mqDesktop.matches
    document.body.classList.toggle('desktop', isDesktop)
    // 桌面端同样一次只显示一个面板（侧边栏 = 真正的页面切换）
    switchTab(document.querySelector('.tab.active')?.dataset.tab || 'list')
  }
  mqDesktop.addEventListener('change', applyLayout)

  const TAB_RENDER = { list: renderList, stats: renderStats, mail: renderMail, fin: renderFin }
  function switchTab(name) {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name))
    document.querySelectorAll('.side-item[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name))
    if (name === 'mail') markMailRead() // 任何入口（侧栏/顶栏）打开邮箱页都算已读
    ;['list', 'stats', 'mail', 'fin'].forEach((t) => {
      const el = $(`tab-${t}`)
      el.hidden = t !== name
      el.classList.remove('tab-enter')
    })
    const target = $(`tab-${name}`)
    void target.offsetWidth // 强制重排以重放入场动画
    target.classList.add('tab-enter')
    if (TAB_RENDER[name]) TAB_RENDER[name]()
  }
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)))
  // 侧栏（电脑端）：导航 + AI 助手 + 设置
  document.querySelectorAll('.side-item[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)))
  $('side-chat').addEventListener('click', () => $('btn-chat').click())
  $('side-settings').addEventListener('click', showSettings)

  // ---------- 时间工具 ----------
  function localMonth() {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  }
  function toLocalInput(iso) {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
  }
  function fromLocalInput(v) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  function fmtTs(iso) {
    const d = new Date(iso)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  function fmtDay(iso) {
    const d = new Date(iso)
    const p = (n) => String(n).padStart(2, '0')
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${wd}`
  }
  // 数字滚动动画
  function countUp(el, { v, sign, dec, ms = 800 }) {
    const start = performance.now()
    function step(now) {
      const p = Math.min(1, (now - start) / ms)
      const e = 1 - Math.pow(1 - p, 3)
      const val = v * e
      el.textContent = dec === 0 ? String(Math.round(val)) : sign + '¥' + val.toFixed(dec)
      if (p < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }
  function runCountUps() {
    document.querySelectorAll('[data-cnt]').forEach((el) => {
      countUp(el, { v: Number(el.dataset.cnt), sign: el.dataset.sign || '', dec: Number(el.dataset.dec || 2) })
    })
  }

  // ---------- 编辑器（确认 / 手动 / 编辑 三种模式） ----------
  function editorForm() {
    return `
    <form id="ed-form">
      <label>金额（元）<input id="ed-amount" type="number" step="0.01" min="0.01" inputmode="decimal" required></label>
      <div class="grid2">
        <label>方向
          <select id="ed-direction">
            <option value="expense">支出</option>
            <option value="income">收入</option>
            <option value="refund">退款</option>
            <option value="transfer">转账</option>
          </select>
        </label>
        <label>账户
          <select id="ed-account">
            <option value="wechat">微信</option>
            <option value="alipay">支付宝</option>
            <option value="bank">银行卡</option>
            <option value="cash">现金</option>
            <option value="other">其他</option>
          </select>
        </label>
      </div>
      <label>商户 / 对方<input id="ed-merchant" type="text" placeholder="如：全家便利店"></label>
      <label>商品 / 服务名称<input id="ed-goods" type="text" placeholder="如：冰美式咖啡（可选）"></label>
      <label id="ed-cat-wrap">分类<select id="ed-category"></select></label>
      <label>时间<input id="ed-ts" type="datetime-local"></label>
      <label>备注<input id="ed-note" type="text" placeholder="可选"></label>
      <div id="ed-raw" class="rawbox hidden"></div>
      <div class="btn-row">
        <button type="button" class="btn" data-close>取消</button>
        <button type="submit" class="btn btn-primary" id="ed-submit">确认入账</button>
      </div>
    </form>`
  }

  function openEditor(mode, tx) {
    currentEditor = { mode, tx }
    const title = mode === 'manual' ? '手动记账' : (mode === 'edit' ? '编辑记录' : '确认这笔交易')
    openModal(title, editorForm())
    const dir = $('ed-direction')
    const updateCat = () => {
      const d = dir.value
      $('ed-cat-wrap').hidden = d !== 'expense'
      if (d === 'expense') fillCategorySelect($('ed-category'), 'expense')
    }
    dir.addEventListener('change', updateCat)
    updateCat()
    if (tx) {
      if (tx.amount != null) $('ed-amount').value = tx.amount
      dir.value = tx.direction
      updateCat()
      if (tx.direction === 'expense') {
        const opts = [...$('ed-category').options].map((o) => o.value)
        $('ed-category').value = opts.includes(tx.category) ? tx.category : (opts.includes('其他') ? '其他' : opts[0])
      }
      $('ed-merchant').value = tx.merchant || ''
      $('ed-goods').value = tx.goods_name || ''
      $('ed-account').value = tx.account || 'other'
      if (tx.ts) $('ed-ts').value = toLocalInput(tx.ts)
      $('ed-note').value = tx.note || ''
      if (tx.raw_image || tx.local_image) {
        const img = document.createElement('img')
        img.className = 'ed-img'
        img.alt = '截图'
        img.src = tx.raw_image
          ? '/api/image/' + encodeURIComponent(tx.raw_image)
          : 'data:' + (tx.local_mime || 'image/png') + ';base64,' + tx.local_image
        $('ed-form').insertBefore(img, $('ed-form').querySelector('.btn-row'))
      }
      if (tx.raw_text) {
        const r = $('ed-raw')
        r.textContent = '原文：' + tx.raw_text
        r.classList.remove('hidden')
      }
      if (mode === 'parse' && tx.confidence != null) {
        $('ed-submit').textContent = '确认入账（置信度 ' + Math.round(tx.confidence * 100) + '%）'
      }
    }
    if (mode === 'edit') {
      $('ed-submit').textContent = '保存修改'
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn btn-danger'
      btn.textContent = '删除'
      btn.addEventListener('click', async () => {
        if (!confirm('确定删除这条记录？')) return
        await localDelete(tx.uid)
        closeModal(); refreshAll(); toast('已删除（同步中）')
      })
      $('ed-form').querySelector('.btn-row').appendChild(btn)
    }
  }

  function fillCategorySelect(sel, direction) {
    const list = direction === 'income' ? categories.income : categories.expense
    sel.innerHTML = list.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')
  }

  $('modal-body').addEventListener('submit', async (e) => {
    if (e.target.id !== 'ed-form') return
    e.preventDefault()
    const c = currentEditor
    if (!c) return
    const g = (id) => $(id).value.trim()
    const payload = {
      amount: Number($('ed-amount').value),
      direction: $('ed-direction').value,
      merchant: g('ed-merchant'),
      goods_name: g('ed-goods'),
      account: $('ed-account').value,
      ts: fromLocalInput(g('ed-ts')) || new Date().toISOString(),
      note: g('ed-note'),
    }
    const d = payload.direction
    payload.category = d === 'expense' ? $('ed-category').value : (d === 'refund' ? '退款' : null)
    try {
      const now = new Date().toISOString()
      if (!c.tx) {
        const tx = Object.assign({ uid: uuid(), created_at: now, raw_text: null, raw_image: null, source: 'manual', confidence: null }, payload, { status: 'confirmed' })
        await localApply(tx.uid, 'put', tx)
        toast('已入账 ✓')
      } else {
        const merged = Object.assign({}, c.tx, payload, { status: 'confirmed' })
        delete merged.local_image
        await localApply(c.tx.uid, 'put', merged)
        toast(c.tx.status === 'pending' ? '已确认入账 ✓' : '已保存修改')
      }
      closeModal()
      refreshAll()
    } catch (err) { toast('保存失败：' + err.message) }
  })

  // ---------- 采集 ----------
  $('btn-paste').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText()
      if (t) { $('capture-text').value = t; capture(t) }
      else toast('剪贴板为空')
    } catch (e) { toast('无法读取剪贴板，请长按输入框手动粘贴') }
  })

  $('btn-parse').addEventListener('click', () => {
    const text = $('capture-text').value.trim()
    if (!text) return toast('先输入或粘贴交易文本')
    capture(text)
  })

  $('btn-manual').addEventListener('click', () => openEditor('manual', null))

  // ---------- 截图采集 ----------
  $('btn-image').addEventListener('click', () => $('file-image').click())
  $('file-image').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0]
    e.target.value = ''
    if (f) captureImage(f)
  })
  // 电脑上 Ctrl+V 直接粘贴截图
  document.addEventListener('paste', (e) => {
    if ($('modal').classList.contains('hidden') === false) return
    const items = [...(e.clipboardData?.items || [])].filter((i) => i.type && i.type.startsWith('image/'))
    if (items.length) {
      e.preventDefault()
      const f = items[0].getAsFile()
      if (f) { toast('已粘贴截图，识别中…'); captureImage(f) }
    }
  })
  // 拖拽图片到"记一笔"页
  const dropZone = $('tab-capture')
  dropZone.addEventListener('dragover', (e) => e.preventDefault())
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault()
    const f = e.dataTransfer?.files?.[0]
    if (f && f.type.startsWith('image/')) captureImage(f)
  })

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result).split(',')[1] || '')
      r.onerror = () => reject(r.error)
      r.readAsDataURL(file)
    })
  }

  async function captureImage(file) {
    const clientId = uuid()
    try {
      const b64 = await fileToBase64(file)
      const data = await api('/api/capture-image', { method: 'POST', body: { image_base64: b64, mime: file.type || 'image/png', client_id: clientId } })
      const { transaction, parse } = data
      await mPut('tx', transaction)
      if (transaction.status === 'confirmed') {
        toast(`已自动入账 ✓（置信度 ${Math.round((transaction.confidence || 0) * 100)}%）`)
      } else {
        if (parse.code === 'ok') toast('识别完成，请确认')
        else if (parse.code === 'duplicate') toast('这条已经存在')
        else toast('截图识别失败（' + (MODEL_ERR_LABEL[parse.code] || parse.code) + '），已转手动填写')
        openEditor('parse', transaction)
      }
      refreshModelAlert().catch(() => {})
      refreshAll()
    } catch (e) {
      if (/网络|令牌/.test(e.message)) {
        const b64 = await fileToBase64(file)
        const now = new Date().toISOString()
        const tx = {
          uid: uuid(), client_id: clientId, ts: now, created_at: now, amount: null, currency: 'CNY',
          direction: 'expense', merchant: '', goods_name: '', category: '其他', account: 'other',
          raw_text: '', raw_image: null, source: 'image', status: 'pending', confidence: null, note: '',
          local_image: b64, local_mime: file.type || 'image/png',
        }
        await localApply(tx.uid, 'put', Object.assign({}, tx, { image_base64: b64 }))
        toast('已离线暂存，同步后自动识别')
        openEditor('parse', tx)
        refreshAll()
      } else {
        toast('识别失败：' + e.message)
      }
    }
  }

  async function capture(text) {
    const clientId = uuid()
    try {
      const data = await api('/api/capture', { method: 'POST', body: { text, client_id: clientId } })
      $('capture-text').value = ''
      const { transaction, parse } = data
      await mPut('tx', transaction) // 写入本地镜像（uid 由服务器分配）
      if (transaction.status === 'confirmed') {
        toast(`已自动入账 ✓（置信度 ${Math.round((transaction.confidence || 0) * 100)}%）`)
      } else {
        if (parse.code === 'no_key') toast('未配置 AI 模型，已转手动确认')
        else if (parse.code === 'insufficient_balance') toast('⚠ AI 模型欠费，已转手动确认')
        else if (parse.code === 'invalid_key') toast('⚠ API Key 无效，已转手动确认')
        else if (parse.code === 'ok') toast('解析完成，请确认')
        else if (parse.code === 'duplicate') toast('这条已经存在')
        else toast('AI 解析失败（' + (MODEL_ERR_LABEL[parse.code] || parse.code) + '），已转手动确认')
        openEditor('parse', transaction)
      }
      refreshModelAlert().catch(() => {})
      refreshAll()
    } catch (e) {
      if (/网络|令牌/.test(e.message)) {
        const now = new Date().toISOString()
        const tx = {
          uid: uuid(), client_id: clientId, ts: now, created_at: now, amount: null, currency: 'CNY',
          direction: 'expense', merchant: '', goods_name: '', category: '其他', account: 'other',
          raw_text: text, raw_image: null, source: 'text', status: 'pending', confidence: null, note: '',
        }
        $('capture-text').value = ''
        await localApply(tx.uid, 'put', tx)
        toast('已离线暂存，联网后自动同步')
        openEditor('parse', tx)
        refreshAll()
      } else {
        toast('解析失败：' + e.message)
      }
    }
  }

  // ---------- 列表渲染（读本地镜像，离线可用） ----------
  let lastListItems = []

  async function renderPending() {
    const list = $('pending-list')
    try {
      const items = (await mAll('tx').catch(() => []))
        .filter((t) => t.status === 'pending')
        .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
      $('pending-count').textContent = items.length ? items.length + ' 条' : ''
      $('pending-empty').classList.toggle('hidden', items.length > 0)
      list.innerHTML = items.map((t) => `
        <div class="card tx-card" data-id="${esc(t.uid)}">
          <div class="tx-main">
            <div class="tx-amt expense">${fmtMoney(t.amount)}</div>
            <div class="tx-info">
              <div class="tx-merchant">${esc(t.merchant || '（未识别商户）')}${t.raw_image || t.local_image ? ' 🖼' : ''}</div>
              <div class="tx-raw">${esc(t.raw_text || '')}</div>
            </div>
          </div>
          <div class="tx-actions">
            <button class="btn btn-small btn-primary" data-act="edit">处理</button>
            <button class="btn btn-small" data-act="del">删除</button>
          </div>
        </div>`).join('')
    } catch (e) {
      list.innerHTML = `<p class="empty">加载失败：${esc(e.message)}</p>`
    }
  }

  $('pending-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]')
    if (!btn) return
    const uid = btn.closest('.tx-card').dataset.id
    const tx = (await mAll('tx').catch(() => [])).find((t) => t.uid === uid)
    if (!tx) return toast('记录不存在')
    if (btn.dataset.act === 'edit') return openEditor('parse', tx)
    await localDelete(uid)
    refreshAll(); toast('已删除（同步中）')
  })

  function localSummary(all, month) {
    const inMonth = all.filter((t) => String(t.ts || '').startsWith(month))
    const confirmed = inMonth.filter((t) => t.status === 'confirmed' && t.amount != null)
    let expense = 0, income = 0, refund = 0, transfer = 0
    const byCat = {}
    const byAccount = {}
    const expenses = []
    const incomes = []
    // 每日支出（本月逐日）
    const [yy, mm] = month.split('-').map(Number)
    const daysInMonth = new Date(yy, mm, 0).getDate()
    const days = new Array(daysInMonth).fill(0)
    for (const t of confirmed) {
      const a = Number(t.amount) || 0
      if (t.direction === 'expense') {
        expense += a
        byCat[t.category || '其他'] = (byCat[t.category || '其他'] || 0) + a
        const k = t.account || 'other'
        byAccount[k] = (byAccount[k] || 0) + a
        const d = new Date(t.ts).getDate() - 1
        if (d >= 0 && d < daysInMonth) days[d] += a
        expenses.push(t)
      } else if (t.direction === 'income') { income += a; incomes.push(t) }
      else if (t.direction === 'refund') refund += a
      else if (t.direction === 'transfer') transfer += a
    }
    const byCategory = Object.entries(byCat)
      .map(([name, total]) => ({ name, total, n: confirmed.filter((t) => (t.category || '其他') === name && t.direction === 'expense').length }))
      .sort((a, b) => b.total - a.total)
    const topExpenses = expenses.sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 5)
    const topIncomes = incomes.sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 5)
    return {
      month, income: Math.round(income * 100) / 100, expense: Math.round(expense * 100) / 100,
      refund, transfer, balance: Math.round((income + refund - expense) * 100) / 100,
      count: confirmed.length, byCategory,
      pendingCount: all.filter((t) => t.status === 'pending').length,
      days: days.map((v) => Math.round(v * 100) / 100),
      daysInMonth,
      dailyAvg: Math.round((expense / daysInMonth) * 100) / 100,
      byAccount: Object.entries(byAccount).map(([k, v]) => ({ k, v: Math.round(v * 100) / 100 })).sort((a, b) => b.v - a.v),
      topExpenses, topIncomes,
    }
  }

  async function renderList(keepScroll = false) {
    const scroller = document.querySelector('#tab-list .panel-scroll')
    const st = keepScroll && scroller ? scroller.scrollTop : 0
    const month = $('list-month').value || localMonth()
    const q = $('list-q').value.trim().toLowerCase()
    const all = await mAll('tx').catch(() => [])
    const items = all
      .filter((t) => String(t.ts || '').startsWith(month) && (!q || [t.merchant, t.goods_name, t.note, t.raw_text].some((x) => String(x || '').toLowerCase().includes(q))))
      .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    lastListItems = items
    let lastDay = ''
    $('list-items').innerHTML = items.map((t) => {
      const day = fmtDay(t.ts)
      const dayHead = day !== lastDay ? `<div class="day-head">${esc(day)}</div>` : ''
      lastDay = day
      const cls = t.direction === 'income' ? 'income' : (t.direction === 'refund' ? 'refund' : 'expense')
      const sign = (t.direction === 'income' || t.direction === 'refund') ? '+' : '-'
      const catChip = (t.direction === 'expense' && t.category)
        ? `<span class="cat-chip" style="background:${catColor(t.category)}1f;color:${catColor(t.category)}">${esc(t.category)}</span>` : ''
      return `${dayHead}<div class="card row-card" data-id="${esc(t.uid)}">
        <div class="row-left">
          <div class="row-merchant">${esc(t.merchant || '（无商户）')}${t.status === 'pending' ? '<span class="dot-pending"></span>' : ''}${t.raw_image || t.local_image ? ' 🖼' : ''}</div>
          <div class="row-sub">${fmtTs(t.ts)} · ${esc(ACC_LABEL[t.account] || '')}${catChip}</div>
        </div>
        <div class="row-amt ${cls}">${sign}${fmtMoney(t.amount)}</div>
      </div>`
    }).join('')
    $('list-empty').classList.toggle('hidden', items.length > 0)
    if (!items.length) {
      // 空月防虚惊：找最近一个有记录的月份，给一键跳转（月初默认显示当前月，易误以为记录丢了）
      const months = [...new Set(all.map((t) => String(t.ts || '').slice(0, 7)))].filter((m) => m && m < month).sort()
      const prev = months[months.length - 1]
      const n = prev ? all.filter((t) => String(t.ts || '').startsWith(prev)).length : 0
      $('list-empty').innerHTML = prev && n
        ? `这个月还没有记录 · ${prev.slice(0, 4)} 年 ${Number(prev.slice(5, 7))} 月有 ${n} 笔<br><button type="button" class="btn btn-small" id="empty-prev" data-month="${prev}" style="margin-top:10px">查看 ${prev}</button>`
        : '这个月还没有记录'
    }
    const s = localSummary(all, month)
    $('list-summary').innerHTML = `
      <span>收入 <b class="income">+${fmtMoney(s.income)}</b></span>
      <span>支出 <b class="expense">-${fmtMoney(s.expense)}</b></span>
      <span>日均 <b class="expense">-${fmtMoney(s.dailyAvg)}</b></span>
      <span>结余 <b>${fmtMoney(s.balance)}</b></span>`
    if (scroller && keepScroll) scroller.scrollTop = st
  }

  $('list-items').addEventListener('click', (e) => {
    const card = e.target.closest('.row-card')
    if (!card) return
    const tx = lastListItems.find((t) => t.uid === card.dataset.id)
    if (tx) openEditor('edit', tx)
  })
  // 空月提示里的"查看上月"跳转（容器常驻，innerHTML 更新不影响监听）
  $('list-empty').addEventListener('click', (e) => {
    const b = e.target.closest('#empty-prev')
    if (!b) return
    $('list-month').value = b.dataset.month
    renderList().catch(() => {})
  })

  async function renderStats(keepScroll = false) {
    const scroller = document.querySelector('#tab-stats .panel-scroll')
    const st = keepScroll && scroller ? scroller.scrollTop : 0
    const month = $('stats-month').value || localMonth()
    const all = await mAll('tx').catch(() => [])
    const s = localSummary(all, month)
    $('stats-cards').innerHTML = `
      <div class="stat-card"><div class="stat-num income" data-cnt="${s.income}" data-sign="+" data-dec="2">+${fmtMoney(s.income)}</div><div class="stat-label">收入</div></div>
      <div class="stat-card"><div class="stat-num expense" data-cnt="${s.expense}" data-sign="-" data-dec="2">-${fmtMoney(s.expense)}</div><div class="stat-label">支出</div></div>
      <div class="stat-card"><div class="stat-num" data-cnt="${Math.abs(s.balance)}" data-sign="${s.balance < 0 ? '-' : '+'}" data-dec="2">${fmtMoney(s.balance)}</div><div class="stat-label">结余</div></div>
      <div class="stat-card"><div class="stat-num" data-cnt="${s.count}" data-sign="" data-dec="0">${s.count}</div><div class="stat-label">笔数</div></div>`
    requestAnimationFrame(() => { runCountUps(); if (scroller && keepScroll) scroller.scrollTop = st })
    renderStatsExtra(s)
    renderRecs(month)
    renderMerchants(month).catch(() => {})
  }

  // 信息面板：每日支出 / 分类环图 / 账户分布 / 近6月趋势 / 收支排行
  function renderStatsExtra(s) {
    // 分类环形图
    const cats = s.byCategory || []
    let donutHtml = '<p class="empty">这个月还没有支出</p>'
    if (cats.length) {
      const totalCat = cats.reduce((a, c) => a + c.total, 0) || 1
      let acc = 0
      const stops = cats.map((c) => {
        const from = acc
        acc += (c.total / totalCat) * 100
        return `${catColor(c.name)} ${from}% ${acc}%`
      })
      donutHtml = `
        <div class="donut-wrap">
          <div class="donut" style="background:conic-gradient(${stops.join(',')})">
            <div class="donut-center"><b data-cnt="${s.expense}" data-sign="-" data-dec="2">${fmtMoney(s.expense)}</b><span>总支出</span></div>
          </div>
          <div class="donut-legend">
            ${cats.slice(0, 9).map((c) => `
              <div class="donut-legend-row">
                <span class="dot" style="background:${catColor(c.name)}"></span>
                <span class="lg-name">${esc(c.name)}</span>
                <span class="lg-pct">${Math.round((c.total / totalCat) * 100)}%</span>
                <span class="lg-amt">${fmtMoney(c.total)}</span>
              </div>`).join('')}
          </div>
        </div>`
    }
    // 每日支出柱状图
    const maxDay = Math.max(...s.days, 1)
    const todayIdx = new Date().getDate() - 1
    const dayBars = s.days.map((v, i) => {
      const h = v > 0 ? Math.max(5, Math.round((v / maxDay) * 100)) : 0
      const isToday = i === todayIdx
      return `<div class="day-col" style="--i:${i}">
        <div class="day-val">${v > 0 ? Math.round(v) : ''}</div>
        <div class="day-bar${isToday ? ' today' : ''}" style="--h:${h}%"></div>
        <div class="day-lbl">${(i + 1) % 5 === 1 || i + 1 === s.daysInMonth ? i + 1 : ''}</div>
      </div>`
    }).join('')
    // 账户分布
    const acctColors = { wechat: '#5FB894', alipay: '#7FB5C9', bank: '#E8A33D', cash: '#A6C86B', other: '#9AA096' }
    const acctTotal = s.byAccount.reduce((a, b) => a + b.v, 0) || 1
    const acctBar = `<div class="acct-bar">${s.byAccount.map((e) => `<div style="--w:${(e.v / acctTotal) * 100}%;background:${acctColors[e.k] || '#7FB5C9'}"></div>`).join('')}</div>`
    const acctRows = s.byAccount.map((e) => `
      <div class="acct-row">
        <span class="dot" style="background:${acctColors[e.k] || '#7FB5C9'}"></span>
        <span>${esc(ACC_LABEL[e.k] || e.k)}</span>
        <span class="acct-amt">${fmtMoney(e.v)} · ${Math.round((e.v / acctTotal) * 100)}%</span>
      </div>`).join('')
    // 近 6 个月趋势
    const [yy, mm] = (s.month || localMonth()).split('-').map(Number)
    const trend = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(yy, mm - 1 - i, 1)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      trend.push({ key, label: `${d.getMonth() + 1}月` })
    }
    // 从本地镜像计算每月支出
    Promise.resolve().then(async () => {
      const all = await mAll('tx').catch(() => [])
      const totals = trend.map((t) => ({
        ...t,
        total: all.filter((x) => x.status === 'confirmed' && x.direction === 'expense' && x.amount != null && String(x.ts || '').startsWith(t.key)).reduce((a, x) => a + Number(x.amount), 0),
      }))
      const maxT = Math.max(...totals.map((t) => t.total), 1)
      $('trend-chart').innerHTML = totals.map((t) => {
        const h = t.total > 0 ? Math.max(5, Math.round((t.total / maxT) * 100)) : 0
        const cur = t.key === s.month
        return `<div class="day-col" style="--i:${totals.indexOf(t)}">
          <div class="day-val">${t.total > 0 ? Math.round(t.total) : ''}</div>
          <div class="day-bar${cur ? ' today' : ''}" style="--h:${h}%"></div>
          <div class="day-lbl">${t.label}</div>
        </div>`
      }).join('')
      // DeepSeek 式悬浮分解气泡：悬停某天 → 显示当天总额 + 商家明细 TOP3
      const chart = $('day-chart')
      const tip = $('day-tip')
      if (!chart || !tip) return
      const byDay = new Map()
      for (const x of all) {
        if (x.status !== 'confirmed' || x.direction !== 'expense' || x.amount == null) continue
        const tss = String(x.ts || '')
        if (!tss.startsWith(s.month)) continue
        const day = Number(tss.slice(8, 10))
        if (!(day >= 1 && day <= s.daysInMonth)) continue
        const key = day - 1
        const name = String(x.merchant || '').trim() || '（未记商户）'
        const arr = byDay.get(key) || []
        const it = arr.find((z) => z.name === name)
        if (it) it.amount += Number(x.amount)
        else arr.push({ name, amount: Number(x.amount) })
      }
      for (const arr of byDay.values()) arr.sort((a, b) => b.amount - a.amount)
      const showTip = (col, key) => {
        const total = s.days[key] || 0
        if (!(total > 0)) { tip.classList.add('hidden'); return }
        const arr = byDay.get(key) || []
        const top = arr.slice(0, 3)
        const rest = arr.slice(3).reduce((a, z) => a + z.amount, 0)
        tip.innerHTML = `<div class="day-tip-date">${s.month}-${String(key + 1).padStart(2, '0')} · 共 ¥${fmtMoney(total)}</div>` +
          top.map((z) => `<div class="day-tip-row"><span class="day-tip-name">${esc(z.name)}</span><b>¥${fmtMoney(z.amount)}</b></div>`).join('') +
          (rest > 0.005 ? `<div class="day-tip-row"><span class="day-tip-name">其他 ${arr.length - 3} 项</span><b>¥${fmtMoney(rest)}</b></div>` : '') +
          (arr.length ? '<div class="day-tip-hint">点击柱条在流水中查看当天</div>' : '')
        tip.classList.remove('hidden')
        const wrap = chart.parentElement
        let left = col.offsetLeft + col.offsetWidth / 2
        left = Math.max(90, Math.min(left, (wrap.clientWidth || 300) - 90))
        tip.style.left = left + 'px'
      }
      const dayKey = (col) => [...chart.children].indexOf(col)
      chart.addEventListener('mouseover', (e) => {
        const col = e.target.closest('.day-col')
        if (col) showTip(col, dayKey(col))
      })
      chart.addEventListener('mouseleave', () => tip.classList.add('hidden'))
      chart.addEventListener('click', (e) => {
        const col = e.target.closest('.day-col')
        if (!col) return
        const key = dayKey(col)
        if (!((s.days[key] || 0) > 0)) return
        $('list-month').value = s.month
        $('list-q').value = ''
        switchTab('list')
        renderList().catch(() => {})
      })
    })
    // TOP 支出 / 收入
    const topExp = (s.topExpenses || []).map((t, i) => `
      <div class="top-row"><span class="top-rank">${i + 1}</span><span class="top-name">${esc(t.merchant || '（无商户）')}${t.goods_name ? ' · ' + esc(t.goods_name) : ''}</span><b class="expense">-${fmtMoney(t.amount)}</b></div>`).join('') || '<p class="empty">暂无</p>'
    const topInc = (s.topIncomes || []).map((t, i) => `
      <div class="top-row"><span class="top-rank">${i + 1}</span><span class="top-name">${esc(t.merchant || '（无商户）')}${t.note ? ' · ' + esc(t.note) : ''}</span><b class="income">+${fmtMoney(t.amount)}</b></div>`).join('') || '<p class="empty">暂无</p>'
    $('stats-extra').innerHTML = `
      <div class="stat-block" id="merchant-block">
        <div class="stat-block-title">🏪 钱花在哪个商家（本月）</div>
        <p class="empty">加载中…</p>
      </div>
      <div class="stat-block">
        <div class="stat-block-title">📅 每日支出（本月）· 日均 ${fmtMoney(s.dailyAvg)}</div>
        <div class="day-chart-wrap"><div class="day-chart" id="day-chart">${dayBars}</div><div id="day-tip" class="day-tip hidden"></div></div>
      </div>
      <div class="stat-row">
        <div class="stat-block">
          <div class="stat-block-title">🍩 支出分类</div>
          ${donutHtml}
        </div>
        <div class="stat-block">
          <div class="stat-block-title">💳 账户分布（支出）</div>
          ${s.byAccount.length ? acctBar + acctRows : '<p class="empty">暂无数据</p>'}
        </div>
      </div>
      <div class="stat-row">
        <div class="stat-block">
          <div class="stat-block-title">📈 近 6 个月支出</div>
          <div class="day-chart" id="trend-chart"><div class="empty">加载中…</div></div>
        </div>
        <div class="stat-block">
          <div class="stat-block-title">🏆 收支排行 TOP5</div>
          <div class="top-sub">🔥 最大支出</div>
          ${topExp}
          <div class="top-sub" style="margin-top:8px">💚 最大收入</div>
          ${topInc}
        </div>
      </div>
      <div class="stat-block" id="rec-block">
        <div class="stat-block-title">💡 平替与优质推荐（本月账单）</div>
        <p class="empty">分析中…（首次联网搜索需要一点时间）</p>
      </div>`
    requestAnimationFrame(runCountUps)
  }

  // 理财页：50/30/20 法则（必要/想要/储蓄占收入比）+ 先存后花日可花 + 信封预算总览
  async function renderFin() {
    const el = $('fin-block')
    if (!el) return
    const month = $('fin-month').value || localMonth()
    try {
      const d = (await api('/api/finance?month=' + encodeURIComponent(month))).data
      const line = (label, v, p, target, invert, cls) => {
        const pTxt = p === null ? '（先记一笔本月收入）' : `${p}%（目标${invert ? '≥' : '≤'}${target}%）`
        const good = p === null ? null : (invert ? p >= target : p <= target)
        const flag = good === null ? '' : ` <span class="${good ? 'fin-ok' : 'fin-bad'}">${good ? '✓ 达标' : '⚠ 超标'}</span>`
        const w = Math.max(3, Math.min(100, p === null ? 3 : p))
        return `<div class="fin-row">
          <div class="fin-head"><span>${label}</span><span><b class="${cls}">¥${fmtMoney(v)}</b> · ${pTxt}${flag}</span></div>
          <div class="cat-bar-wrap"><div class="cat-bar" style="--w:${w}%"></div></div>
        </div>`
      }
      const safe = d.safeToday === null
        ? '<p class="fin-safe dim">先记一笔本月收入，才能算"今天还能花多少"（先存后花）</p>'
        : `<p class="fin-safe">今天还能花 <b class="expense">¥${fmtMoney(d.safeToday)}</b> · 本月剩 ${d.daysLeft} 天 <span class="dim">（先存后花：按收入 80% 摊到剩余每天）</span></p>`
      const budget = d.budgetTotal > 0
        ? `信封预算已用 <b class="${d.expense > d.budgetTotal ? 'expense' : 'income'}">${Math.round((d.expense / d.budgetTotal) * 100)}%</b>（¥${fmtMoney(d.expense)} / ¥${fmtMoney(d.budgetTotal)}）· 明细见下方信封`
        : '未设置信封预算：用下方编辑器给分类设限额（可一键生成本月实际）'
      const savCls = d.savings.total < 0 ? 'expense' : 'income'
      el.innerHTML = `
        <div class="stat-block-title">50/30/20（必要 ≤50% · 想要 ≤30% · 储蓄 ≥20%）<span class="m-total">储蓄率 ${d.savings.rate === null ? '—' : d.savings.rate + '%'}</span></div>
        ${line('🥗 必要支出', d.needs.total, d.needs.pct, 50, false, 'expense')}
        ${line('🛍️ 想要支出', d.wants.total, d.wants.pct, 30, false, 'expense')}
        ${line('🐷 储蓄（结余）', d.savings.total, d.savings.rate, 20, true, savCls)}
        ${safe}
        <p class="hint" style="margin:8px 0 0">✉️ ${budget}</p>`
      renderBudget(month)
    } catch (e) {
      el.innerHTML = `<div class="stat-block-title">50/30/20（必要 ≤50% · 想要 ≤30% · 储蓄 ≥20%）</div><p class="empty">加载失败：${esc(e.message)}</p>`
    }
  }

  // 商家维度月度排行（服务端聚合 + 上月环比；点击商家 → 流水按该商家过滤）
  let merchantsFull = false
  async function renderMerchants(month, showAll) {
    const el = $('merchant-block')
    if (!el) return
    try {
      const d = await api('/api/merchants?month=' + encodeURIComponent(month))
      const list = d.merchants || []
      if (!list.length) {
        el.innerHTML = '<div class="stat-block-title">🏪 钱花在哪个商家（本月）</div><p class="empty">这个月还没有支出</p>'
        return
      }
      merchantsFull = !!showAll
      const max = Math.max(...list.map((m) => m.total), 1)
      const rows = (top) => list.slice(0, top).map((m, i) => {
        const pct = Math.round((m.total / (d.curTotal || 1)) * 100)
        let badge = ''
        if (m.prev > 0) {
          const diff = Math.round(((m.total - m.prev) / m.prev) * 100)
          if (diff > 2) badge = `<span class="m-badge up">↑${diff}%</span>`
          else if (diff < -2) badge = `<span class="m-badge down">↓${-diff}%</span>`
          else badge = '<span class="m-badge flat">持平</span>'
        } else if (d.prevTotal > 0) {
          badge = '<span class="m-badge new">新</span>'
        }
        return `<div class="m-row" data-merchant="${esc(m.name)}" title="点击在流水中查看该商家的每一笔">
          <span class="top-rank">${i + 1}</span>
          <div class="m-main">
            <div class="m-head"><span class="m-name">${esc(m.name)}</span>${badge}<span class="m-cnt">${m.n}笔</span></div>
            <div class="cat-bar-wrap"><div class="cat-bar" style="--w:${Math.max(4, Math.round((m.total / max) * 100))}%"></div></div>
          </div>
          <div class="m-nums"><b class="expense">-${fmtMoney(m.total)}</b><span>占${pct}%</span></div>
        </div>`
      }).join('')
      const limit = merchantsFull ? list.length : Math.min(12, list.length)
      el.innerHTML = `<div class="stat-block-title">🏪 钱花在哪个商家（本月）<span class="m-total">共 -${fmtMoney(d.curTotal)}${d.prevTotal > 0 ? ` · 上月 -${fmtMoney(d.prevTotal)}` : ''}</span></div>
        <div id="m-rows">${rows(limit)}</div>
        ${list.length > 12 && !merchantsFull ? `<button class="btn btn-small" id="m-more">展开全部 ${list.length} 个商家</button>` : ''}`
      const moreBtn = $('m-more')
      if (moreBtn) moreBtn.addEventListener('click', () => renderMerchants(month, true))
      $('m-rows').addEventListener('click', (e) => {
        const row = e.target.closest('.m-row')
        if (!row) return
        $('list-month').value = month
        $('list-q').value = row.dataset.merchant === '（未记商户）' ? '' : row.dataset.merchant
        switchTab('list')
        renderList().catch(() => {})
      })
    } catch (e) {
      el.innerHTML = `<div class="stat-block-title">🏪 钱花在哪个商家（本月）</div><p class="empty">加载失败：${esc(e.message)}</p>`
    }
  }

  // 账单驱动的平替/优质推荐（服务器缓存结果，force 重新分析）
  async function renderRecs(month, force) {
    const el = $('rec-block')
    if (!el) return
    el.innerHTML = `<div class="stat-block-title">💡 平替与优质推荐（本月账单）</div><p class="empty">${force ? '重新分析中…（联网搜索需要一点时间）' : '分析中…（首次联网搜索需要一点时间）'}</p>`
    try {
      const d = await api('/api/recommend?month=' + encodeURIComponent(month) + (force ? '&force=1' : ''))
      const items = d.items || []
      if (!items.length) {
        el.innerHTML = `<div class="stat-block-title">💡 平替与优质推荐（本月账单）</div><p class="empty">这个月没发现值得优化的商品。想买具体东西？点右下角 🤖 AI 助手直接问。</p>`
        return
      }
      el.innerHTML = `
        <div class="stat-block-title">💡 平替与优质推荐（本月账单）<button class="btn btn-small" id="rec-refresh">重新生成</button></div>
        ${items.map((it) => `
          <div class="rec-item">
            <div class="rec-head">🛒 ${esc(it.product)}</div>
            <div class="rec-reason">${esc(it.reason || '')}</div>
            ${it.cheaperText ? `<div class="rec-sec"><div class="rec-sec-t cheaper">💰 更便宜的方案</div><div class="rec-body">${esc(it.cheaperText)}</div></div>` : ''}
            ${it.betterText ? `<div class="rec-sec"><div class="rec-sec-t better">✨ 更好的升级</div><div class="rec-body">${esc(it.betterText)}</div></div>` : ''}
          </div>`).join('')}
        <p class="rec-note">价格来自联网搜索，随时波动，仅供参考。想买其他东西？点右下角 🤖 AI 助手。</p>`
      $('rec-refresh').addEventListener('click', () => renderRecs(month, true))
    } catch (e) {
      el.innerHTML = `<div class="stat-block-title">💡 平替与优质推荐（本月账单）</div><p class="empty">推荐加载失败：${esc(e.message)}</p>`
    }
  }

  // ---------- 预算（借鉴 Firefly/Actual：月度分类限额 + 进度跟踪） ----------
  async function renderBudget(month) {
    const list = $('budget-list')
    try {
      const d = await api('/api/budgets?month=' + encodeURIComponent(month))
      if (!d.list.length) {
        list.innerHTML = '<p class="empty">还没设置预算。选一个分类、填限额，保存后这里会显示进度。</p>'
      } else {
        list.innerHTML = d.list.map((b) => {
          const pct = Math.min(100, Math.round((b.spent / b.limit) * 100))
          const over = b.spent > b.limit
          return `<div class="cat-row" data-cat="${esc(b.category)}">
            <div class="cat-name">${esc(b.category)}</div>
            <div class="cat-bar-wrap"><div class="cat-bar" style="--w:${Math.max(3, pct)}%;background:${over ? '#D9534F' : '#2FA574'}"></div></div>
            <div class="cat-amt ${over ? 'expense' : ''}">${fmtMoney(b.spent)}/${b.limit}</div>
          </div>`
        }).join('')
      }
    } catch (e) {
      list.innerHTML = `<p class="empty">预算加载失败：${esc(e.message)}</p>`
    }
  }

  function fillBudgetSelect() {
    const sel = $('bud-cat')
    const cur = sel.value
    sel.innerHTML = categories.expense.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')
    if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur
  }

  function budgetActions() {
    $('bud-save').addEventListener('click', async () => {
      const category = $('bud-cat').value
      const limit = Number($('bud-limit').value)
      if (!category) return toast('请选择分类')
      if (!Number.isFinite(limit) || limit <= 0) return toast('请输入正确的限额')
      try {
        await api('/api/budgets', { method: 'PUT', body: { month: $('fin-month').value || localMonth(), category, limit } })
        $('bud-limit').value = ''
        toast('预算已保存')
        renderBudget($('fin-month').value || localMonth())
      } catch (e) { toast('保存失败：' + e.message) }
    })
    // 按本月实际支出一键生成预算（>50 元向上取整到十位，避免零碎数字）
    $('bud-auto').addEventListener('click', async () => {
      const month = $('fin-month').value || localMonth()
      try {
        const s = await api('/api/summary?month=' + encodeURIComponent(month))
        const cats = (s.byCategory || []).filter((c) => c.total > 0)
        if (!cats.length) return toast('这个月还没有支出，没法按实际生成')
        if (!confirm(`将按 ${month} 实际支出为 ${cats.length} 个分类设置预算（覆盖已有），继续？`)) return
        for (const c of cats) {
          const limit = c.total <= 50 ? Math.ceil(c.total) : Math.ceil(c.total / 10) * 10
          await api('/api/budgets', { method: 'PUT', body: { month, category: c.name, limit } })
        }
        toast(`✓ 已按本月实际为 ${cats.length} 个分类生成预算`)
        renderBudget(month)
      } catch (e) { toast('生成失败：' + e.message) }
    })
    $('budget-list').addEventListener('click', async (e) => {
      const row = e.target.closest('.cat-row')
      if (!row || !confirm('删除这个预算？')) return
      try {
        await api('/api/budgets?month=' + encodeURIComponent($('fin-month').value || localMonth()) + '&category=' + encodeURIComponent(row.dataset.cat), { method: 'DELETE' })
        toast('已删除')
        renderBudget($('fin-month').value || localMonth())
      } catch (err) { toast('删除失败：' + err.message) }
    })
  }

  function refreshAll() {
    renderPending().catch(() => {})
    // 桌面端一次只显示一个面板：只刷新当前激活的视图（keepScroll 避免后台同步把滚动位置打回顶部）
    const active = document.querySelector('.side-item[data-tab].active')?.dataset.tab || 'list'
    if (active === 'list') renderList(true).catch(() => {})
    if (active === 'stats') renderStats(true).catch(() => {})
    if (active === 'fin') renderFin().catch(() => {})
  }

  // ---------- 设置 ----------
  function showSettings() {
    // AI 区块只在模型异常时出现；一切正常则完全不显示模型相关内容
    const msgs = modelAlertMsgs(modelStatusCache)
    const aiSection = msgs.length ? `
      <h3>AI 模型（异常，需处理）</h3>
      <p class="hint warn-text">${esc(msgs.join('；'))}</p>
      <p class="hint">充值 / 更换 API Key 后点保存，提示会自动消失。DeepSeek 控制台：platform.deepseek.com；视觉模型（阿里云百炼）：bailian.console.aliyun.com。</p>
      <label>DeepSeek API Key（文字解析）<input id="set-llm" type="password" autocomplete="off" placeholder="sk-..."></label>
      <div class="btn-row">
        <button type="button" class="btn" id="set-llm-save">保存并重试</button>
      </div>
      <p id="set-llm-status" class="hint"></p>` : ''

    openModal('设置', `
      <p class="hint">首次在手机上使用时，把电脑 <code>.env</code> 里的 AUTH_TOKEN 粘贴到这里。</p>
      <label>访问令牌<input id="set-token" type="password" autocomplete="off"></label>
      <div class="btn-row">
        <button type="button" class="btn" data-close>关闭</button>
        <button type="button" class="btn btn-primary" id="set-save">保存并测试</button>
      </div>
      <p id="set-status" class="hint"></p>
      ${aiSection}
      <h3>自动化</h3>
      <p class="hint">解析置信度达到阈值就直接入账，不弹确认框；1.0 = 全部手动确认。</p>
      <label>自动入账阈值
        <select id="set-autoconfirm">
          <option value="0.9">0.9 · 只自动放行高置信度（推荐）</option>
          <option value="0.8">0.8 · 更自动</option>
          <option value="0.7">0.7 · 激进</option>
          <option value="1">1.0 · 关闭自动，全部确认</option>
        </select>
      </label>
      <p id="set-auto-status" class="hint"></p>
      <h3>连接手机</h3>
      <p class="hint">用 iPhone 相机扫二维码即可自动配对（令牌免输入），扫完建议"添加到主屏幕"当 App 用。</p>
      <div id="qr-panel" class="conn-panel"></div>
      <h3>账单导入</h3>
      <p class="hint">每 12 小时自动检查邮箱：只读取白名单发件人（微信/支付宝/银行）的账单邮件并解析入库，其他邮件一律不碰、不上传云端。也可以手动触发。</p>
      <div class="btn-row">
        <button type="button" class="btn" id="set-import">立即检查邮箱导入</button>
      </div>
      <p id="set-import-status" class="hint"></p>
      <h3>账单核验</h3>
      <p class="hint">导入时已留存原始账单行。核验会把账单行与账本逐行比对（缺失 / 金额不符 / 方向不符 / 疑似重复），异常项交由强模型终审（qwen3.8-flash 长文本优先，DeepSeek 托底），模型只给意见不改账。</p>
      <div class="btn-row">
        <input id="audit-month" type="month" class="month-input">
        <button type="button" class="btn" id="btn-audit">🧾 核验账单</button>
        <button type="button" class="btn hidden" id="audit-download">⬇️ 下载核验报告 CSV</button>
      </div>
      <p id="audit-status" class="hint"></p>
      <h3>月报提醒</h3>
      <p class="hint">每月 1 日自动把上月汇总发到邮箱（绑定微信「QQ邮箱提醒」即可在微信里收到；可加 Server酱 直推微信，见 README）。</p>
      <div class="btn-row">
        <button type="button" class="btn" id="set-report">发送本月测试月报</button>
      </div>
      <p id="set-report-status" class="hint"></p>
      <h3>连接</h3>
      <p class="hint">自动检测可用地址，优先局域网直连；在家点"打开"切换到局域网地址更快，校园网会自动走 Tailscale。</p>
      <div id="conn-panel" class="conn-panel"></div>
      <div class="btn-row">
        <button type="button" class="btn" id="set-reprobe">重新检测</button>
      </div>`)
    $('set-token').value = token
    $('set-save').addEventListener('click', async () => {
      token = $('set-token').value.trim()
      localStorage.setItem(TOKEN_KEY, token)
      try {
        await api('/api/health')
        $('set-status').textContent = '✓ 连接成功'
      } catch (e) {
        $('set-status').textContent = '✗ 连接失败：' + e.message
      }
    })
    // AI Key 保存（仅异常时存在该区块；服务器回写 .env 并立即生效）
    const llmSave = $('set-llm-save')
    if (llmSave) {
      llmSave.addEventListener('click', async () => {
        const key = $('set-llm').value.trim()
        try {
          const d = await api('/api/settings', { method: 'POST', body: { llm_api_key: key } })
          $('set-llm-status').textContent = d.llmConfigured ? '✓ 已保存并生效' : '✓ 已清空（手动模式）'
          await refreshModelAlert()
          if (!modelAlertMsgs(modelStatusCache).length) { closeModal(); toast('模型已恢复 ✓') }
        } catch (e) {
          $('set-llm-status').textContent = '✗ 保存失败：' + e.message
        }
      })
    }
    // 自动入账阈值（保存到服务器，对所有设备生效）
    $('set-autoconfirm').addEventListener('change', async () => {
      const v = Number($('set-autoconfirm').value)
      try {
        await api('/api/settings', { method: 'POST', body: { auto_confirm: v } })
        $('set-auto-status').textContent = '✓ 已保存'
      } catch (e) {
        $('set-auto-status').textContent = '✗ 保存失败：' + e.message
      }
    })
    $('set-reprobe').addEventListener('click', async () => {
      renderConnPanel()
      const el = $('conn-panel')
      el.innerHTML = '<p class="hint">检测中…</p>'
      const pick = await refreshEndpoints().catch(() => null)
      if (!pick) el.innerHTML = '<p class="hint">所有地址都不可达，请检查电脑是否开机、服务是否启动</p>'
    })
    $('set-import').addEventListener('click', async () => {
      const st = $('set-import-status')
      st.textContent = '导入中…'
      try {
        const d = await api('/api/import-bills', { method: 'POST' })
        const parts = [`新导入 ${d.imported} 条`, `跳过重复 ${d.skipped} 条`]
        if (d.merged > 0) parts.push(`LLM 合并 ${d.merged} 条`)
        if (d.passwords > 0) parts.push(`识别到 ${d.passwords} 个解压密码`)
        if (d.mergeError) parts.push(`⚠ 合并审核失败(${d.mergeError})，新导入的请人工核对是否重复`)
        st.textContent = `✓ 完成：${parts.join('，')}${d.error ? '（' + d.error + '）' : ''}`
        refreshAll()
      } catch (e) {
        st.textContent = '✗ ' + e.message
      }
    })
    // 账单核验：账单行 vs 账本逐行比对 + 模型终审；报告可下载
    $('btn-audit').addEventListener('click', async () => {
      const st = $('audit-status')
      const month = $('audit-month').value || localMonth()
      $('audit-month').value = month
      st.textContent = '核验中…（含模型终审，最长约 2 分钟）'
      $('audit-download').classList.add('hidden')
      try {
        const d = (await api('/api/audit?month=' + encodeURIComponent(month))).data
        const s = d.summary
        const lines = [`账单行 ${s.billRows} 条：✓正常 ${s.ok}，⚠缺失 ${s.missing}，⚠不符 ${s.mismatch}；疑似重复对 ${s.dupPairs}`]
        if (d.llm?.note) lines.push(`模型终审（${d.llm.ok ? d.llm.model : '未完成'}）：${d.llm.note}`)
        st.textContent = lines.join('\n')
        if (s.missing + s.mismatch + s.dupPairs > 0) $('audit-download').classList.remove('hidden')
      } catch (e) { st.textContent = '✗ ' + e.message }
    })
    $('audit-download').addEventListener('click', async () => {
      const month = $('audit-month').value || localMonth()
      try {
        const res = await fetch('/api/audit/export?month=' + encodeURIComponent(month), { headers: token ? { 'X-Auth-Token': token } : {} })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const blob = await res.blob()
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `pennywise-audit-${month}.csv`
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(a.href), 5000)
      } catch (e) { toast('下载失败：' + e.message) }
    })
    $('set-report').addEventListener('click', async () => {
      const st = $('set-report-status')
      st.textContent = '发送中…'
      try {
        const d = await api('/api/report', { method: 'POST' })
        const ok = d.channels.filter((c) => c.ok).map((c) => c.name)
        const bad = d.channels.filter((c) => !c.ok)
        st.textContent = ok.length ? `✓ 已通过 ${ok.join(' / ')} 发送` + (bad.length ? `；${bad.length} 个渠道失败：${bad.map((c) => c.error).join('；')}` : '') : '✗ 发送失败：' + bad.map((c) => c.error).join('；')
      } catch (e) {
        st.textContent = '✗ ' + e.message
      }
    })
    renderConnPanel()
    renderQrPanel()
    // 回填自动入账阈值（模型相关内容仅在异常区块显示）
    api('/api/health').then((h) => {
      const sel = $('set-autoconfirm')
      if (sel) {
        const cur = String(h.autoConfirm ?? 0.9)
        if ([...sel.options].some((o) => o.value === cur)) sel.value = cur
        else { const o = document.createElement('option'); o.value = cur; o.textContent = cur; sel.appendChild(o); sel.value = cur }
      }
    }).catch(() => {})
  }

  async function renderQrPanel() {
    const el = $('qr-panel')
    if (!el) return
    let info = null
    try {
      const r = await fetch('/api/connect-info')
      if (r.ok) info = await r.json()
    } catch { /* 网络问题忽略 */ }
    if (!info?.data) {
      el.innerHTML = '<p class="hint">（仅电脑端显示二维码：请在这台电脑的浏览器打开本页查看）</p>'
      return
    }
    const d = info.data
    const tok = encodeURIComponent(d.token || '')
    const entries = []
    if (d.lan?.[0]) entries.push({ label: '家里局域网（无需装任何 App，速度最快）', url: `http://${d.lan[0].ip}:${d.port}/#pw-token=${tok}` })
    if (d.tailscale?.[0]) entries.push({ label: 'Tailscale（校园网 / 出门在外，手机需装 Tailscale 并登录同一账号）', url: `http://${d.tailscale[0].ip}:${d.port}/#pw-token=${tok}` })
    if (d.tsName) entries.push({ label: 'HTTPS 域名（离线增强，需先开启 tailscale serve）', url: `https://${d.tsName}/#pw-token=${tok}` })
    if (!entries.length) { el.innerHTML = '<p class="hint">未检测到可用网络地址</p>'; return }
    el.innerHTML = entries.map((e) => `
      <div class="qr-item">
        <div class="qr-label">${esc(e.label)}</div>
        <img class="qr-img" src="/api/qr?size=220&text=${encodeURIComponent(e.url)}" alt="扫码连接">
      </div>`).join('')
  }
  $('btn-settings').addEventListener('click', showSettings)

  // ---------- 本地镜像 + 双向同步（离线优先） ----------
  let mirrorDb = null
  function openMirror() {
    return new Promise((resolve, reject) => {
      if (mirrorDb) return resolve(mirrorDb)
      const r = indexedDB.open('pw-mirror', 1)
      r.onupgradeneeded = () => {
        const d = r.result
        if (!d.objectStoreNames.contains('tx')) d.createObjectStore('tx', { keyPath: 'uid' })
        if (!d.objectStoreNames.contains('ops')) d.createObjectStore('ops', { keyPath: 'uid' })
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' })
      }
      r.onsuccess = () => { mirrorDb = r.result; resolve(mirrorDb) }
      r.onerror = () => reject(r.error)
    })
  }
  function mReq(store, mode, fn) {
    return openMirror().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode)
      const rq = fn(t.objectStore(store))
      rq.onsuccess = () => resolve(rq.result)
      rq.onerror = () => reject(rq.error)
    }))
  }
  const mAll = (s) => mReq(s, 'readonly', (o) => o.getAll())
  const mGet = (s, k) => mReq(s, 'readonly', (o) => o.get(k))
  const mPut = (s, v) => mReq(s, 'readwrite', (o) => o.put(v))
  const mDel = (s, k) => mReq(s, 'readwrite', (o) => o.delete(k))

  // 任何改动：先写本地镜像（立即生效），再进待同步队列
  async function localApply(uid, type, data) {
    const now = new Date().toISOString()
    const mirrorData = Object.assign({}, data)
    delete mirrorData.image_base64 // 大体积图片只放同步队列，镜像里不存两份
    await mPut('tx', Object.assign({}, mirrorData, { uid }))
    await mPut('ops', { uid, type, data, updated_at: now })
    syncSoon()
  }
  async function localDelete(uid) {
    await mDel('tx', uid)
    await mPut('ops', { uid, type: 'del', data: null, updated_at: new Date().toISOString() })
    syncSoon()
  }

  let syncTimer = null
  function syncSoon() { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 1500) }

  async function syncNow() {
    if (!navigator.onLine) { updateChip(); return }
    const base = apiBase || ''
    const hdrs = token ? { 'X-Auth-Token': token } : {}
    let changed = false // 只有账本真的变化了才刷新视图，避免每 30 秒重渲染造成"自己刷新"
    // 1) 拉取服务器增量
    const since = Number((await mGet('meta', 'rev').catch(() => null))?.v || 0)
    try {
      const r = await fetch(base + '/api/sync?since=' + since, { headers: hdrs })
      if (r.ok) {
        const j = await r.json()
        const ops = await mAll('ops').catch(() => [])
        const pend = new Map(ops.map((o) => [o.uid, o]))
        for (const ch of j.data.changes || []) {
          const p = pend.get(ch.uid)
          const srvTs = ch.type === 'put' ? (ch.data?.updated_at || '') : (ch.updated_at || '')
          if (p) {
            if ((p.updated_at || '') >= srvTs) continue // 本地更新 → 保留本地版本，稍后推送覆盖
            await mDel('ops', ch.uid) // 本地更旧 → 放弃本地改动
          }
          if (ch.type === 'del') { await mDel('tx', ch.uid); changed = true }
          else { await mPut('tx', Object.assign({}, ch.data, { uid: ch.uid })); changed = true }
        }
        await mPut('meta', { k: 'rev', v: String(j.data.rev) })
      }
    } catch (e) { /* 网络抖动，下次再拉 */ }
    // 2) 推送本地变更
    try {
      const ops = await mAll('ops').catch(() => [])
      if (ops.length) {
        const r = await fetch(base + '/api/sync', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, hdrs),
          body: JSON.stringify({ changes: ops.map((o) => ({ uid: o.uid, type: o.type, data: o.data, updated_at: o.updated_at })) }),
        })
        if (r.ok) {
          const j = await r.json()
          for (const uid of j.data.applied || []) await mDel('ops', uid)
          if ((j.data.applied || []).length) changed = true
        }
      }
    } catch (e) { /* 稍后重试 */ }
    refreshModelAlert().catch(() => {})
    updateChip()
    if (changed) refreshAll()
  }
  async function updateChip() {
    const n = (await mAll('ops').catch(() => [])).length
    const chips = [...document.querySelectorAll('#net-chip, #side-net')]
    let text, cls
    if (!navigator.onLine) {
      text = '离线'; cls = 'chip chip-off'
    } else if (n) {
      text = `待同步 ${n}`; cls = 'chip chip-warn'
    } else if (activeEndpoint) {
      const label = activeEndpoint.kind === 'lan' ? '局域网直连'
        : activeEndpoint.kind === 'tailscale' ? 'Tailscale' : '在线'
      text = label; cls = 'chip chip-ok'
    } else {
      text = '在线'; cls = 'chip chip-ok'
    }
    for (const chip of chips) { chip.textContent = text; chip.className = cls }
  }

  function renderConnPanel() {
    const el = $('conn-panel')
    if (!el) return
    if (!endpoints.length) { el.innerHTML = '<p class="hint">检测中…</p>'; return }
    el.innerHTML = endpoints.map((e) => {
      const status = e.ok === true ? `<span class="ok">✓ 可达 ${e.ms}ms</span>`
        : e.ok === false ? '<span class="bad">✗ 不可达</span>'
        : '<span class="dim">— 浏览器不允许跨协议探测</span>'
      const kindLabel = e.kind === 'lan' ? '局域网' : e.kind === 'tailscale' ? 'Tailscale' : '当前地址'
      const active = activeEndpoint && e.url === activeEndpoint.url ? '<span class="ok">● 使用中</span>' : ''
      const openLink = e.url !== location.origin
        ? ` <a class="link" href="${esc(e.url)}#pw-token=${encodeURIComponent(token)}">打开</a>` : ''
      return `<div class="conn-row">
        <div class="conn-url">${esc(e.url)}</div>
        <div class="conn-sub">${kindLabel} ${active} ${status}${openLink}</div>
      </div>`
    }).join('')
  }

  window.addEventListener('online', () => { updateChip(); syncNow(); refreshEndpoints().catch(() => {}) })
  window.addEventListener('offline', updateChip)

  // ---------- AI 助手（网页聊天，与邮箱 Agent 同一套逻辑） ----------
  let chatGreeted = false
  $('btn-chat').addEventListener('click', () => {
    $('chat-modal').classList.remove('hidden')
    if (!chatGreeted) {
      chatGreeted = true
      addChatMsg('ai', '你好！我是 PennyWise 的 AI 助手 🤖\n\n· 发交易文本给我直接记账（如"全家便利店 18.5 元"）\n· 问账目（如"这个月餐饮花了多少"）\n· 求平替（如"想买 100 元的洗发水，有更好的推荐吗"）')
    }
    $('chat-input').focus()
  })
  $('[data-close-chat]').addEventListener('click', () => $('chat-modal').classList.add('hidden'))
  $('chat-modal').addEventListener('click', (e) => {
    if (e.target === $('chat-modal')) $('chat-modal').classList.add('hidden')
  })
  function addChatMsg(who, text) {
    const el = document.createElement('div')
    el.className = 'msg ' + who
    el.textContent = text
    $('chat-msgs').appendChild(el)
    $('chat-msgs').scrollTop = $('chat-msgs').scrollHeight
  }
  async function sendChat() {
    const text = $('chat-input').value.trim()
    if (!text) return
    $('chat-input').value = ''
    addChatMsg('user', text)
    try {
      const d = await api('/api/agent', { method: 'POST', body: { text } })
      addChatMsg('ai', d.reply || '（没有回复）')
      if (d.kind === 'record') {
        syncNow()
        renderList().catch(() => {})
        renderStats().catch(() => {})
      }
    } catch (e) {
      addChatMsg('ai', '发送失败：' + e.message)
    }
  }
  $('chat-send').addEventListener('click', sendChat)
  $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat() })

  // ---------- 锁定屏 ----------
  function showLock() {
    $('lock-screen').classList.remove('hidden')
    $('lock-token').focus()
  }
  function hideLock() {
    $('lock-screen').classList.add('hidden')
  }
  $('lock-btn').addEventListener('click', async () => {
    const t = $('lock-token').value.trim()
    if (!t) return
    try {
      const r = await fetch('/api/health', { headers: { 'X-Auth-Token': t } })
      if (!r.ok) throw new Error('bad')
      token = t
      localStorage.setItem(TOKEN_KEY, token)
      $('lock-token').value = ''
      $('lock-status').textContent = ''
      hideLock()
      if (booted) location.reload() // 运行中令牌失效后重新验证：整体重载恢复干净状态
      else bootApp()
    } catch (e) {
      $('lock-status').textContent = '✗ 令牌无效，请检查后重试'
    }
  })

  // ---------- 邮箱助手：状态 + 处理动态 + 系统通知 ----------
  const FEED_ICO = { mail: '✉️', bill: '📥', record: '💰', report: '📈', info: '🔔' }
  function feedItem(ev) {
    return `<div class="feed-item"><span class="feed-ico">${FEED_ICO[ev.type] || '🔔'}</span>` +
      `<div class="feed-main"><div class="feed-title">${esc(ev.title)}</div>${ev.body ? `<div class="feed-body">${esc(ev.body)}</div>` : ''}</div>` +
      `<span class="feed-time">${fmtTs(ev.at)}</span></div>`
  }
  async function refreshMailFeed() {
    try {
      const d = await api('/api/notify?after=0')
      const events = d.events || []
      $('mail-feed').innerHTML = events.map(feedItem).join('')
      $('mail-feed-empty').classList.toggle('hidden', events.length > 0)
    } catch (e) { /* 离线时不打扰 */ }
  }
  async function renderMail() {
    try {
      const h = await api('/api/health')
      const bi = h.billImport || {}
      const chip = (cls, txt) => `<span class="chip ${cls}">${txt}</span>`
      $('mail-status-chips').innerHTML =
        chip(bi.enabled ? 'chip-ok' : 'chip-off', bi.enabled ? '账单导入已开启' : '账单导入未开启') +
        (bi.lastRun ? chip('chip-warn', '上次导入 ' + fmtTs(bi.lastRun)) : '')
    } catch (e) { /* 静默 */ }
    await refreshMailFeed()
  }
  // 顶栏邮箱红点：事件中心有新动态就亮；点开邮箱页即视为已读
  const MAIL_READ_KEY = 'pw-mail-read-seq'
  function showMailDot() {
    document.querySelectorAll('.mail-dot').forEach((d) => d.classList.remove('hidden'))
  }
  function markMailRead() {
    api('/api/notify?after=0').then((d) => {
      localStorage.setItem(MAIL_READ_KEY, String(d.seq || 0))
      document.querySelectorAll('.mail-dot').forEach((d) => d.classList.add('hidden'))
    }).catch(() => { /* 离线时保留红点 */ })
  }
  async function checkMailDot() {
    try {
      const d = await api('/api/notify?after=0')
      const read = Number(localStorage.getItem(MAIL_READ_KEY) || 0)
      if ((d.seq || 0) > read) showMailDot()
    } catch (e) { /* 离线不打扰 */ }
  }

  // ---------- 背景粒子装饰（点阵波浪，零依赖 canvas；尊重"减弱动态效果"，页面隐藏时暂停省电） ----------
  function initBgFx() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if ($('bg-fx')) return
    const cv = document.createElement('canvas')
    cv.id = 'bg-fx'
    document.body.prepend(cv)
    const ctx = cv.getContext('2d')
    const COLORS = ['169, 196, 178', '235, 195, 190', '196, 190, 168'] // 手账薄荷绿 / 奶粉 / 暖灰
    let W = 0, H = 0, dots = [], hidden = false, t = Math.random() * 10000
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      W = window.innerWidth; H = window.innerHeight
      cv.width = W * dpr; cv.height = H * dpr
      cv.style.width = W + 'px'; cv.style.height = H + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const n = Math.round(Math.min(110, Math.max(40, (W * H) / 26000)))
      dots = Array.from({ length: n }, (_, i) => ({
        x: Math.random() * W,
        y: H * (0.04 + Math.random() * 0.55),
        r: 0.8 + Math.random() * 1.8,
        c: COLORS[i % COLORS.length],
        base: 0.1 + Math.random() * 0.26,
        ph: Math.random() * Math.PI * 2,
        amp: 6 + Math.random() * 22,
        sp: 0.008 + Math.random() * 0.02,
        vx: 0.012 + Math.random() * 0.03,
      }))
    }
    function tick() {
      if (hidden) return
      t += 1
      ctx.clearRect(0, 0, W, H)
      for (const d of dots) {
        d.x -= d.vx
        if (d.x < -8) d.x = W + 8
        const y = d.y + Math.sin(t * d.sp + d.ph) * d.amp
        const a = Math.max(0.04, d.base + Math.sin(t * d.sp * 1.7 + d.ph) * 0.1)
        ctx.beginPath()
        ctx.fillStyle = `rgba(${d.c},${a.toFixed(3)})`
        ctx.arc(d.x, y, d.r, 0, Math.PI * 2)
        ctx.fill()
      }
      requestAnimationFrame(tick)
    }
    resize()
    window.addEventListener('resize', resize)
    document.addEventListener('visibilitychange', () => {
      hidden = document.hidden
      if (!hidden) requestAnimationFrame(tick)
    })
    requestAnimationFrame(tick)
  }

  // 启动前验证：必须通过令牌校验才能进入（电脑本机与手机一视同仁，无验证不进网页）
  async function ensureUnlocked() {
    if (!token) return showLock()
    const r = await fetch('/api/health', { headers: { 'X-Auth-Token': token } }).catch(() => null)
    if (r && r.ok) { hideLock(); return bootApp() }
    if (r && r.status === 401) {
      token = ''
      localStorage.removeItem(TOKEN_KEY)
      return showLock()
    }
    // 网络完全不可用：持有此前验证过的令牌才进入离线模式
    if (!r) { hideLock(); return bootApp() }
    return showLock()
  }

  let booted = false
  function bootApp() {
    if (booted) return
    booted = true
    initApp()
  }

  // 应用正式启动（已通过解锁验证）
  async function initApp() {
    initBgFx()
    $('list-month').value = localMonth()
    $('stats-month').value = localMonth()
    $('fin-month').value = localMonth()
    $('list-month').addEventListener('change', renderList)
    $('stats-month').addEventListener('change', renderStats)
    $('fin-month').addEventListener('change', renderFin)
    let deb
    $('list-q').addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(renderList, 400) })
    $('modal').addEventListener('click', (e) => {
      if (e.target === $('modal') || e.target.closest('[data-close]')) closeModal()
    })
    try { indexedDB.deleteDatabase('pw-outbox') } catch (e) { /* 清理旧版离线队列 */ }
    refreshEndpoints().catch(() => {})
    refreshModelAlert().catch(() => {})
    // 邮箱账单：立即导入 + 顶栏红点
    $('mail-check').addEventListener('click', async () => {
      const btn = $('mail-check')
      btn.disabled = true
      try {
        const d = await api('/api/import-bills', { method: 'POST' })
        toast(d.error ? `导入失败：${d.error}` : `📥 导入完成：新增 ${d.imported || 0} 笔，跳过重复 ${d.skipped || 0} 笔`)
        await refreshMailFeed()
        syncNow()
      } catch (e) { toast(e.message || '导入失败') } finally { btn.disabled = false }
    })
    $('btn-mail').addEventListener('click', () => {
      switchTab('mail')
      markMailRead()
    })
    checkMailDot().catch(() => {})
    // 分类：在线拉取并缓存到本地，离线用缓存
    try {
      categories = await api('/api/categories')
      await mPut('meta', { k: 'categories', v: JSON.stringify(categories) })
    } catch (e) {
      const cached = (await mGet('meta', 'categories').catch(() => null))?.v
      if (cached) { try { categories = JSON.parse(cached) } catch { /* 忽略 */ } }
    }
    fillBudgetSelect()
    budgetActions()
    applyLayout()
    updateChip()
    syncNow()
    setInterval(syncNow, 30000)
    setInterval(() => { refreshEndpoints().catch(() => {}) }, 60000)
    if ('serviceWorker' in navigator) {
      // 仅用于"分享入账"接收；页面不再缓存，也绝不自动刷新（自动刷新曾造成莫名重载）
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {})
    }
    // 实时事件：后台收到月度账单邮件并处理完数据 → 刷新账本；其他邮件不刷新
    if (token && typeof EventSource !== 'undefined') {
      try {
        const es = new EventSource('/api/events?t=' + encodeURIComponent(token))
        es.addEventListener('bills', (e) => {
          let n = ''
          try { n = String(JSON.parse(e.data || '{}').imported || '') } catch { /* 忽略 */ }
          toast(n ? `📥 月度账单已导入 ${n} 笔，账本已更新` : '📥 月度账单已导入，账本已更新')
          syncNow()
        })
        // 事件中心：账单导入等动态 → 红点提示 + 页内 toast + 动态刷新
        es.addEventListener('notify', (e) => {
          let ev = null
          try { ev = JSON.parse(e.data || 'null') } catch { /* 忽略 */ }
          if (!ev) return
          toast(`${ev.title}${ev.body ? '：' + ev.body : ''}`, 3600)
          showMailDot()
          refreshMailFeed().catch(() => {})
        })
      } catch { /* 不支持事件流时依赖 30 秒同步轮询 */ }
    }
  }

  // ---------- 初始化 ----------
  async function init() {
    // 从"打开"/扫码链接带来的令牌（免重新输入）
    const frag = location.hash.match(/pw-token=([^&]+)/)
    if (frag) {
      token = decodeURIComponent(frag[1])
      localStorage.setItem(TOKEN_KEY, token)
      history.replaceState(null, '', location.pathname + location.search)
      setTimeout(() => toast('✓ 已自动配对，建议点分享 → 添加到主屏幕'), 1200)
    }
    // 分享式记账回跳：截图/文本已被 Service Worker 收进账本
    const shared = location.search.match(/shared=(image|text)/)
    if (shared) {
      history.replaceState(null, '', location.pathname)
      setTimeout(() => {
        if (shared[1] === 'image') toast('✓ 已接收截图，AI 识别中…')
        else toast('✓ 已接收文本，AI 解析中…')
        syncNow()
      }, 800)
    }
    ensureUnlocked()
  }
  init()
})()
