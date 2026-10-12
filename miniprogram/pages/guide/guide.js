Page({
  onShow() { if (this.getTabBar()) this.getTabBar().setData({ selected: 2 }) },
  startObservation() { wx.switchTab({ url: '/pages/index/index' }) }
})
