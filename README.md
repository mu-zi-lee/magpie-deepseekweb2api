# magpie-deepseekweb2api

一个 DeepSeek Web 的 Magpie provider，内部支持多个网页账号凭证（key pool）。每个 key 可以包含 `userToken` 和可选 `cookie`，同一个 Magpie 会话会粘在同一个 key 上，key 失效或冷却后才会切换。

## 产品边界

这是本地运行的 provider 插件，不是托管服务，也不会把账号凭证上传到第三方服务器。插件只会向 `chat.deepseek.com` 发起网页端请求。DeepSeek 网页接口属于内部协议，可能随网页版本变化；商业部署前应使用专用测试账号、配置出站代理和审计日志，并准备官方 API 作为降级方案。

不要把 `userToken`、Cookie 或包含它们的 Magpie 配置目录提交到 Git、日志系统或工单。多账号池适合管理你有权使用的账号，不应被用来绕过限流、验证码、封禁或平台访问控制。

当前版本先支持 DeepSeek Chat/Reasoner、网页端会话、PoW 和 SSE 流式响应。网页内部协议可能变化，插件仅适合在你有权使用的账号上进行本地开发和测试。

在 Magpie 中选择 `Sign in with userToken and Cookie`，先输入 `userToken`，再输入 Cookie。Cookie 可留空跳过，提交后会自动验证账号，不需要手写 JSON。

多账号用户可以选择 `Import DeepSeek Web keys`，粘贴 JSON：

```json
[
  {"label":"main","userToken":"..."},
  {"label":"backup","userToken":"...","cookie":"session=..."}
]
```

`userToken` 是必需字段，Cookie 是可选补充字段。仅粘贴 Cookie 会被拒绝。登录 DeepSeek 网页后，可在浏览器开发者工具的 Local Storage 中查看 `userToken`；如果值是 JSON 对象，使用其中的 `value` 字段作为 token。每个账号应使用自己的 token 和 Cookie，避免混用。

在 Magpie 中选择 `Import DeepSeek Web keys`，在随后出现的输入框粘贴凭证。此导入方式使用宿主的粘贴回调，不需要打开浏览器或授权第三方。宿主的输入框是单行时，多账号池请使用紧凑 JSON：

```json
[{"id":"main","userToken":"..."},{"id":"backup","userToken":"...","cookie":"..."}]
```

也可以使用包装对象：

```json
{"keys":[{"id":"main","userToken":"..."}]}
```

或者每行一个 token：

```text
main=token-a
backup=token-b
```

## 运行特性

- 每个 key 默认最多 2 个并发请求，最多支持 100 个 key。
- 同一个 Magpie 会话会固定到一个 key 和一个 DeepSeek Web chat session。
- 客户端传入完整历史时，会校验历史摘要并只发送新增消息；历史或指令被修改后新建上游会话，切换账号时用完整历史重建上下文。
- 只发送单条 user 消息的客户端可以续聊；需要切换账号时必须补发完整历史，否则明确报错。会话状态只记录固定长度摘要，不保存历史正文。
- 宿主重复加载相同配置时会复用账号池，保留并发限制、健康状态和会话；宿主进程重启后重新建立状态。
- 认证失败的 key 会被禁用，临时网络错误会指数退避冷却。
- 如果上游返回 `Retry-After`，key 会优先遵循服务端建议的冷却时间（最长 10 分钟）。
- 空流、损坏 SSE、未收到终止状态的断流或缺少必要 session 信息会被视为协议错误。
- SSE 支持 LF、CRLF 和 CR 换行，单帧限制为 1 MiB 字符；中途停止读取会释放上游连接。
- 客户端取消请求会停止重试，不会让账号进入冷却。
- 流式输出按客户端读取速度暂停上游读取，输出队列以 64 KiB 为阈值（可额外容纳一个当前数据块），避免慢客户端导致无限缓冲。
- PoW 默认每 128 次尝试交还执行权，并设置 90 秒计算期限；取消和其他宿主请求可在计算期间继续处理。
- 单次回复的正文与推理合计最多 2,000,000 个 JavaScript 字符单位，包含续写内容；超过限制会明确报错。
- 流式请求支持 SSE；`stream: false` 支持标准 JSON completion。
- Magpie 的 quota 页面显示 key 数量、活动数和失效数量，不显示凭证本身。
- 插件日志和错误不会输出 `userToken` 或 Cookie；排障时只使用 key 数量、状态和上游 HTTP 状态。
- 登录时会验证所有启用的 key；任何启用的 key 被拒绝都会拒绝本次登录。已停用的过期 key 可通过 `"enabled": false` 保留，至少需要一个启用的 key。
- 同一个 `userToken` 不能重复配置成多个 key，避免重复计算账号并发容量。
- 账号池内部提供按 ID 禁用、启用和清理会话的管理边界，后续可接入管理界面或配置轮换。

## 发布前检查

本地测试需要 Node.js 20.3.0 或更新版本；CI 覆盖最低支持版本及 Node.js 22、24。

```sh
npm test
npm run check
npm run pack:check
```

`pack:check` 实际生成 npm 发布包，在临时目录解包，并验证包中的入口、模型、凭证导入和模拟 completion。发布包只允许包含源码、验证脚本及公开说明，检查结束后清理临时文件。

使用 Magpie 的真实 Bun 宿主测试插件接口（需要 Bun 和 Magpie 源码）：

```sh
npm run test:host -- /absolute/path/to/magpie/internal/plugin/host.js
```

该检查启动独立宿主进程和本地模拟上游，验证凭证导入、模型列表、PoW、账号失败切换、JSON/SSE、重复加载后的健康状态和会话。测试使用虚拟凭证和临时认证目录，结束后自动清理。

## 安装

本地开发目录可以直接加载：

```sh
magpie plugin add /absolute/path/to/magpie-deepseekweb2api
magpie plugin login deepseek-web
```

如果需要在测试环境指向兼容的内部网关，可设置 `DEEPSEEK_WEB_ORIGIN`；生产环境默认只连接 `https://chat.deepseek.com`。这个变量不会改变凭证格式，只用于协议兼容测试和受控代理部署。

安全问题请阅读 [SECURITY.md](SECURITY.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 验证范围

2026-10-11 使用真实 DeepSeek Web 账号验证了登录、PoW、普通回复、流式回复和同一会话的连续调用。仅带 `userToken` 的登录与流式回复也通过，Cookie 可按账号需要配置。Reasoner 的 JSON 和 SSE 请求均已实测，推理内容与最终答案正确分开。完整历史的第二轮请求已实测，确认仅发送新增问题并保留上游上下文。

自动化测试覆盖协议解析、取消、账号池与 provider loader；另已通过本机 Magpie 源码的真实 Bun 宿主进程测试。宿主测试使用模拟上游，不等同于完整的 Magpie CLI/桌面应用验收。真实多账号故障切换、长回复续写和完整宿主安装流程仍需进一步实测。
