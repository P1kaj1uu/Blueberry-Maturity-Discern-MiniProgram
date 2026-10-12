const config = require('../config')

function uploadImage(filePath, onProgress) {
  let task
  const promise = new Promise((resolve, reject) => {
    task = wx.uploadFile({
      url: config.apiBaseUrl.replace(/\/$/, '') + '/api/detect',
      filePath,
      name: 'file',
      formData: { confidence: String(config.confidence) },
      timeout: config.timeout,
      success(response) {
        let result
        try { result = JSON.parse(response.data) } catch (_) {
          reject(new Error('识别服务返回异常，请稍后再试'))
          return
        }
        if (response.statusCode !== 200) {
          reject(new Error(typeof result.detail === 'string' ? result.detail : '这张照片暂时无法识别，请换一张试试'))
          return
        }
        if (!result.image || !Array.isArray(result.detections) || !result.summary) {
          reject(new Error('识别结果不完整，请重新尝试'))
          return
        }
        resolve(result)
      },
      fail(error) {
        if (/abort/.test(error.errMsg || '')) reject(new Error('已取消识别'))
        else if (/timeout/.test(error.errMsg || '')) reject(new Error('识别用时较长，请稍后重试'))
        else reject(new Error('暂时连接不上识别服务，请稍后重试'))
      }
    })
    if (task.onProgressUpdate && onProgress) task.onProgressUpdate(onProgress)
  })
  return { promise, abort: () => task && task.abort() }
}

module.exports = { uploadImage }
