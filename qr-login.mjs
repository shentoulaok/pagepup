import QRCode from 'qrcode'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const passport = 'https://passport.bilibili.com/x/passport-login/web/qrcode/'
const loginOrigins = new Set(['https://passport.bilibili.com', 'https://account.bilibili.com'])

export function createQrLogin(file, onLogin) {
  let active
  let busy = false
  return async action => {
    if (busy) return { state: 'busy' }
    busy = true
    try {
      if (action === 'start') {
        const response = await fetch(passport + 'generate', { signal: AbortSignal.timeout(8000), redirect: 'error' })
        const { code, data } = await response.json()
        const url = URL.parse(data?.url)
        if (!response.ok || code !== 0 || !loginOrigins.has(url?.origin) || !data.qrcode_key) throw Error('无法生成 B 站登录二维码')
        const image = await QRCode.toDataURL(url.href, { width: 248, margin: 3 })
        active = { key: data.qrcode_key, expires: Date.now() + 180_000 }
        return { state: 'waiting', image }
      }
      if (!active || Date.now() >= active.expires) return { state: 'expired' }
      const response = await fetch(passport + 'poll?qrcode_key=' + encodeURIComponent(active.key), {
        signal: AbortSignal.timeout(8000), redirect: 'error',
      })
      const { code, data } = await response.json()
      if (!response.ok || code !== 0) throw Error('无法获取 B 站扫码状态')
      if (data.code === 86101) return { state: 'waiting' }
      if (data.code === 86090) return { state: 'scanned' }
      if (data.code === 86038) return { state: 'expired' }
      if (data.code !== 0) throw Error('B 站扫码登录失败')
      const cookies = response.headers.getSetCookie()
      const cookie = name => cookies.find(value => value.startsWith(name + '='))?.split(';', 1)[0].slice(name.length + 1)
      const sessdata = cookie('SESSDATA')
      if (!sessdata) throw Error('B 站未返回登录凭据')
      await mkdir(dirname(file), { recursive: true })
      const temporary = file + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(temporary, JSON.stringify({ sessdata, bili_jct: cookie('bili_jct') }), { mode: 0o600, flag: 'wx' })
        await rename(temporary, file)
      } finally {
        await rm(temporary, { force: true })
      }
      active = undefined
      await onLogin()
      return { state: 'logged-in' }
    } finally {
      busy = false
    }
  }
}
