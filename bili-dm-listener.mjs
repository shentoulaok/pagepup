import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadNetwork } from './network.mjs'

const broadcast = 'bilibili.broadcast.v1'
const rpc = method => '/' + broadcast + '.Broadcast/' + method
const watch = [
  '/bilibili.broadcast.message.im.Notify/WatchNotify',
  '/bilibili.broadcast.message.im.v2.NotifyV2/WatchNotify',
]
const joinBytes = (...parts) => Buffer.concat(parts)
function varint(value) {
  let remaining = BigInt(value)
  const bytes = []
  while (remaining >= 128n) {
    bytes.push(Number(remaining & 127n) | 128)
    remaining >>= 7n
  }
  return Buffer.from([...bytes, Number(remaining)])
}
const integer = (field, value) => joinBytes(varint(field * 8), varint(value))
function bytes(field, value) {
  const data = Buffer.from(value)
  return joinBytes(varint(field * 8 + 2), varint(data.length), data)
}

function decode(buffer) {
  const fields = new Map()
  let offset = 0
  function readInteger() {
    let result = 0n
    for (let shift = 0n; shift < 70n && offset < buffer.length; shift += 7n) {
      const byte = buffer[offset++]
      result |= BigInt(byte & 127) << shift
      if (byte < 128) return result
    }
    throw Error('Invalid protobuf integer')
  }
  while (offset < buffer.length) {
    const tag = Number(readInteger())
    const wire = tag & 7
    const field = tag >>> 3
    if (wire === 0) fields.set(field, readInteger())
    else if (wire === 2) {
      const length = Number(readInteger())
      if (length > buffer.length - offset) throw Error('Truncated protobuf field')
      fields.set(field, buffer.subarray(offset, offset += length))
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4
      if (offset > buffer.length) throw Error('Truncated protobuf field')
    } else throw Error('Unsupported protobuf wire type')
  }
  return fields
}

const probe = process.argv.includes('--probe')
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const credentialsFile = join(homedir(), '.bili-ai', 'credentials.json')
const pagepupCredentials = join(dshHome, 'pagepup-credentials.json')
const logoutFile = join(dshHome, 'pagepup-signed-out')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const status = { connection: '正在连接', account: null, signedOut: false, notification: null, forwarding: '等待通知', probe, events: [] }
let session = new AbortController()
let resume
function setSignedOut(signedOut) {
  if (status.signedOut === signedOut) return
  status.signedOut = signedOut
  status.account = null
  if (signedOut) {
    session.abort()
    status.connection = '已退出登录'
  } else {
    session = new AbortController()
    status.connection = '正在连接'
    resume?.()
  }
}
function log(message) {
  const time = new Date().toISOString()
  console.log(time, message)
  status.events.unshift({ time, message })
  status.events.splice(30)
}

const webui = process.argv.includes('--webui')
const network = webui ? await loadNetwork(dshHome) : null
async function savedCredentials() {
  try { return await json(pagepupCredentials) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    return json(credentialsFile)
  }
}
if (webui) {
  const { createQrLogin } = await import('./qr-login.mjs')
  const { startWebUI } = await import('./webui.mjs')
  const wasSignedOut = await access(logoutFile).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  const saved = await savedCredentials().catch(() => null)
  if (wasSignedOut || !saved?.sessdata) setSignedOut(true)
  const qrLogin = createQrLogin(pagepupCredentials, async () => {
    await rm(logoutFile, { force: true })
    setSignedOut(false)
  })
  await startWebUI(status, network, {
    qrLogin,
    async logout() {
      await mkdir(dshHome, { recursive: true })
      await writeFile(logoutFile, '', { mode: 0o600 })
      setSignedOut(true)
    },
  })
}

async function readAccount(sessdata, signal) {
  try {
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { Cookie: 'SESSDATA=' + sessdata, Referer: 'https://www.bilibili.com/' },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    })
    if (!response.ok) return
    const { code, data } = await response.json()
    if (!signal.aborted && code === -101) setSignedOut(true)
    if (signal.aborted || !data?.isLogin || !Number.isSafeInteger(data.mid) || typeof data.uname !== 'string') return
    const face = URL.parse(data.face)
    const avatar = face?.protocol === 'https:' && face.hostname.endsWith('.hdslb.com') ? face.href : null
    status.account = { name: data.uname, uid: String(data.mid), avatar }
  } catch {
    // Account details are optional for the notification connection.
  }
}

