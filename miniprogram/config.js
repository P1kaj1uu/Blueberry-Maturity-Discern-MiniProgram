// 默认在手机本地运行模型，无需服务器、接口域名或云服务。
// server 模式仅用于电脑调试或已有服务的场景。
module.exports = {
  inferenceMode: 'local',
  apiBaseUrl: 'http://127.0.0.1:8000',
  confidence: 0.25,
  timeout: 120000,
  maxFileSize: 15 * 1024 * 1024
}
