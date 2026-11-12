import { createServer } from 'node:http'
import { cpus, freemem, totalmem, type } from 'node:os'
import { readFile } from 'node:fs/promises'
import { testReceiver } from './network.mjs'

function cpuTimes() {
  const totals = { total: 0, idle: 0 }
  for (const { times } of cpus()) {
    totals.total += Object.values(times).reduce((sum, time) => sum + time, 0)
    totals.idle += times.idle
  }
  return totals
}

export async function startWebUI(status, network, session) {
  const html = await readFile(new URL('./webui.html', import.meta.url))
  const mascot = await readFile(new URL('./pagepup-golden.png', import.meta.url))
  const port = Number(process.env.PAGEPUP_WEBUI_PORT ?? 6100)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('WebUI 端口无效')
  let previous = cpuTimes()
  let cpu = null
  const sample = setInterval(() => {
    const current = cpuTimes()
    const elapsed = current.total - previous.total
    if (elapsed > 0) cpu = Math.round(100 * (1 - (current.idle - previous.idle) / elapsed))
    previous = current
  }, 1000)
  sample.unref()
  const host = '127.0.0.1:' + port
  const server = createServer(async (request, response) => {
    if (request.headers.host !== host) {
      response.writeHead(403).end()
      return
    }
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Cache-Control', 'no-store')
    const json = (code, value) => response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value))
    if (['/session/logout', '/session/qr/start', '/session/qr/poll'].includes(request.url)) {
      if (request.method !== 'POST' || request.headers.origin !== 'http://' + host) return json(403, { error: '请在本机管理页操作' })
      try {
        if (request.url === '/session/logout') {
          await session.logout()
          return json(200, { signedOut: status.signedOut })
        }
        if (!status.signedOut) return json(200, { state: 'logged-in' })
        return json(200, await session.qrLogin(request.url.endsWith('/start') ? 'start' : 'poll'))
      } catch {
        return json(502, { error: '登录操作失败，请重试' })
      }
    }
    if (request.url === '/network') {
      if (request.method === 'GET') return json(200, { entries: network.list() })
      if (request.method !== 'POST' || request.headers.origin !== 'http://' + host || request.headers['content-type'] !== 'application/json') {
        return json(403, { error: '请在本机管理页操作' })
      }
      try {
        let body = ''
        for await (const chunk of request) {
          body += chunk
          if (body.length > 8192) throw Error('请求过长')
        }
        const input = JSON.parse(body)
        if (input?.action === 'test') {
          const entry = network.find(input.id)
          if (!entry) throw Error('配置已不存在，请刷新')
          return json(200, { result: await testReceiver(entry) })
        }
        if (!['save', 'toggle', 'delete'].includes(input?.action) || (input.action !== 'save' && !input.id)) throw Error('无效操作')
        await network.change(input)
        return json(200, { entries: network.list() })
      } catch (error) {
        return json(400, { error: error.code || error instanceof SyntaxError ? '网络配置操作失败' : error.message })
      }
    }
    if (request.method !== 'GET') return response.writeHead(405).end()
    if (request.url === '/') {
      response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https://*.hdslb.com; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'")
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html)
    } else if (request.url === '/mascot.png') {
      response.writeHead(200, { 'Content-Type': 'image/png' }).end(mascot)
    } else if (request.url === '/status') {
      const total = totalmem()
      const used = total - freemem()
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({
        ...status, cpu, used, total, system: type(), node: process.version,
      }))
    } else response.writeHead(404).end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  console.log('PagePup WebUI http://127.0.0.1:' + port)
}
