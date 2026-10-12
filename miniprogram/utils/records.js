const KEY = 'blueberry_records_v1'
const MAX_RECORDS = 30

function list() {
  try {
    const records = wx.getStorageSync(KEY)
    return Array.isArray(records) ? records : []
  } catch (_) { return [] }
}

function dateLabel(timestamp) {
  const d = new Date(timestamp)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function removeFile(filePath) {
  if (!filePath || filePath.indexOf(wx.env.USER_DATA_PATH + '/berry-') !== 0) return
  wx.getFileSystemManager().unlink({ filePath, fail() {} })
}

function add(result, sourcePath) {
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const filePath = `${wx.env.USER_DATA_PATH}/berry-${id}.jpg`
    wx.getFileSystemManager().copyFile({
      srcPath: sourcePath,
      destPath: filePath,
      success() {
        const record = { id, createdAt: Date.now(), imagePath: filePath, result }
        const previous = list()
        try {
          wx.setStorageSync(KEY, [record].concat(previous).slice(0, MAX_RECORDS))
          previous.slice(MAX_RECORDS - 1).forEach(item => removeFile(item.imagePath))
          resolve(record)
        } catch (_) {
          removeFile(filePath)
          reject(new Error('识别完成，但本地记录空间不足'))
        }
      },
      fail() { reject(new Error('识别完成，但照片未能存入记录')) }
    })
  })
}

function remove(id) {
  const previous = list()
  wx.setStorageSync(KEY, previous.filter(record => record.id !== id))
  previous.filter(record => record.id === id).forEach(record => removeFile(record.imagePath))
}

function clear() {
  const previous = list()
  wx.removeStorageSync(KEY)
  previous.forEach(record => removeFile(record.imagePath))
}

module.exports = { list, add, remove, clear, dateLabel }
