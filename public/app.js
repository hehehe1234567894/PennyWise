/* PennyWise PWA 前端（零依赖原生 JS） */
(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const fmtMoney = (n) => (n === null || n === undefined) ? '—' : '¥' + Number(n).toFixed(2)
  const DIR_LABEL = { expense: '支出', income: '收入', refund: '退款', transfer: '转账' }
  const ACC_LABEL = { wechat: '微信', alipay: '支付宝', bank: '银行卡', cash: '现金', other: '其他' }
  const CAT_COLORS = ['#4f8cff', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#94a3b8']

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
      const r = await fetch(url + '/api/reachability', { signal: ctrl.signal })
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
        if (!$('set-save')) showSettings()
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

  const TAB_RENDER = { pending: renderPending, list: renderList, stats: renderStats }
  function switchTab(name) {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name))
    ;['capture', 'pending', 'list', 'stats'].forEach((t) => { $(`tab-${t}`).hidden = t !== name })
    if (TAB_RENDER[name]) TAB_RENDER[name]()
  }
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)))

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
    const confirmed = all.filter((t) => t.status === 'confirmed' && t.amount != null && String(t.ts || '').startsWith(month))
    let expense = 0, income = 0, refund = 0, transfer = 0
    const byCat = {}
    for (const t of confirmed) {
      const a = Number(t.amount) || 0
      if (t.direction === 'expense') { expense += a; byCat[t.category || '其他'] = (byCat[t.category || '其他'] || 0) + a }
      else if (t.direction === 'income') income += a
      else if (t.direction === 'refund') refund += a
      else if (t.direction === 'transfer') transfer += a
    }
    const byCategory = Object.entries(byCat)
      .map(([name, total]) => ({ name, total, n: confirmed.filter((t) => (t.category || '其他') === name && t.direction === 'expense').length }))
      .sort((a, b) => b.total - a.total)
    return {
      month, expense: Math.round(expense * 100) / 100, income: Math.round(income * 100) / 100,
      refund, transfer, balance: Math.round((income + refund - expense) * 100) / 100,
      count: confirmed.length, byCategory,
      pendingCount: all.filter((t) => t.status === 'pending').length,
    }
  }

  async function renderList() {
    const month = $('list-month').value || localMonth()
    const q = $('list-q').value.trim().toLowerCase()
    const all = await mAll('tx').catch(() => [])
    const items = all
      .filter((t) => String(t.ts || '').startsWith(month) && (!q || [t.merchant, t.goods_name, t.note, t.raw_text].some((x) => String(x || '').toLowerCase().includes(q))))
      .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    lastListItems = items
    $('list-items').innerHTML = items.map((t) => {
      const cls = t.direction === 'income' ? 'income' : (t.direction === 'refund' ? 'refund' : 'expense')
      const sign = (t.direction === 'income' || t.direction === 'refund') ? '+' : '-'
      return `<div class="card row-card" data-id="${esc(t.uid)}">
        <div class="row-left">
          <div class="row-merchant">${esc(t.merchant || '（无商户）')}${t.status === 'pending' ? '<span class="dot-pending"></span>' : ''}${t.raw_image || t.local_image ? ' 🖼' : ''}</div>
          <div class="row-sub">${fmtTs(t.ts)} · ${esc(t.category || DIR_LABEL[t.direction] || '')} · ${esc(ACC_LABEL[t.account] || '')}</div>
        </div>
        <div class="row-amt ${cls}">${sign}${fmtMoney(t.amount)}</div>
      </div>`
    }).join('')
    $('list-empty').classList.toggle('hidden', items.length > 0)
    const s = localSummary(all, month)
    $('list-summary').innerHTML = `
      <span>收入 <b class="income">+${fmtMoney(s.income)}</b></span>
      <span>支出 <b class="expense">-${fmtMoney(s.expense)}</b></span>
      <span>结余 <b>${fmtMoney(s.balance)}</b></span>`
  }

  $('list-items').addEventListener('click', (e) => {
    const card = e.target.closest('.row-card')
    if (!card) return
    const tx = lastListItems.find((t) => t.uid === card.dataset.id)
    if (tx) openEditor('edit', tx)
  })

  async function renderStats() {
    const month = $('stats-month').value || localMonth()
    const all = await mAll('tx').catch(() => [])
    const s = localSummary(all, month)
    $('stats-cards').innerHTML = `
      <div class="stat-card"><div class="stat-num income">+${fmtMoney(s.income)}</div><div class="stat-label">收入</div></div>
      <div class="stat-card"><div class="stat-num expense">-${fmtMoney(s.expense)}</div><div class="stat-label">支出</div></div>
      <div class="stat-card"><div class="stat-num">${fmtMoney(s.balance)}</div><div class="stat-label">结余</div></div>`
    const cats = s.byCategory || []
    const max = cats.length ? Math.max(...cats.map((c) => c.total)) : 0
    $('stats-cats').innerHTML = cats.length ? cats.map((c, i) => `
      <div class="cat-row">
        <div class="cat-name"><span class="dot" style="background:${CAT_COLORS[i % CAT_COLORS.length]}"></span>${esc(c.name)} <span class="cat-n">${c.n}笔</span></div>
        <div class="cat-bar-wrap"><div class="cat-bar" style="width:${max ? Math.max(3, Math.round((c.total / max) * 100)) : 3}%;background:${CAT_COLORS[i % CAT_COLORS.length]}"></div></div>
        <div class="cat-amt">${fmtMoney(c.total)}</div>
      </div>`).join('') : '<p class="empty">这个月还没有支出</p>'
  }

  function refreshAll() {
    renderPending().catch(() => {})
    const active = document.querySelector('.tab.active')?.dataset.tab
    if (active === 'list') renderList().catch(() => {})
    if (active === 'stats') renderStats().catch(() => {})
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
      <p class="hint">银行短信自动记账（0 点击）：<a class="link" href="/shortcut">下载快捷指令</a> → 导入后到「快捷指令 App → 自动化 → 收到信息」选择发卡银行号码并运行它。</p>
      <h3>账单导入</h3>
      <p class="hint">配置邮箱后（.env 里 MAIL_* 与 AUTO_IMPORT=1），微信/支付宝账单邮件每 12 小时自动导入一次，完全不用管；也可以手动触发。</p>
      <div class="btn-row">
        <button type="button" class="btn" id="set-import">立即检查邮箱导入</button>
      </div>
      <p id="set-import-status" class="hint"></p>
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
        st.textContent = `✓ 完成：新导入 ${d.imported} 条，跳过重复 ${d.skipped} 条${d.error ? '（' + d.error + '）' : ''}`
        refreshAll()
      } catch (e) {
        st.textContent = '✗ ' + e.message
      }
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
          if (ch.type === 'del') await mDel('tx', ch.uid)
          else await mPut('tx', Object.assign({}, ch.data, { uid: ch.uid }))
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
        }
      }
    } catch (e) { /* 稍后重试 */ }
    refreshModelAlert().catch(() => {})
    updateChip()
    refreshAll()
  }
  async function updateChip() {
    const n = (await mAll('ops').catch(() => [])).length
    const chip = $('net-chip')
    if (!navigator.onLine) {
      chip.textContent = '离线'; chip.className = 'chip chip-off'
    } else if (n) {
      chip.textContent = `待同步 ${n}`; chip.className = 'chip chip-warn'
    } else if (activeEndpoint) {
      const label = activeEndpoint.kind === 'lan' ? '局域网直连'
        : activeEndpoint.kind === 'tailscale' ? 'Tailscale' : '在线'
      chip.textContent = label
      chip.className = 'chip chip-ok'
    } else {
      chip.textContent = '在线'; chip.className = 'chip chip-ok'
    }
    chip.classList.remove('hidden')
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
      bootApp()
    } catch (e) {
      $('lock-status').textContent = '✗ 令牌无效，请检查后重试'
    }
  })

  // 启动前验证：有效令牌 → 进入；本机直连（电脑端）→ 免令牌进入；否则锁定
  async function ensureUnlocked() {
    if (token) {
      const r = await fetch('/api/health', { headers: { 'X-Auth-Token': token } }).catch(() => null)
      if (r && r.ok) return bootApp()
      if (r && r.status === 401) {
        // 存储的令牌失效：试试本机免令牌（电脑端换了令牌的情况）
        const r2 = await fetch('/api/health').catch(() => null)
        if (r2 && r2.ok) return bootApp()
        token = ''
        localStorage.removeItem(TOKEN_KEY)
        return showLock()
      }
      // 网络完全不可用：有令牌先进入离线模式（采集走离线队列）
      if (!r) return bootApp()
      return showLock()
    }
    // 无存储令牌：本机直连免令牌，否则锁定
    const r = await fetch('/api/health').catch(() => null)
    if (r && r.ok) return bootApp()
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
    $('list-month').value = localMonth()
    $('stats-month').value = localMonth()
    $('list-month').addEventListener('change', renderList)
    $('stats-month').addEventListener('change', renderStats)
    let deb
    $('list-q').addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(renderList, 400) })
    $('modal').addEventListener('click', (e) => {
      if (e.target === $('modal') || e.target.closest('[data-close]')) closeModal()
    })
    try { indexedDB.deleteDatabase('pw-outbox') } catch (e) { /* 清理旧版离线队列 */ }
    refreshEndpoints().catch(() => {})
    refreshModelAlert().catch(() => {})
    // 分类：在线拉取并缓存到本地，离线用缓存
    try {
      categories = await api('/api/categories')
      await mPut('meta', { k: 'categories', v: JSON.stringify(categories) })
    } catch (e) {
      const cached = (await mGet('meta', 'categories').catch(() => null))?.v
      if (cached) { try { categories = JSON.parse(cached) } catch { /* 忽略 */ } }
    }
    updateChip()
    syncNow()
    setInterval(syncNow, 30000)
    setInterval(() => { refreshEndpoints().catch(() => {}) }, 60000)
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
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
