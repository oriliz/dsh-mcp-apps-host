# DSH MCP Apps Host — 开发问题记录

> 记录开发过程中发现的问题、根因分析和待办事项。

## P1: 工具结果未注入卡片内部渲染

**日期**: 2026-08-20 · **状态**: 已修复 (2026-08-20)

### 问题描述

Agent 调用 `utp_catalog_search` 后，搜索结果以 JSON 文本形式返回给 Agent（用于生成回复文本），但**未注入到卡片内部渲染**。卡片只显示空的搜索表单（"输入关键词搜索商品"），用户在卡片内看不到 Agent 搜索到的商品列表。

### 预期行为

Agent 工具调用的结果应同时注入到 iframe 内部，由 UTP React 应用（"UCP Catalog v5.0.0"）渲染商品列表/网格，用户可直接在卡片内浏览和操作（选择商品、加入购物车等）。

### 根因分析

`ui/initialize` 握手时 `lastToolResult` 已传入 iframe，但数据格式不匹配。

UTP React 应用（"UCP Catalog v5.0.0"）的数据提取逻辑期望 `lastToolResult` 是 `CallToolResult` 形状的对象：
```javascript
// React 应用内部逻辑（简化）
if ("products" in t || "product" in t) return t;
const n = t.structuredContent;  // ← 期望 .structuredContent 属性
return n ? ("products" in n ? n : n.body ? n.body : ...) : null;
```

旧代码传递的是 `currentBlock.content`（render 输出的文本数组），不含 `structuredContent` 属性 → React 应用无法提取产品数据 → 显示空表单。

### 影响范围

所有依赖卡片内展示工具结果的场景：
- 搜索结果列表（catalog_search）
- 商品详情（catalog_product）
- 购物车内容（cart_list）

### 修复方案

**两处改动**：

1. **`src/index.ts` `presentationMeta()`**: 将工具结果的 `content` + `structuredContent` 包装为 `CallToolResult` 形状对象，作为 `meta.lastToolResult` 传递
2. **`src/client/McpAppCard.tsx` `ui/initialize`**: 从 `meta.lastToolResult` 读取（回退到 `content`），传给 iframe

UTP React 应用的数据流：`lastToolResult.structuredContent` → `body` → `products` → 渲染商品列表

### 验证

搜索 "耳机" 后截图确认：卡片内显示商品列表（3+ 条商品，含名称、价格、销量、好评率、发货信息），不再是空表单。

## 已验证通过的能力

- ✅ MCP 工具发现（tools/list 含 `_meta.ui`，17/26 工具）
- ✅ MCP 工具调用（catalog_search、catalog_product、cart_list）
- ✅ 卡片渲染（sandboxed iframe + srcDoc）
- ✅ postMessage 桥接（ui/initialize、tools/call、resources/read）
- ✅ ui/update-model-context（上下文暂存 → 注入下次 ui/message）
- ✅ ui/message（消息发送到对话）
- ✅ sendUserMessage 回调（conversation.send → session.prompt API）
- ✅ resources/read 回退路径（ui:// URI 获取）

## P2: readSessionId 未使用 structuredContent 路径

**日期**: 2026-08-20 · **状态**: 已修复 (2026-08-20)

### 问题描述

P1 修复后 `meta.lastToolResult.structuredContent` 已可用，但 `readSessionId` 仍仅从 `block.content` 文本解析 JSON 查找 `session_id`。当 content 文本不是纯 JSON（如含可读前缀），parse 失败 → `session_id` 注入失败 → 卡片内加购物车/结算等操作断掉。

### 修复方案

`readSessionId()` 优先从 `meta.lastToolResult.structuredContent.session_id` 读取，回退到 content 文本解析。

### 验证

React Fiber 检查确认 `meta.lastToolResult.structuredContent.session_id = "ucp-b2b.com-036fd44a-..."`，新路径可用。

## P3: CSP img-src 阻断外部商品图片

**日期**: 2026-08-20 · **状态**: 已修复 (2026-08-20)

### 问题描述

iframe CSP `img-src data: blob:` 仅允许 data/blob URI，阻断所有 CDN 外部商品图片。

### 修复方案

`buildCsp()` 默认 `img-src` 添加 `https:`：`img-src data: blob: https:`。

### 验证

运行时检查 iframe srcDoc CSP 确认 `img-src data: blob: https:`，外部图片放行。

## P4: ui/update-model-context 未实现（TODO 残留）

**日期**: 2026-08-20 · **状态**: 已修复 (2026-08-20)

### 问题描述

`ui/update-model-context` handler 仅 `console.debug` 后丢弃，上下文从未暂存或注入。

### 修复方案

1. 新增 `_stagedContext` Map，按 callId 暂存上下文文本
2. `ui/update-model-context` handler 写入 `_stagedContext.set(callId, text)`
3. `ui/message` handler 读取 `_stagedContext.get(callId)`，前置到消息文本前发送，发送后清除
4. 组件卸载时清理 `_stagedContext` 条目

### 验证

构建产物 `lib/client.js` 确认 `_stagedContext.set/get/delete` 均存在。

## 关键修复记录

### mimeTypes 声明（P0，已修复）

- **文件**: `src/index.ts` 第 503 行
- **修复前**: `{ 'io.modelcontextprotocol/ui': {} }` — UTP 服务器 0/26 工具返回 `_meta`
- **修复后**: `{ 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } }` — 17/26 工具返回 `_meta`
- **根因**: UTP 服务器 `supportsMCPApps()`（Go 源码 `server.go` 第 367-400 行）要求 `mimeTypes` 数组含 `"text/html;profile=mcp-app"`

### 新版卡片数据通道：ui/notifications/* 推送（P2，2026-09-07 修复）

- **症状**：直调注入（testctl tool --card）与会话回放的卡片只渲染空搜索表单，不渲染 lastToolResult 的商品列表。
- **根因**：新版 MCP Apps 卡片（UTP catalog v5+）的 `ui/initialize` 处理只读 `hostContext`（主题/安全区样式）和 `sessionId`，**bundle 里 `lastToolResult` 0 命中**——数据通道改为订阅两条推送通知：`ui/notifications/tool-input`（params `{name, arguments}`）与 `ui/notifications/tool-result`（params `{name, result: CallToolResult}`，卡片侧 `vo(e)=e?.result??e` 解包）。宿主只实现旧协议（握手响应带 lastToolResult），晚挂载的卡片（回放/注入会话）收不到任何数据，落在空 fallback 视图。UTP 侧佐证：cart 卡片走 `initialView='cart'` 制品方案正是为了绕开对通知的依赖（utp-skill-dev FINDINGS #828）。
- **修复**（`src/client/McpAppCard.tsx` `ui/initialize` handler）：应答握手后按 FIFO 顺序补发两条通知——`tool-input`（name 取 `block.call.name`，arguments 解析 `call.argsRaw`）+ `tool-result`（`{...lastToolResult, isError}`）。卡片在挂载时（子组件 effect 先于父组件 initialize effect）就已注册订阅，时序安全。旧协议字段 lastToolResult 保留，向后兼容。
- **验证**：utp-dev lane 实测——昨日注入的「儿童保温杯」会话（此前显示搜索表单）重新渲染出 20 商品完整列表；新注入「数据线」（服务端返回 0 商品）正确渲染空态「搜索『数据线』没有找到相关商品」，标题关键词证明 tool-input 通知生效；卡片内点击商品 → bridge tools/call 2758ms OK。截图 research/toolresult-notify-fix-card.png。
- **注意**：`structuredContent.surface_id`（新版结果多出的字段）与该问题无关，勿再误判为卡片行为变化。
