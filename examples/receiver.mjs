import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const directory = process.env.DSH_HOME || join(homedir(), '.dsh')
const { token } = JSON.parse(await readFile(join(directory, 'bili-notification-webhook.json'), 'utf8'))
if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw Error('需要 64 位小写十六进制令牌')

const digest = value => createHash('sha256').update(value).digest()
const expected = digest('Bearer ' + token)
const server = createServer({ requestTimeout: 5000, headersTimeout: 5000 }, (request, response) => {
  if (request.method !== 'POST' || request.url !== '/bili/dm-wake') return response.writeHead(404).end()
  if (!timingSafeEqual(digest(request.headers.authorization ?? ''), expected)) return response.writeHead(401).end()
  console.log('收到 PagePup 唤醒请求')
  response.writeHead(202).end()
})
server.listen(34568, '127.0.0.1', () => console.log('接收端已监听 127.0.0.1:34568'))
