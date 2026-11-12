import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'

export const defaultUrl = 'http://127.0.0.1:34568/bili/dm-wake'

export async function loadNetwork(directory) {
  const file = join(directory, 'pagepup-network.json')
  let entries
  try {
    entries = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    try {
      const { token } = JSON.parse(await readFile(join(directory, 'bili-notification-webhook.json'), 'utf8'))
      entries = [{ id: 'default', name: '小鲸鱼', url: defaultUrl, enabled: true, token }]
    } catch (legacyError) {
      if (legacyError.code !== 'ENOENT') throw legacyError
      entries = []
    }
  }
  if (!Array.isArray(entries)) throw Error('网络配置格式无效')
  let pending = Promise.resolve()
  return {
    enabled: () => entries.filter(entry => entry.enabled),
    list: () => entries.map(({ token, ...entry }) => ({ ...entry, hasToken: Boolean(token) })),
    find: id => entries.find(entry => entry.id === id),
    change(input) {
      const update = pending.then(async () => {
        const existing = entries.find(entry => entry.id === input.id)
        if (input.id && !existing) throw Error('配置已不存在，请刷新')
        const next = entries.filter(entry => entry !== existing)
        if (input.action === 'toggle' && existing) {
          next.push({ ...existing, enabled: !existing.enabled })
        } else if (input.action !== 'delete') {
          const name = typeof input.name === 'string' ? input.name.trim() : ''
          const token = input.token || existing?.token
          let url
          try { url = new URL(input.url) } catch { throw Error('请输入有效的接收地址') }
          if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.username || url.password || url.hash || url.search) {
            throw Error('接收地址须使用 127.0.0.1，且不含账号、查询参数或片段')
          }
          if (!name || name.length > 80 || !/^[a-f0-9]{64}$/.test(token ?? '')) throw Error('请输入名称和 64 位小写十六进制令牌')
          if (next.some(entry => entry.url === url.href)) throw Error('该接收地址已存在')
          next.push({ id: existing?.id ?? randomUUID(), name, url: url.href, token, enabled: existing?.enabled ?? true })
        }
        await mkdir(directory, { recursive: true })
        const temporary = file + '.' + randomUUID() + '.tmp'
        try {
          await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' })
          await rename(temporary, file)
          entries = next
        } finally {
          await rm(temporary, { force: true })
        }
      })
      pending = update.catch(() => {})
      return update
    },
  }
}

export function testReceiver(entry) {
  const url = new URL(entry.url)
  return new Promise(resolve => {
    const socket = connect({ host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), timeout: 3000 })
    const finish = result => { socket.destroy(); resolve(result) }
    socket.once('connect', () => finish('端口可连接'))
    socket.once('timeout', () => finish('连接超时'))
    socket.once('error', () => finish('端口不可连接'))
  })
}