async function connect(signal) {
  const { sessdata } = await savedCredentials()
  if (!sessdata || /[;\r\n]/.test(sessdata)) throw Error('B 站登录凭据缺失或格式无效')
  const routes = !probe && !network ? await loadNetwork(dshHome) : network
  signal.throwIfAborted()
  if (webui) void readAccount(sessdata, signal)
  const socket = new WebSocket('wss://broadcast.chat.bilibili.com:7826/sub', {
    protocols: ['proto'],
    headers: { Cookie: 'SESSDATA=' + sessdata, Origin: 'https://message.bilibili.com' },
  })
  socket.binaryType = 'arraybuffer'
  let sequence = 0
  let subscribed = false
  let lastFrame = Date.now()
  let lastWake = -Infinity
  function send(method, type, value = Buffer.alloc(0)) {
    const body = joinBytes(bytes(1, 'type.googleapis.com/' + broadcast + '.' + type), bytes(2, value))
    socket.send(joinBytes(bytes(1, integer(2, ++sequence)), bytes(2, rpc(method)), bytes(3, body)))
  }
  async function wake() {
    if (signal.aborted) return
    const now = Date.now()
    if (now - lastWake < 1000) return
    lastWake = now
    status.notification = new Date(now).toISOString()
    log('收到 B 站私信通知')
    if (probe) return
    const receivers = routes.enabled()
    const results = await Promise.all(receivers.map(async receiver => {
      try {
        const response = await fetch(receiver.url, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + receiver.token },
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
        })
        log(receiver.name + (response.status === 202 ? ' 已接收通知' : ' 返回 HTTP ' + response.status))
        return response.status === 202
      } catch {
        log(receiver.name + ' 暂不可用')
        return false
      }
    }))
    if (!signal.aborted) status.forwarding = receivers.length ? results.filter(Boolean).length + ' / ' + receivers.length + ' 接收成功' : '无启用的接收端'
  }
  const timer = setInterval(() => {
    if (Date.now() - lastFrame > 45_000) socket.close()
    else if (socket.readyState === WebSocket.OPEN) send('Heartbeat', 'HeartbeatResp')
  }, 20_000)
  const close = () => socket.close()
  signal.addEventListener('abort', close, { once: true })
  await new Promise(resolve => {
    socket.addEventListener('open', () => send('Auth', 'AuthReq', bytes(1, randomUUID())))
    socket.addEventListener('message', event => {
      if (signal.aborted) return
      try {
        const frame = decode(Buffer.from(event.data))
        const target = frame.get(2)?.toString()
        const options = decode(frame.get(1) ?? Buffer.alloc(0))
        const rpcStatus = decode(options.get(4) ?? Buffer.alloc(0)).get(1) ?? 0n
        lastFrame = Date.now()
        if (rpcStatus !== 0n) {
          log('B 站长连接返回状态 ' + rpcStatus)
          if (target === rpc('Auth') || target === rpc('Subscribe')) socket.close()
          return
        }
        if (options.get(3) && options.has(1)) {
          send('MessageAck', 'MessageAckReq', joinBytes(
            integer(1, options.get(1)), bytes(2, options.get(5) ?? ''), bytes(3, target ?? ''),
            integer(4, options.get(7) ?? 0n),
          ))
        }
        if (target === rpc('Auth')) send('Subscribe', 'TargetPath', joinBytes(...watch.map(path => bytes(1, path))))
        if (target === rpc('Subscribe')) {
          subscribed = true
          status.connection = '已订阅'
          log('B 站长连接已订阅')
        }
        if (subscribed && watch.includes(target) && decode(frame.get(3) ?? Buffer.alloc(0)).get(2)?.length) void wake()
      } catch {
        log('收到无法解析的 B 站长连接帧')
      }
    })
    socket.addEventListener('error', () => log('B 站长连接错误'))
    socket.addEventListener('close', event => {
      if (!signal.aborted) status.connection = '等待重连'
      log('B 站长连接已关闭，状态 ' + event.code)
      resolve()
    }, { once: true })
  }).finally(() => {
    clearInterval(timer)
    signal.removeEventListener('abort', close)
  })
}

while (true) {
  if (status.signedOut) {
    await new Promise(resolve => { resume = resolve })
    resume = undefined
    continue
  }
  const { signal } = session
  try {
    status.connection = '正在连接'
    await connect(signal)
  } catch (error) {
    if (signal.aborted) continue
    status.connection = error.code === 'ENOENT' ? '缺少本机配置' : '等待重连'
    log('无法启动 B 站长连接：' + (error.code ?? error.name))
  }
  if (!signal.aborted) await sleep(20_000, undefined, { signal }).catch(error => {
    if (!signal.aborted) throw error
  })
}
