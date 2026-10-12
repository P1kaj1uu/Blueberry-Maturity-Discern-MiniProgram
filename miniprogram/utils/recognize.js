const config = require('../config')
const { uploadImage } = require('./api')
const { detectLocally } = require('./local-inference')

function recognizeImage(path, onProgress, page) {
  if (config.inferenceMode === 'server') return uploadImage(path, onProgress)
  return detectLocally(path, onProgress, page)
}

module.exports = { recognizeImage }
