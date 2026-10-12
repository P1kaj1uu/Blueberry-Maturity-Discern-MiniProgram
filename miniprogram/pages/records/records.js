const records = require('../../utils/records')
Page({
  data: { records: [], total: 0, ratio: 0 },
  onShow() {
    if (this.getTabBar()) this.getTabBar().setData({ selected: 1 })
    this.refresh()
  },
  refresh() {
    const list = records.list().map(record => Object.assign({}, record, { dateLabel: records.dateLabel(record.createdAt) }))
    const total = list.reduce((sum, record) => sum + record.result.summary.total, 0)
    const mature = list.reduce((sum, record) => sum + record.result.summary.mature, 0)
    this.setData({ records: list, total, ratio: total ? Math.round(mature / total * 1000) / 10 : 0 })
  },
  openRecord(event) {
    const record = this.data.records.find(item => item.id === event.currentTarget.dataset.id)
    if (!record) return
    getApp().globalData.resultToOpen = record
    wx.switchTab({ url: '/pages/index/index' })
  },
  deleteRecord(event) {
    const id = event.currentTarget.dataset.id
    wx.showModal({ title: '删除这次观察？', content: '这张照片和识别结果将从本机记录中移除。', confirmText: '删除', confirmColor: '#9c654a', success: response => {
      if (!response.confirm) return
      try { records.remove(id); this.refresh() } catch (_) { wx.showToast({ title: '删除失败，请重试', icon: 'none' }) }
    } })
  },
  clearRecords() {
    wx.showModal({ title: '清空识别记录？', content: '本机保存的全部照片和结果将被删除。', confirmText: '清空', confirmColor: '#9c654a', success: response => {
      if (!response.confirm) return
      try { records.clear(); this.refresh() } catch (_) { wx.showToast({ title: '清空失败，请重试', icon: 'none' }) }
    } })
  },
  startObservation() { wx.switchTab({ url: '/pages/index/index' }) }
})
