Component({
  data: {
    selected: 0,
    tabs: [
      { path: '/pages/index/index', label: '识别', icon: 'scan' },
      { path: '/pages/records/records', label: '记录', icon: 'record' },
      { path: '/pages/guide/guide', label: '拍摄指南', icon: 'book' }
    ]
  },
  methods: {
    switchTab(event) {
      const index = Number(event.currentTarget.dataset.index)
      if (index === this.data.selected) return
      wx.switchTab({ url: this.data.tabs[index].path })
    }
  }
})
