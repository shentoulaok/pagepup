# PagePup · B 站私信通知监听器

<img src="pagepup-golden.png" alt="戴青绿色领巾翻书的小金毛" width="160">

一个 Node.js 命令行程序，借鉴于Napcat。它使用 B 站账号现有的登录状态，连接 B 站网页通知服务，收到私信通知时向本机程序发送唤醒请求。运行时无需保持 B 站网页打开，也无需手机或模拟器。

监听器转发的是查信信号。接收端可以通过自己的 B 站接入读取正文、验证发件人、去重和回复。

## 安装和登录

安装 Node.js 24 和 pnpm，在项目目录运行以下命令。

```sh
pnpm install --frozen-lockfile
node bili-dm-listener.mjs --webui
```

打开 [PagePup WebUI](http://127.0.0.1:6100/)，用哔哩哔哩 App 扫码并在手机上确认，等待连接状态变为「已订阅」。管理页显示最近通知和转发结果。端口冲突时，可用 `PAGEPUP_WEBUI_PORT` 指定端口。

「网络配置」可新建、编辑、启停或删除本机 HTTP 转发地址。保存后立即生效。已有的小鲸鱼接收配置会显示为默认卡片，首次保存后使用 `DSH_HOME/pagepup-network.json`。调试端口只检查 TCP 连通性。

PagePup 在 `DSH_HOME/pagepup-credentials.json` 保存扫码登录凭据，下次启动自动使用。未设置 `DSH_HOME` 时，默认目录是当前用户的 `.dsh`。侧栏的「退出登录」会停止监听并打开扫码页。退出状态在重启后仍有效，扫码成功后才恢复监听。

## 快速验证

安装 Node.js 24。在当前用户目录下创建 `.bili-ai/credentials.json`，填入自己账号的有效 `sessdata`。

```json
{"sessdata":"在本机填入有效值"}
```

```sh
node bili-dm-listener.mjs --probe
```

看到「B 站长连接已订阅」后，用另一个账号发一条测试私信。终端应显示「收到 B 站私信通知」。探测模式只记录通知。

## 接入本机程序

1. 启动本机 HTTP 接收端，监听 `127.0.0.1:34568`。接收 `POST /bili/dm-wake`，校验 `Authorization: Bearer <token>`，接受后返回 HTTP 202。请求不携带私信正文。
2. 在 `DSH_HOME` 下创建 `bili-notification-webhook.json`，写入 `{"token":"64位小写十六进制令牌"}`。接收端使用同一个令牌。未设置 `DSH_HOME` 时，默认目录是当前用户的 `.dsh`。
3. 运行 `node bili-dm-listener.mjs`。进程会维护长连接，断线后尝试重新订阅。接收端仍可定时补查，以覆盖离线期间的消息。

可用 `node -p "require('node:crypto').randomBytes(32).toString('hex')"` 生成令牌。凭据、令牌和运行日志应保留在本机。

独立验证时，先创建步骤 2 的配置，再运行 `node examples/receiver.mjs`。重启 PagePup 管理页实例以加载配置，然后用另一个账号发一条测试私信。接收端应输出「收到 PagePup 唤醒请求」，管理页应显示「1 / 1 接收成功」。两个进程使用同一个 `DSH_HOME`。

## 验证范围

当前版本已在 Windows 上从干净目录验证安装、扫码登录、订阅、接收真实私信通知和本机 HTTP 转发。示例接收端返回 HTTP 202，管理页显示「1 / 1 接收成功」。小鲸鱼的回复调度由下游接入处理。

这是非官方实现，协议字段参考 [B 站网页通知客户端](https://s1.hdslb.com/bfs/seed/crayon/im/message-notify.js)。B 站调整网页协议时，监听器可能需要更新。
