# 待办与设计备忘

## 1. 异地访问（已暂缓，用户要求"先记着"）

目标：在家里 / 办公室外打开异常处理页，处理完再回到仓库。

已确认的约束与方案（真的要做时按这个来）：

- **不要裸奔公网**。面板里是单号、异常原因、处理备注，必须强制访问令牌；`panelBind: "any"`
  时自动生成令牌并写回 `settings.json`（代码里已有这一段的雏形）。
- **绑定**：Node 的 `createServer().listen(port, "::")` 在 Windows 上默认双栈，可同时接受 IPv4/IPv6；
  仅 IPv4 用 `0.0.0.0`。
- **域名**：`Host` 头必须是白名单里的域名或字面 IP。`payload/src/netguard.js` 的
  `createHostGuard({ extraHostnames, allowAnyAddress })` 已经实现，接入时把
  `panelAllowedHosts`（逗号分隔）传给 `extraHostnames` 即可。
  - 允许字面 IP 是为了 IPv6 直连；**域名必须显式列出**，否则 DNS rebinding 攻击可借网页读写面板。
- **TLS**：不要直接把 HTTP 暴露到公网。推荐走已有的 frp / 反代（Caddy、nginx）加证书，
  面板只监听回环，由反代终结 TLS 并转发。这样令牌不会以明文经过公网。
- **Windows 防火墙**：公网 profile 需要单独放行，`scripts/allow-firewall.cmd` 目前只加
  private/domain，做异地时再加 public（并明确提示风险）。
- **IPv6 现实问题**：国内宽带多数有公网 IPv6，但入站常被运营商或路由器防火墙拦截；
  且 IPv6 地址会变，通常要配 DDNS。这些都属于部署问题，不是代码问题。

## 2. 快捷键：两段式标记（本轮实现）

按 `F9` 进入标记模式（一声提示音，8 秒内有效）→ 按 `1`-`6` 选原因（两声确认）→ 写入水印。
`Esc` 取消，超时自动退出。也支持给单个原因直配组合键（`hotkeyBindings`，默认空）。

## 3. 还没做的功能候选

- 异常记录里存截图/附件（扩展不能写录像目录，只能存扩展自己的数据目录）。
- 按原因统计报表（现在只有状态计数与 CSV）。
- 多人协作：记录里区分「标记人 / 处理人」已有字段，但没有账号体系。
- 处理完成后回写给 ERP（需要 ERP 侧接口，不在扩展 API 范围内）。

## 4. 已完成

- 防火墙自动放行 + 开机自启已并入插件（`payload/src/firewall.js`、`payload/src/autostart.js`，
  面板上有状态与开关）；`scripts/` 下的同名脚本保留为手动兜底。
- 域名访问：`panelAllowedHosts` + 内网名（单段主机名、`*.local`/`*.lan`）已支持。
