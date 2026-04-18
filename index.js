const fs   = require('fs')
const path = require('path')

module.exports = function (app) {
  const plugin = {
    id: 'signalk-rtsp-plugin',
    name: 'RTSP Stream Viewer',
    description: 'Displays an RTSP stream via HLS using signalk-container + ffmpeg',
  }

  plugin.schema = {
    type: 'object',
    required: ['rtspUrl'],
    properties: {
      rtspUrl: {
        type: 'string',
        title: 'RTSP Stream URL',
        default: 'rtsp://539:582@192.168.8.100:8554/ch1',
      },
      ffmpegImage: {
        type: 'string',
        title: 'FFmpeg Docker image',
        default: 'linuxserver/ffmpeg',
      },
      ffmpegTag: {
        type: 'string',
        title: 'FFmpeg Docker image tag',
        default: 'latest',
      },
    },
  }

  // HLS files are stored directly in the SignalK data volume so that the
  // FFmpeg container (which sees only the volume, not the plugin bind-mount)
  // can write to them.  They are served via a custom Express route below.
  function hlsDir () {
    return path.join(app.getDataDirPath(), 'rtsp-hls')
  }

  plugin.registerWithRouter = function (router) {
    router.get('/hls/:file', (req, res) => {
      const file = path.basename(req.params.file)   // prevent path traversal
      res.sendFile(path.join(hlsDir(), file))
    })
  }

  plugin.start = function (options) {
    asyncStart(options).catch(err => app.error(err.message))
  }

  async function asyncStart (options) {
    const rtspUrl = options.rtspUrl     || 'rtsp://539:582@192.168.8.100:8554/ch1'
    const image   = options.ffmpegImage || 'linuxserver/ffmpeg'
    const tag     = options.ffmpegTag   || 'latest'

    // Where the SignalK data dir will be mounted inside the FFmpeg container.
    const SK_MOUNT = '/signalk-data'

    // HLS output path as seen by SignalK (for mkdir) and inside FFmpeg.
    const hlsAbsPath      = hlsDir()
    const hlsInContainer  = path.join(SK_MOUNT, path.relative(app.getDataDirPath(), hlsAbsPath))

    fs.mkdirSync(hlsAbsPath, { recursive: true })

    app.debug('Waiting for signalk-container manager...')
    const mgr = await waitForManager()
    app.debug('Container manager ready, starting ffmpeg...')

    await mgr.ensureRunning('rtsp-to-hls', {
      image,
      tag,
      signalkDataMount: SK_MOUNT,
      restart: 'unless-stopped',
      command: [
        '-rtsp_transport', 'tcp',
        '-i', rtspUrl,
        '-c:v', 'copy',
        '-an',
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '3',
        '-hls_flags', 'delete_segments+append_list',
        '-hls_allow_cache', '0',
        path.join(hlsInContainer, 'stream.m3u8'),
      ],
    })

    app.debug('ffmpeg container started — HLS served at /signalk-rtsp-plugin/hls/')
  }

  async function waitForManager (timeout = 30000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const mgr = globalThis.__signalk_containerManager
      if (mgr?.getRuntime()) return mgr
      await new Promise(r => setTimeout(r, 1000))
    }
    throw new Error('signalk-container unavailable after 30s — is the plugin installed and enabled?')
  }

  plugin.stop = function () {
    const mgr = globalThis.__signalk_containerManager
    if (mgr) mgr.stop('rtsp-to-hls').catch(() => {})
  }

  return plugin
}
