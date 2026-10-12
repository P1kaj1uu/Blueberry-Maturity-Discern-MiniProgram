const manifest = require('./model-manifest')
const { letterbox, rgbaToTensor, decode } = require('./yolo')
const { absoluteImagePath } = require('./assets')
const config = require('../config')

let queue = Promise.resolve()
let modelReady

function fsCall(method, options) {
  return new Promise((resolve, reject) => wx.getFileSystemManager()[method](Object.assign({}, options, {
    success: resolve, fail: reject
  })))
}

function modelPath() { return `${wx.env.USER_DATA_PATH}/blueberry-${manifest.md5}.onnx` }

async function validModel(path) {
  try {
    const info = await new Promise((resolve, reject) => wx.getFileInfo({
      filePath: path, digestAlgorithm: 'md5', success: resolve, fail: reject
    }))
    return info.size === manifest.size && info.digest === manifest.md5
  } catch (_) { return false }
}

async function assembleModel(report) {
  const path = modelPath()
  if (await validModel(path)) return path
  const partial = path + '.part'
  try {
    await fsCall('writeFile', { filePath: partial, data: new ArrayBuffer(0) })
    for (let i = 0; i < manifest.parts.length; i++) {
      const part = manifest.parts[i]
      report({ progress: Math.round(i / manifest.parts.length * 45), text: '首次使用，正在加载识别模型' })
      // Mini programs load cross-package modules through require.async;
      // explicit loadSubpackage is a Mini Game API, not a Mini Program API.
      let encoded
      try { encoded = await part.read() }
      catch (error) {
        console.error('Blueberry model subpackage failed', part.name, error)
        throw new Error('模型加载失败，请检查网络后重新预览或重试')
      }
      const buffer = wx.base64ToArrayBuffer(encoded)
      if (buffer.byteLength !== part.size) throw new Error('模型分包不完整，请重新预览小程序')
      await fsCall('appendFile', { filePath: partial, data: buffer })
    }
    if (!(await validModel(partial))) throw new Error('模型校验失败，请重新预览小程序')
    try { await fsCall('unlink', { filePath: path }) } catch (_) {}
    await fsCall('rename', { oldPath: partial, newPath: path })
    return path
  } catch (error) {
    try { await fsCall('unlink', { filePath: partial }) } catch (_) {}
    throw error
  }
}

function ensureModel(report) {
  if (!modelReady) {
    modelReady = assembleModel(report).catch(error => { modelReady = null; throw error })
  }
  return modelReady
}

function selectCanvas(page) {
  return new Promise((resolve, reject) => {
    page.createSelectorQuery().select('#inferenceCanvas').fields({ node: true }).exec(nodes => {
      if (!nodes[0] || !nodes[0].node) reject(new Error('照片画布尚未就绪，请重试'))
      else resolve(nodes[0].node)
    })
  })
}

async function preparePhoto(page, path, check) {
  const canvas = await selectCanvas(page)
  check()
  const image = canvas.createImage()
  await new Promise((resolve, reject) => {
    image.onload = resolve
    image.onerror = () => reject(new Error('照片读取失败，请重新选择'))
    image.src = absoluteImagePath(path)
  })
  check()
  const scale = Math.min(1, 1920 / Math.max(image.width, image.height))
  const width = Math.round(image.width * scale), height = Math.round(image.height * scale)
  if (!width || !height) throw new Error('照片尺寸无效，请重新选择')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  context.drawImage(image, 0, 0, width, height)
  // Export the decoded image so display and boxes use the same orientation and coordinates.
  const normalizedPath = await new Promise((resolve, reject) => wx.canvasToTempFilePath({
    canvas, fileType: 'jpg', quality: .95,
    success: response => resolve(response.tempFilePath), fail: reject
  }, page))
  check()
  const transform = letterbox(width, height)
  canvas.width = 640
  canvas.height = 640
  context.fillStyle = 'rgb(114,114,114)'
  context.fillRect(0, 0, 640, 640)
  context.drawImage(image, transform.left, transform.top, transform.resizedWidth, transform.resizedHeight)
  const tensor = rgbaToTensor(context.getImageData(0, 0, 640, 640).data)
  return { image: { width, height, path: normalizedPath }, transform, tensor }
}

function detectLocally(filePath, onProgress, page) {
  let canceled = false, rejectRequest, session, timer, stop
  const stopped = new Promise(resolve => { stop = resolve })
  const wait = work => Promise.race([work, stopped.then(() => { throw canceledError() })])
  const report = info => { if (!canceled && onProgress) onProgress(info) }
  const canceledError = () => new Error('已取消识别')
  const check = () => { if (canceled) throw canceledError() }
  const promise = new Promise((resolve, reject) => {
    rejectRequest = reject
    const run = async () => {
      try {
        timer = setTimeout(() => {
          canceled = true
          reject(new Error('识别用时较长，请检查网络或更新微信后重试。'))
          stop()
        }, config.timeout)
        check()
        const device = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()
        if (device.platform === 'devtools') throw new Error('本地识别需要在手机微信中运行，请点击开发者工具的「预览」扫码体验。')
        if (typeof wx.createInferenceSession !== 'function') throw new Error('当前微信不支持本地识别，请更新微信后重试。')
        report({ progress: 5, text: '正在准备照片' })
        const model = await wait(ensureModel(report))
        check()
        report({ progress: 50, text: '正在整理照片' })
        const photo = await wait(preparePhoto(page, filePath, check))
        check()
        report({ progress: 65, text: '正在准备识别' })
        session = wx.createInferenceSession({ model, precisionLevel: 4, allowNPU: false, allowQuantize: false })
        await wait(new Promise((loaded, failed) => {
          session.onLoad(loaded)
          session.onError(error => {
            console.error('Blueberry inference initialization failed', error)
            failed(new Error('这台手机暂时无法加载识别模型，请更新微信后重试。'))
          })
        }))
        check()
        report({ progress: 80, text: '正在逐颗识别蓝莓' })
        const inputs = {}
        inputs[manifest.input] = { type: 'float32', data: photo.tensor.buffer, shape: [1, 3, 640, 640] }
        const outputs = await wait(session.run(inputs))
        check()
        const result = decode(outputs[manifest.output], photo.transform, config.confidence)
        result.image = photo.image
        report({ progress: 100, text: '识别完成' })
        resolve(result)
      } catch (error) {
        reject(error instanceof Error ? error : new Error('本地识别失败，请重新选择照片再试。'))
      } finally {
        clearTimeout(timer)
        if (session) { try { session.destroy() } catch (_) {} }
      }
    }
    // Never run two inference sessions/canvas draws concurrently after a cancellation.
    queue = queue.then(run).catch(() => {})
  })
  return { promise, abort() { canceled = true; stop(); rejectRequest(canceledError()) } }
}

module.exports = { detectLocally }
