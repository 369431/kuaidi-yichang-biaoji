# 内物不符异常标记 · payload

这是 `369431.inner-mismatch` 扩展包的程序载荷。它是一个独立的 Node.js 程序，
**不会**被 PackingProof 加载或执行；安装扩展后由用户双击 `start.cmd` 手动启动。

- 运行要求：Windows、Node.js 20+、PackingProof 0.0.63+
- 启动：双击 `start.cmd`，或 `node src\index.js`
- 面板：默认 http://127.0.0.1:8792/
- 完整说明见扩展包根目录的 `README.md`，或数据目录里的运行日志
- 数据目录：`%LOCALAPPDATA%\ExpressPackingMonitoring\extension-data\369431.inner-mismatch`
- 不读取、不写入 PackingProof 的数据库、配置和录像目录，只调用扩展 API v1
