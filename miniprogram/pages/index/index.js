const { recognizeImage } = require('../../utils/recognize')
const { absoluteImagePath, sampleImage } = require('../../utils/assets')
const records = require('../../utils/records')
const { boxesForView } = require('../../utils/detection')
const config = require('../../config')

Page({
  data: {
    stage: 'home', imagePath: '', imageHeight: 480, result: null,
    boxes: [], filter: 'all', showBoxes: true, selectedId: null,
    recent: null, progress: 0, loadingText: '正在准备照片', error: '', saving: false
  },
  onShow() {
    if (this.getTabBar()) this.getTabBar().setData({ selected: 0 })
    this.refreshRecent()
    const record = getApp().globalData.resultToOpen
    if (record) {
      getApp().globalData.resultToOpen = null
      this.showResult(record.result, record.imagePath)
    }
  },
  onHide() { this.cancelRequest() },
  onUnload() { this.cancelRequest() },
  refreshRecent() {
    const recent = records.list()[0]
    this.setData({ recent: recent ? Object.assign({}, recent, { dateLabel: records.dateLabel(recent.createdAt) }) : null })
  },
  chooseCamera() { this.chooseImage('camera') },
  chooseAlbum() { this.chooseImage('album') },
  chooseImage(source) {
    if (this.data.stage === 'loading') return
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: [source], sizeType: ['compressed'], camera: 'back',
      success: response => {
        const file = response.tempFiles[0]
        if (file.size > config.maxFileSize) {
          wx.showToast({ title: '请选择小于 15MB 的照片', icon: 'none' })
          return
        }
        this.startDetection(file.tempFilePath)
      },
      fail: error => {
        if (/cancel/.test(error.errMsg || '')) return
        wx.showModal({
          title: source === 'camera' ? '暂时无法打开相机' : '暂时无法打开相册',
          content: '请在微信设置中允许访问相机或照片，再回来试试。',
          confirmText: '打开设置',
          success: response => { if (response.confirm) wx.openSetting({}) }
        })
      }
    })
  },
  async useSample() {
    if (this.data.stage === 'loading') return
    try { this.startDetection(await sampleImage()) }
    catch (_) { wx.showToast({ title: '示例照片加载失败，请重新预览', icon: 'none' }) }
  },
  async startDetection(imagePath) {
    imagePath = absoluteImagePath(imagePath)
    this.cancelRequest()
    const generation = this._generation
    this.setData({ stage: 'loading', imagePath, result: null, boxes: [], progress: 0, loadingText: '正在准备照片', error: '', selectedId: null })
    wx.pageScrollTo({ scrollTop: 0, duration: 200 })
    this._request = recognizeImage(imagePath, info => {
      if (generation !== this._generation) return
      this.setData({ progress: info.progress, loadingText: info.text || (info.progress >= 100 ? '正在逐颗识别蓝莓' : '正在上传照片') })
    }, this)
    try {
      const result = await this._request.promise
      if (generation !== this._generation) return
      let normalizedPath = result.image.path || imagePath
      if (result.image.base64) {
        normalizedPath = `${wx.env.USER_DATA_PATH}/current-blueberry.jpg`
        await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({
          filePath: normalizedPath, data: result.image.base64, encoding: 'base64', success: resolve, fail: reject
        }))
      }
      if (generation !== this._generation) return
      delete result.image.base64
      delete result.image.path
      this.showResult(result, normalizedPath)
      try {
        await records.add(result, normalizedPath)
        if (generation === this._generation) this.refreshRecent()
      } catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
    } catch (error) {
      if (generation !== this._generation) return
      this.setData({ stage: 'error', error: error.message || '照片处理失败，请重新尝试' })
    } finally {
      if (generation === this._generation) this._request = null
    }
  },
  cancelRequest() {
    this._generation = (this._generation || 0) + 1
    if (this._request) { this._request.abort(); this._request = null }
    if (this.data.stage === 'loading') this.setData({ stage: 'home' })
  },
  showResult(result, imagePath) {
    const ratio = result.image.height / result.image.width
    this.setData({
      stage: 'result', imagePath, result, imageHeight: 670 * ratio,
      boxes: boxesForView(result, 'all'), filter: 'all', showBoxes: true, selectedId: null
    })
    wx.pageScrollTo({ scrollTop: 0, duration: 200 })
  },
  setFilter(event) {
    const filter = event.currentTarget.dataset.filter
    this.setData({ filter, selectedId: null, boxes: boxesForView(this.data.result, filter) })
  },
  toggleBoxes() { this.setData({ showBoxes: !this.data.showBoxes, selectedId: null }) },
  selectBerry(event) {
    const id = Number(event.currentTarget.dataset.id)
    this.setData({ selectedId: this.data.selectedId === id ? null : id })
  },
  previewImage() { wx.previewImage({ current: this.data.imagePath, urls: [this.data.imagePath] }) },
  reset() {
    this.cancelRequest()
    this.setData({ stage: 'home', result: null, boxes: [], error: '', selectedId: null })
    this.refreshRecent()
    wx.pageScrollTo({ scrollTop: 0, duration: 200 })
  },
  retry() { this.startDetection(this.data.imagePath) },
  openRecent() {
    if (this.data.recent) this.showResult(this.data.recent.result, this.data.recent.imagePath)
  },
  openRecords() { wx.switchTab({ url: '/pages/records/records' }) },
  openGuide() { wx.switchTab({ url: '/pages/guide/guide' }) },
  async saveImage() {
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      const filePath = await this.renderAnnotatedImage()
      await new Promise((resolve, reject) => wx.saveImageToPhotosAlbum({ filePath, success: resolve, fail: reject }))
      wx.showToast({ title: '标注图已保存', icon: 'success' })
    } catch (error) {
      if (/auth|authorize|deny/.test(error.errMsg || '')) {
        wx.showModal({ title: '允许保存到相册', content: '开启相册权限后，就可以保存这张标注图。', confirmText: '打开设置', success: r => { if (r.confirm) wx.openSetting({}) } })
      } else if (!/cancel/.test(error.errMsg || '')) {
        wx.showToast({ title: '保存失败，请再试一次', icon: 'none' })
      }
    } finally { this.setData({ saving: false }) }
  },
  renderAnnotatedImage() {
    return new Promise((resolve, reject) => {
      this.createSelectorQuery().select('#exportCanvas').fields({ node: true, size: true }).exec(nodes => {
        if (!nodes[0]) { reject(new Error('画布未就绪')); return }
        const canvas = nodes[0].node
        const context = canvas.getContext('2d')
        const result = this.data.result
        const scale = Math.min(1, 1800 / Math.max(result.image.width, result.image.height))
        const width = Math.round(result.image.width * scale)
        const height = Math.round(result.image.height * scale)
        const footer = Math.max(90, Math.round(width * .12))
        canvas.width = width
        canvas.height = height + footer
        const image = canvas.createImage()
        image.onerror = reject
        image.onload = () => {
          context.fillStyle = '#f7f7f2'
          context.fillRect(0, 0, width, height + footer)
          context.drawImage(image, 0, 0, width, height)
          const fontSize = Math.max(14, Math.round(width / 45))
          context.font = `${fontSize}px sans-serif`
          context.lineWidth = Math.max(2, width / 400)
          result.detections.forEach(item => {
            const [x1, y1, x2, y2] = item.box.map(n => n * scale)
            const color = item.status === 'mature' ? '#477cb6' : '#c29b52'
            const label = `${item.id} ${item.label}`
            const textWidth = context.measureText(label).width + 12
            const labelHeight = fontSize + 10
            const labelX = Math.max(0, Math.min(x1, width - textWidth))
            const labelY = Math.max(0, y1 - labelHeight)
            context.strokeStyle = color
            context.strokeRect(x1, y1, x2 - x1, y2 - y1)
            context.fillStyle = color
            context.fillRect(labelX, labelY, textWidth, labelHeight)
            context.fillStyle = '#fff'
            context.fillText(label, labelX + 6, labelY + fontSize + 1)
          })
          const footerFont = Math.max(16, Math.round(width / 40))
          context.fillStyle = '#244e3e'
          context.font = `bold ${footerFont}px sans-serif`
          context.fillText('蓝莓成熟度识别', 20, height + footer * .38)
          context.font = `${footerFont * .85}px sans-serif`
          const s = result.summary
          context.fillText(`共 ${s.total} 颗   成熟 ${s.mature} 颗   未成熟 ${s.immature} 颗   成熟占比 ${s.mature_ratio}%`, 20, height + footer * .75)
          wx.canvasToTempFilePath({ canvas, fileType: 'jpg', quality: .95, success: response => resolve(response.tempFilePath), fail: reject }, this)
        }
        image.src = this.data.imagePath
      })
    })
  },
  onShareAppMessage() { return { title: '今天的蓝莓，成熟了吗？', path: '/pages/index/index', imageUrl: '/assets/blueberries.jpg' } }
})
