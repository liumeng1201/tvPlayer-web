/* ==========================================================
 * Web TV Player — 儿童视频
 * Static SPA · Android tvPlayer2 风格
 * ==========================================================
 *
 * 注意：如果后端服务器没有启用 CORS，浏览器会因跨域限制
 * 无法加载数据。请确保后端在响应中包含以下头：
 *   Access-Control-Allow-Origin: *
 * 或者将本页面部署在与后端同源的静态服务器上。
 *
 * 默认后端地址: http://192.168.1.248
 * 修改下方 CONFIG.SERVER_URL 即可。
 * ========================================================== */

;(function () {
  'use strict'

  // ==========================================================
  //   CONFIG
  // ==========================================================
  const CONFIG = {
    SERVER_URL: 'http://192.168.1.248',
    VERSION_NAME: '3.0',
    VERSION_CODE: 301,
    PLAY_TIME_LIMIT_MS: 15 * 60 * 1000,   // 15 分钟
    COOLDOWN_MS: 2 * 60 * 60 * 1000,       // 2 小时
    SEEK_STEP: 5,                           // 快进/快退秒数
    AUTO_HIDE_DELAY: 5000,                  // 控制栏自动隐藏（毫秒）
    PROGRESS_SAVE_INTERVAL: 5000,           // 进度保存间隔
    MAX_RESTART_HINT_COUNT: 10,             // 续播提示最大显示次数
    RESTART_HINT_DURATION: 5000,            // 续播提示显示时长
    SEEK_INDICATOR_DURATION: 800,           // 快进/快退指示器显示时长
  }

  // ==========================================================
  //   DOM REFS
  // ==========================================================
  const $ = (id) => document.getElementById(id)

  // ==========================================================
  //   STATE
  // ==========================================================
  const state = {
    // Browser
    currentPath: '/',
    pathStack: [],
    files: [],
    loading: false,
    error: null,
    scrollPositions: {},

    // Player
    videoList: [],
    currentIndex: 0,
    playerPath: '',
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    hasPendingRestart: false,
    restartHintCount: 0,

    // Image
    imageUrl: '',
    imageName: '',

    // Settings
    playMode: 0, // 0=列表循环, 1=单集循环

    // Parental
    accumulatedMs: 0,
    cooldownUntil: 0,
    pendingCooldownExit: false,
  }

  // ==========================================================
  //   STORAGE (localStorage 持久化)
  // ==========================================================
  const storage = {
    _prefix: 'tv_',

    get (key, def) {
      try {
        const v = localStorage.getItem(this._prefix + key)
        return v !== null ? JSON.parse(v) : def
      } catch { return def }
    },

    set (key, val) {
      try { localStorage.setItem(this._prefix + key, JSON.stringify(val)) }
      catch { /* quota exceeded — ignore */ }
    },

    remove (key) {
      try { localStorage.removeItem(this._prefix + key) }
      catch { /* ignore */ }
    },

    // --- specific helpers ---

    saveProgress (videoUrl, positionMs, durationMs) {
      const all = this.get('progress', {})
      all[videoUrl] = { positionMs, durationMs, lastUpdated: Date.now() }
      this.set('progress', all)
    },

    getProgress (videoUrl) {
      const all = this.get('progress', {})
      return all[videoUrl] || null
    },

    deleteProgress (videoUrl) {
      const all = this.get('progress', {})
      delete all[videoUrl]
      this.set('progress', all)
    },

    saveScrollPos (path, scrollTop) {
      const all = this.get('scroll_pos', {})
      all[path] = scrollTop
      this.set('scroll_pos', all)
    },

    getScrollPos (path) {
      const all = this.get('scroll_pos', {})
      return all[path] || 0
    },

    getPlayMode () {
      return this.get('play_mode', 0)
    },

    setPlayMode (mode) {
      this.set('play_mode', mode)
    },

    getAccumulatedMs () {
      return this.get('accumulated_ms', 0)
    },

    setAccumulatedMs (ms) {
      this.set('accumulated_ms', ms)
    },

    getCooldownUntil () {
      return this.get('cooldown_until', 0)
    },

    setCooldownUntil (ts) {
      this.set('cooldown_until', ts)
    },

    getRestartHintCount () {
      return this.get('restart_hint_count', 0)
    },

    setRestartHintCount (n) {
      this.set('restart_hint_count', n)
    },
  }

  // ==========================================================
  //   PARENTAL CONTROL
  // ==========================================================
  const parental = {
    init () {
      state.accumulatedMs = storage.getAccumulatedMs()
      state.cooldownUntil = storage.getCooldownUntil()
      state.restartHintCount = storage.getRestartHintCount()
    },

    isInCooldown () {
      if (state.cooldownUntil === 0) return false
      if (Date.now() >= state.cooldownUntil) {
        // Cooldown expired
        state.cooldownUntil = 0
        state.accumulatedMs = 0
        storage.setCooldownUntil(0)
        storage.setAccumulatedMs(0)
        return false
      }
      return true
    },

    getRemainingCooldown () {
      if (!this.isInCooldown()) return null
      const remaining = state.cooldownUntil - Date.now()
      const hours = Math.floor(remaining / 3600000)
      const minutes = Math.floor((remaining % 3600000) / 60000)
      return { hours, minutes, remaining }
    },

    addPlayTime (ms) {
      if (this.isInCooldown()) return
      state.accumulatedMs += ms
      storage.setAccumulatedMs(state.accumulatedMs)

      if (state.accumulatedMs >= CONFIG.PLAY_TIME_LIMIT_MS) {
        // Time limit reached — mark for cooldown on next video end
        state.pendingCooldownExit = true
      }
    },

    startCooldown () {
      state.cooldownUntil = Date.now() + CONFIG.COOLDOWN_MS
      state.accumulatedMs = 0
      state.pendingCooldownExit = false
      storage.setCooldownUntil(state.cooldownUntil)
      storage.setAccumulatedMs(0)
    },

    showCooldownModal () {
      const info = this.getRemainingCooldown()
      if (!info) return
      const msg = info.hours > 0
        ? `休息时间还没结束，请${info.hours}小时${info.minutes}分钟之后再回来~`
        : `休息时间还没结束，请${info.minutes}分钟之后再回来~`
      $('cooldown-msg').textContent = msg
      $('cooldown-modal').classList.remove('hidden')
    },
  }

  // ==========================================================
  //   API LAYER
  // ==========================================================
  const api = {
    _server: CONFIG.SERVER_URL,

    buildFilesUrl (path) {
      if (!path || path === '/') return `${this._server}/files.json`
      return `${this._server}${path}files.json`
    },

    buildMediaUrl (path, fileName) {
      if (!path) path = '/'
      if (!path.endsWith('/')) path += '/'
      const base = path === '/' ? `${this._server}/` : `${this._server}${path}`
      return base + fileName
    },

    async fetchFiles (path) {
      const url = this.buildFilesUrl(path)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },

    async fetchUpdateInfo () {
      const url = `${this._server}/update.json`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
  }

  // ==========================================================
  //   ROUTER
  // ==========================================================
  const router = {
    currentScreen: null,

    init () {
      window.addEventListener('hashchange', () => this.onHashChange())
      // Initial route
      if (!window.location.hash || window.location.hash === '#') {
        window.location.hash = '#browser'
      } else {
        this.onHashChange()
      }
    },

    onHashChange () {
      const hash = window.location.hash.slice(1) || 'browser'
      const screen = hash.split('?')[0]

      switch (screen) {
        case 'browser':
          this.show('browser')
          browser.render()
          break
        case 'player':
          if (state.videoList.length === 0) {
            this.show('browser')
            browser.render()
            return
          }
          this.show('player')
          player.render()
          break
        case 'image':
          if (!state.imageUrl) {
            this.show('browser')
            browser.render()
            return
          }
          this.show('image')
          imageView.render()
          break
        case 'settings':
          this.show('settings')
          settings.render()
          break
        default:
          this.show('browser')
          browser.render()
      }
    },

    show (screen) {
      // Hide all
      document.querySelectorAll('.screen').forEach(el => {
        el.classList.remove('active')
      })
      // Clean up previous screen
      if (this.currentScreen === 'player') {
        player.destroy()
      }
      // Show target
      const el = $(`screen-${screen}`)
      if (el) el.classList.add('active')
      this.currentScreen = screen
    },

    navigate (screen, replace) {
      if (replace) {
        window.location.replace(`#${screen}`)
      } else {
        window.location.hash = `#${screen}`
      }
    },
  }

  // ==========================================================
  //   BROWSER SCREEN
  // ==========================================================
  const browser = {
    // Store current scroll before navigating into a subdirectory
    _scrollSaver: null,

    render () {
      const body = $('browser-body')

      // Update title
      $('browser-title').textContent = state.currentPath === '/'
        ? '儿童视频' : state.currentPath.split('/').filter(Boolean).pop()

      // Back button: visible only when in a subdirectory
      $('btn-browser-back').classList.toggle('hidden', state.currentPath === '/')

      // Settings button: visible only at root
      $('btn-settings').classList.toggle('hidden', state.currentPath !== '/')

      // Loading state
      if (state.loading) {
        body.innerHTML =
          '<div class="browser-msg">' +
          '<div class="spinner-inline" style="width:40px;height:40px;border:4px solid rgba(255,255,255,0.15);border-top-color:#ffaa3f;border-radius:50%;animation:spin .8s linear infinite;"></div>' +
          '<div class="browser-msg-text">加载中...</div>' +
          '</div>'
        return
      }

      // Error state
      if (state.error) {
        body.innerHTML =
          '<div class="browser-msg">' +
          '<div class="browser-msg-icon">😵</div>' +
          '<div class="browser-msg-text" style="color:var(--text-secondary);">' + escapeHtml(state.error) + '</div>' +
          '<button class="btn-retry" id="btn-retry-files">再试一次</button>' +
          '</div>'
        document.getElementById('btn-retry-files')?.addEventListener('click', () => {
          browser.loadFiles(state.currentPath)
        })
        return
      }

      // Empty state
      if (!state.files || state.files.length === 0) {
        body.innerHTML =
          '<div class="browser-msg">' +
          '<div class="browser-msg-icon">🎈</div>' +
          '<div class="browser-msg-text">这里空空的，还没有内容哦</div>' +
          '</div>'
        return
      }

      // Cooldown notice (at top of grid)
      let cooldownHtml = ''
      if (parental.isInCooldown()) {
        const info = parental.getRemainingCooldown()
        const msg = info && info.hours > 0
          ? `休息时间还剩 ${info.hours} 小时 ${info.minutes} 分钟`
          : info ? `休息时间还剩 ${info.minutes} 分钟` : ''
        cooldownHtml = `<div class="cooldown-notice">😴 ${msg}</div>`
      }

      // Render grid
      let itemsHtml = state.files.map((item, idx) => {
        const coverSrc = item.cover
          ? api.buildMediaUrl(state.currentPath, item.cover)
          : placeholderSvg(item.type)

        return '<div class="grid-item" data-index="' + idx + '" tabindex="0" role="button">' +
          '<div class="grid-item-cover-wrap">' +
          '<img class="grid-item-cover" src="' + coverSrc + '" alt="" loading="lazy" onerror="this.src=\'' + placeholderSvg(item.type) + '\'">' +
          '</div>' +
          '<div class="grid-item-name">' + escapeHtml(item.name) + '</div>' +
          '</div>'
      }).join('')

      body.innerHTML = cooldownHtml + '<div class="file-grid">' + itemsHtml + '</div>'

      // Bind grid item clicks
      body.querySelectorAll('.grid-item').forEach((el, idx) => {
        el.addEventListener('click', () => {
          browser.onItemClick(state.files[idx])
        })
        // Keyboard enter/space
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            browser.onItemClick(state.files[idx])
          }
        })
        // Touch feedback (focus class)
        el.addEventListener('touchstart', () => el.classList.add('focused'), { passive: true })
        el.addEventListener('touchend', () => el.classList.remove('focused'), { passive: true })
      })

      // Restore scroll position
      const scrollContainer = body
      requestAnimationFrame(() => {
        const saved = storage.getScrollPos(state.currentPath)
        if (saved > 0) {
          scrollContainer.scrollTop = saved
        }
      })
    },

    async loadFiles (path) {
      state.currentPath = path
      state.loading = true
      state.error = null
      state.files = []
      this.render()

      try {
        const data = await api.fetchFiles(path)
        state.files = Array.isArray(data) ? data : []
        state.loading = false
        this.render()
      } catch (err) {
        state.loading = false
        state.error = '加载失败: ' + (err.message || '网络错误')
        this.render()
      }
    },

    navigateToDir (name) {
      // Save current scroll
      const body = $('browser-body')
      storage.saveScrollPos(state.currentPath, body.scrollTop)

      state.pathStack.push(state.currentPath)
      const newPath = state.currentPath + name + '/'
      this.loadFiles(newPath)
    },

    navigateUp () {
      if (state.pathStack.length > 0) {
        // Save current scroll
        const body = $('browser-body')
        storage.saveScrollPos(state.currentPath, body.scrollTop)

        const prevPath = state.pathStack.pop()
        this.loadFiles(prevPath)
        return true
      }
      return false
    },

    onItemClick (item) {
      if (item.type === 0) {
        // Directory
        this.navigateToDir(item.name)
      } else if (item.type === 1) {
        // Video — build playlist
        const videos = state.files.filter(f => f.type === 1)
        if (videos.length === 0) return

        // Check cooldown
        if (parental.isInCooldown()) {
          parental.showCooldownModal()
          return
        }

        const idx = videos.indexOf(item)
        state.videoList = videos.map(v => ({
          name: v.name,
          url: api.buildMediaUrl(state.currentPath, v.url),
          cover: v.cover,
        }))
        state.currentIndex = idx >= 0 ? idx : 0
        state.playerPath = state.currentPath
        router.navigate('player')
      } else if (item.type === 2) {
        // Image
        state.imageName = item.name
        state.imageUrl = api.buildMediaUrl(state.currentPath, item.url)
        router.navigate('image')
      }
    },

    goToSettings () {
      router.navigate('settings')
    },
  }

  // ==========================================================
  //   PLAYER SCREEN
  // ==========================================================
  const player = {
    _video: null,
    _autoHideTimer: null,
    _progressTimer: null,
    _saveTimer: null,
    _resumeHintTimer: null,
    _seekIndicatorTimer: null,
    _isSeeking: false,

    render () {
      this._video = $('player-video')
      const videoInfo = state.videoList[state.currentIndex]
      if (!videoInfo) {
        router.navigate('browser')
        return
      }

      // Reset
      this._clearTimers()
      state.isPlaying = false
      state.hasPendingRestart = false
      state.currentTime = 0
      state.duration = 0

      // Set title
      $('player-title-text').textContent = videoInfo.name

      // Hide overlays
      $('player-title-bar').classList.add('hidden')
      $('player-bottom').classList.add('hidden')
      $('seek-indicator').classList.remove('show')
      $('seek-indicator').classList.add('hidden')
      $('resume-hint').classList.remove('show')
      $('resume-hint').classList.add('hidden')
      $('buffering-overlay').classList.remove('hidden')

      // Set video source
      this._video.src = videoInfo.url
      this._video.load()

      // Show bottom controls briefly
      this._showBottom()

      // Attach video events
      this._attachEvents()

      // Reset resume check flag so it runs on canplay
      this._resumeChecked = false

      // Try to play (Safari may require user gesture)
      const playPromise = this._video.play()
      if (playPromise !== undefined) {
        playPromise.catch(() => {
          // Autoplay blocked — user needs to tap
          $('buffering-overlay').classList.add('hidden')
          // Show controls so user knows to tap
          this._showBottom()
          $('player-title-bar').classList.remove('hidden')
        })
      }
    },

    _attachEvents () {
      const v = this._video
      if (!v) return

      // Remove old listeners by replacing with new (clean approach: use one handler)
      v._handlers && v._handlers.forEach(({ evt, fn }) => v.removeEventListener(evt, fn))

      const handlers = [
        { evt: 'play', fn: () => this._onPlay() },
        { evt: 'pause', fn: () => this._onPause() },
        { evt: 'ended', fn: () => this._onEnded() },
        { evt: 'waiting', fn: () => this._onWaiting() },
        { evt: 'canplay', fn: () => this._onCanPlay() },
        { evt: 'error', fn: () => this._onError() },
        { evt: 'timeupdate', fn: () => this._onTimeUpdate() },
        { evt: 'progress', fn: () => this._onBufferProgress() },
      ]

      handlers.forEach(({ evt, fn }) => v.addEventListener(evt, fn))
      v._handlers = handlers
    },

    _onPlay () {
      state.isPlaying = true
      $('buffering-overlay').classList.add('hidden')
      // 播放中 → 显示暂停图标（点击可暂停）
      $('play-icon').classList.add('hidden')
      $('pause-icon').classList.remove('hidden')
      this._scheduleAutoHide()
      this._startProgressSaving()
    },

    _onPause () {
      state.isPlaying = false
      // 暂停中 → 显示播放图标（点击可播放）
      $('play-icon').classList.remove('hidden')
      $('pause-icon').classList.add('hidden')
      this._cancelAutoHide()
      this._showBottom()
      $('player-title-bar').classList.remove('hidden')
      this._stopProgressSaving()
    },

    _onEnded () {
      state.isPlaying = false
      this._cancelAutoHide()
      this._stopProgressSaving()
      $('buffering-overlay').classList.add('hidden')

      // Delete progress for finished video
      const videoInfo = state.videoList[state.currentIndex]
      if (videoInfo) {
        storage.deleteProgress(videoInfo.url)
      }

      // Check cooldown
      if (state.pendingCooldownExit) {
        parental.startCooldown()
        state.pendingCooldownExit = false
        router.navigate('browser')
        return
      }

      // Play mode
      if (state.playMode === 0) {
        // List loop
        const next = (state.currentIndex + 1) % state.videoList.length
        if (next === 0 && state.videoList.length > 1) {
          // Wrapped around — still play
        }
        state.currentIndex = next
        this.render()
      } else {
        // Single loop
        this._video.currentTime = 0
        this._video.play().catch(() => {})
      }
    },

    _onWaiting () {
      $('buffering-overlay').classList.remove('hidden')
    },

    _onCanPlay () {
      $('buffering-overlay').classList.add('hidden')
      // Check resume once video is actually ready to play
      if (!this._resumeChecked) {
        this._resumeChecked = true
        this._checkResume()
      }
    },

    _onError () {
      $('buffering-overlay').classList.add('hidden')
      $('player-bottom').classList.remove('hidden')
      $('player-title-bar').classList.remove('hidden')
      // Reset resume flag so retry can re-check
      this._resumeChecked = false
    },

    _onTimeUpdate () {
      if (this._isSeeking) return
      state.currentTime = this._video.currentTime
      state.duration = this._video.duration || 0
      this._updateProgressUI()
    },

    _onBufferProgress () {
      const v = this._video
      if (!v || !v.buffered || !v.buffered.length) return
      if (v.duration > 0) {
        const end = v.buffered.end(v.buffered.length - 1)
        const pct = Math.min((end / v.duration) * 100, 100)
        // Update buffering text
        const bufText = $('buffering-overlay').querySelector('.buffering-text')
        if (bufText && pct < 100) {
          bufText.textContent = '加载中 ' + Math.round(pct) + '%...'
        }
      }
    },

    _updateProgressUI () {
      const pct = state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0
      $('progress-fill').style.width = pct + '%'
      $('progress-thumb').style.left = pct + '%'
      $('time-current').textContent = this._formatTime(state.currentTime)
      $('time-total').textContent = this._formatTime(state.duration)
    },

    _formatTime (s) {
      if (!s || !isFinite(s)) return '0:00'
      const m = Math.floor(s / 60)
      const sec = Math.floor(s % 60)
      return m + ':' + (sec < 10 ? '0' : '') + sec
    },

    // --- Controls ---

    _showBottom () {
      $('player-bottom').classList.remove('hidden')
      $('player-title-bar').classList.remove('hidden')
    },

    _scheduleAutoHide () {
      this._cancelAutoHide()
      this._autoHideTimer = setTimeout(() => {
        if (state.isPlaying) {
          $('player-bottom').classList.add('hidden')
          $('player-title-bar').classList.add('hidden')
        }
      }, CONFIG.AUTO_HIDE_DELAY)
    },

    _cancelAutoHide () {
      if (this._autoHideTimer) {
        clearTimeout(this._autoHideTimer)
        this._autoHideTimer = null
      }
    },

    _startProgressSaving () {
      this._stopProgressSaving()
      // Save every 5 seconds
      this._saveTimer = setInterval(() => {
        const v = this._video
        if (!v || !state.isPlaying) return
        const pos = v.currentTime * 1000
        const dur = (v.duration || 0) * 1000
        if (dur - pos > 10000) {
          const videoInfo = state.videoList[state.currentIndex]
          if (videoInfo) {
            storage.saveProgress(videoInfo.url, pos, dur)
          }
        }
        // Parental time tracking
        parental.addPlayTime(5000)
      }, CONFIG.PROGRESS_SAVE_INTERVAL)
    },

    _stopProgressSaving () {
      if (this._saveTimer) {
        clearInterval(this._saveTimer)
        this._saveTimer = null
      }
    },

    _checkResume () {
      const videoInfo = state.videoList[state.currentIndex]
      if (!videoInfo) return

      const progress = storage.getProgress(videoInfo.url)
      if (!progress) return

      const remaining = progress.durationMs - progress.positionMs
      if (progress.positionMs <= 0 || progress.durationMs <= 0 || remaining <= 10000) {
        storage.deleteProgress(videoInfo.url)
        return
      }

      // Check hint count
      state.restartHintCount = storage.getRestartHintCount()
      if (state.restartHintCount >= CONFIG.MAX_RESTART_HINT_COUNT) {
        // Silently seek (video is ready since this runs on canplay)
        this._video.currentTime = progress.positionMs / 1000
        return
      }

      // Seek to saved position (video is ready at this point)
      this._video.currentTime = progress.positionMs / 1000

      // Show resume hint
      state.hasPendingRestart = true
      const remainingSec = Math.round(remaining / 1000)
      const remainingMin = Math.floor(remainingSec / 60)
      const remainingS = remainingSec % 60
      const remainingStr = remainingMin > 0
        ? remainingMin + '分' + remainingS + '秒'
        : remainingS + '秒'
      $('resume-hint-text').textContent = '剩余' + remainingStr + '，按左键从头播放'
      $('resume-hint').classList.remove('hidden')
      $('resume-hint').classList.add('show')

      // Increment hint count
      state.restartHintCount++
      storage.setRestartHintCount(state.restartHintCount)

      // Hide after duration
      this._resumeHintTimer = setTimeout(() => {
        $('resume-hint').classList.remove('show')
        $('resume-hint').classList.add('hidden')
        state.hasPendingRestart = false
      }, CONFIG.RESTART_HINT_DURATION)
    },

    // --- Actions ---

    togglePlay () {
      const v = this._video
      if (!v) return
      if (v.paused) {
        v.play().catch(() => {})
      } else {
        v.pause()
      }
    },

    seekBackward () {
      // If resume hint is active, restart from beginning
      if (state.hasPendingRestart) {
        this._video.currentTime = 0
        $('resume-hint').classList.remove('show')
        $('resume-hint').classList.add('hidden')
        state.hasPendingRestart = false
        return
      }

      const newTime = Math.max(0, this._video.currentTime - CONFIG.SEEK_STEP)
      this._video.currentTime = newTime
      this._showSeekIndicator('快退')
    },

    seekForward () {
      const newTime = Math.min(state.duration || 0, this._video.currentTime + CONFIG.SEEK_STEP)
      this._video.currentTime = newTime
      this._showSeekIndicator('快进')
    },

    _showSeekIndicator (text) {
      const el = $('seek-indicator')
      el.textContent = text
      el.classList.remove('hidden')
      // Force reflow for animation
      void el.offsetWidth
      el.classList.add('show')

      if (this._seekIndicatorTimer) clearTimeout(this._seekIndicatorTimer)
      this._seekIndicatorTimer = setTimeout(() => {
        el.classList.remove('show')
        el.classList.add('hidden')
      }, CONFIG.SEEK_INDICATOR_DURATION)

      // Show controls briefly after seek
      this._showBottom()
      this._scheduleAutoHide()
    },

    seekToPercent (pct) {
      if (this._video && state.duration > 0) {
        this._video.currentTime = (pct / 100) * state.duration
      }
    },

    // --- Cleanup ---

    _clearTimers () {
      this._cancelAutoHide()
      this._stopProgressSaving()
      if (this._resumeHintTimer) {
        clearTimeout(this._resumeHintTimer)
        this._resumeHintTimer = null
      }
      if (this._seekIndicatorTimer) {
        clearTimeout(this._seekIndicatorTimer)
        this._seekIndicatorTimer = null
      }
    },

    destroy () {
      this._clearTimers()
      const v = this._video
      if (v) {
        v.pause()
        v.src = ''
        v.load()
        // Remove handlers
        if (v._handlers) {
          v._handlers.forEach(({ evt, fn }) => v.removeEventListener(evt, fn))
          delete v._handlers
        }
      }
      this._video = null
    },
  }

  // ==========================================================
  //   IMAGE VIEW
  // ==========================================================
  const imageView = {
    render () {
      $('image-title-text').textContent = state.imageName || ''

      const body = $('image-body')
      body.innerHTML =
        '<img id="image-display" src="' + encodeURI(state.imageUrl) + '" alt="" style="max-width:100%;max-height:100%;object-fit:contain;" />'

      const img = document.getElementById('image-display')
      if (img) {
        img.onload = () => img.classList.add('loaded')
        img.onerror = () => {
          body.innerHTML =
            '<div class="image-error">' +
            '<div class="image-error-icon">🖼</div>' +
            '<div class="image-error-text">图片加载失败了</div>' +
            '<button class="btn-retry" id="btn-img-retry">再试一次</button>' +
            '</div>'
          document.getElementById('btn-img-retry')?.addEventListener('click', () => {
            // Force reload by toggling src
            img.src = ''
            setTimeout(() => { img.src = state.imageUrl }, 50)
            // Re-render
            imageView.render()
          })
        }
      }
    },
  }

  // ==========================================================
  //   SETTINGS SCREEN
  // ==========================================================
  const settings = {
    render () {
      const body = $('settings-body')
      const modeLabel = state.playMode === 0 ? '列表循环' : '单集循环'

      body.innerHTML =
        '<div class="settings-item" id="setting-play-mode">' +
        '<span class="settings-item-label">播放方式</span>' +
        '<span class="settings-item-value">' + modeLabel + '</span>' +
        '</div>' +
        '<div class="settings-item" id="setting-check-update">' +
        '<span class="settings-item-label">检查更新</span>' +
        '<span class="settings-item-value">当前版本：' + CONFIG.VERSION_NAME + '</span>' +
        '</div>'

      // Play mode click
      document.getElementById('setting-play-mode')?.addEventListener('click', () => {
        settings.showPlayModeDialog()
      })

      // Update check click
      document.getElementById('setting-check-update')?.addEventListener('click', () => {
        settings.checkUpdate()
      })
    },

    showPlayModeDialog () {
      const current = state.playMode
      const options = ['列表循环', '单集循环']
      const values = [0, 1]

      // Simple custom dialog
      const body = $('settings-body')
      const overlay = document.createElement('div')
      overlay.className = 'modal-overlay'
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);z-index:200;'

      const box = document.createElement('div')
      box.className = 'modal-box'
      box.innerHTML =
        '<div class="modal-title" style="margin-bottom:16px;">选择播放方式</div>' +
        options.map((opt, i) =>
          '<div style="padding:14px 20px;border-radius:12px;margin-bottom:8px;cursor:pointer;font-size:16px;font-weight:700;' +
          (values[i] === current
            ? 'background:rgba(255,170,63,0.2);color:#ffaa3f;'
            : 'background:rgba(255,255,255,0.06);color:#fff;') +
          '" data-value="' + values[i] + '">' +
          (values[i] === current ? '✓ ' : '') + opt +
          '</div>'
        ).join('') +
        '<button class="modal-btn" id="dialog-cancel" style="margin-top:8px;background:rgba(255,255,255,0.1);color:#fff;">取消</button>'

      overlay.appendChild(box)
      document.body.appendChild(overlay)

      // Bind option clicks
      box.querySelectorAll('[data-value]').forEach(el => {
        el.addEventListener('click', () => {
          const val = parseInt(el.dataset.value, 10)
          state.playMode = val
          storage.setPlayMode(val)
          document.body.removeChild(overlay)
          this.render()
        })
      })

      document.getElementById('dialog-cancel')?.addEventListener('click', () => {
        document.body.removeChild(overlay)
      })

      // Close on overlay background tap
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) document.body.removeChild(overlay)
      })
    },

    async checkUpdate () {
      const item = document.getElementById('setting-check-update')
      if (!item) return

      const valueEl = item.querySelector('.settings-item-value')
      if (!valueEl) return

      // Show spinner
      valueEl.innerHTML = '<span class="spinner-inline" style="display:inline-block;width:18px;height:18px;border:2px solid rgba(255,255,255,0.15);border-top-color:#ffaa3f;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;"></span>'

      try {
        const info = await api.fetchUpdateInfo()
        if (info.versionCode > CONFIG.VERSION_CODE) {
          valueEl.innerHTML = '发现新版本 ' + info.versionName +
            ' · <a href="' + info.downloadUrl + '" target="_blank" style="color:#ffaa3f;text-decoration:underline;">下载</a>'
        } else {
          valueEl.textContent = '已是最新版本：' + CONFIG.VERSION_NAME
        }
      } catch (err) {
        valueEl.textContent = '检查失败：' + (err.message || '网络错误')
        setTimeout(() => {
          valueEl.textContent = '当前版本：' + CONFIG.VERSION_NAME
        }, 3000)
      }
    },
  }

  // ==========================================================
  //   UTILITY
  // ==========================================================
  function escapeHtml (str) {
    const div = document.createElement('div')
    div.textContent = str
    return div.innerHTML
  }

  function placeholderSvg (type) {
    const config = type === 0
      ? { bg: ['#4a4a4a', '#5a5a5a'], icon: '📁' }
      : type === 1
      ? { bg: ['#3a5a5a', '#2a4a4a'], icon: '🎬' }
      : { bg: ['#5a3a4a', '#4a2a3a'], icon: '🖼' }

    return 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">' +
      '<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">' +
      '<stop offset="0%" stop-color="' + config.bg[0] + '"/>' +
      '<stop offset="100%" stop-color="' + config.bg[1] + '"/>' +
      '</linearGradient></defs>' +
      '<rect fill="url(#g)" width="320" height="180" rx="8"/>' +
      '<text fill="rgba(255,255,255,0.3)" font-size="40" x="160" y="115" text-anchor="middle">' + config.icon + '</text>' +
      '</svg>'
    )
  }

  function addSpinKeyframes () {
    // Ensure spin animation keyframes exist
    if (!document.getElementById('spin-keyframes')) {
      const style = document.createElement('style')
      style.id = 'spin-keyframes'
      style.textContent =
        '@keyframes spin { to { transform: rotate(360deg); } }'
      document.head.appendChild(style)
    }
  }

  // ==========================================================
  //   EVENT BINDING
  // ==========================================================
  function bindEvents () {
    // --- Browser ---
    $('btn-settings')?.addEventListener('click', () => browser.goToSettings())
    $('btn-browser-back')?.addEventListener('click', () => browser.navigateUp())

    // --- Player controls ---
    $('btn-player-back')?.addEventListener('click', () => router.navigate('browser'))
    $('btn-play-pause')?.addEventListener('click', () => player.togglePlay())
    $('btn-rewind')?.addEventListener('click', () => player.seekBackward())
    $('btn-forward')?.addEventListener('click', () => player.seekForward())

    // Progress bar seek (click + touch)
    const progressTrack = $('progress-track')
    if (progressTrack) {
      const handleSeek = (e) => {
        const rect = progressTrack.getBoundingClientRect()
        const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left
        const pct = Math.max(0, Math.min(100, (x / rect.width) * 100))
        player.seekToPercent(pct)
      }

      progressTrack.addEventListener('click', handleSeek)
      progressTrack.addEventListener('touchstart', (e) => {
        progressTrack.classList.add('touching')
        handleSeek(e)
      }, { passive: true })
      progressTrack.addEventListener('touchmove', (e) => {
        handleSeek(e)
      }, { passive: true })
      progressTrack.addEventListener('touchend', () => {
        progressTrack.classList.remove('touching')
      }, { passive: true })
    }

    // Video tap — single tap toggles controls, double-tap toggles play/pause
    const video = $('player-video')
    if (video) {
      let _clickTimer = null

      video.addEventListener('click', (e) => {
        // Ignore if tap is on the bottom controls bar
        const bottom = $('player-bottom')
        if (bottom && !bottom.classList.contains('hidden')) {
          const rect = bottom.getBoundingClientRect()
          if (e.clientY >= rect.top) return
        }
        // Ignore if tap is on the title bar
        const titleBar = $('player-title-bar')
        if (titleBar && !titleBar.classList.contains('hidden')) {
          const rect = titleBar.getBoundingClientRect()
          if (e.clientX >= rect.left && e.clientX <= rect.right &&
              e.clientY >= rect.top && e.clientY <= rect.bottom) return
        }

        // Double-tap detection
        if (_clickTimer) {
          // Second tap within 300ms → double-tap: toggle play/pause
          clearTimeout(_clickTimer)
          _clickTimer = null
          player.togglePlay()
          return
        }

        _clickTimer = setTimeout(() => {
          _clickTimer = null
          // Single tap → toggle controls visibility
          const controlsHidden = bottom.classList.contains('hidden')
          if (controlsHidden) {
            player._showBottom()
            if (state.isPlaying) {
              player._scheduleAutoHide()
            }
          } else {
            player._cancelAutoHide()
            $('player-bottom').classList.add('hidden')
            $('player-title-bar').classList.add('hidden')
          }
        }, 300)
      })
    }

    // --- Image ---
    $('btn-image-back')?.addEventListener('click', () => router.navigate('browser'))

    // --- Settings ---
    $('btn-settings-back')?.addEventListener('click', () => router.navigate('browser'))

    // --- Cooldown modal ---
    $('btn-cooldown-ok')?.addEventListener('click', () => {
      $('cooldown-modal').classList.add('hidden')
    })

    // --- Keyboard ---
    document.addEventListener('keydown', (e) => {
      const screen = router.currentScreen
      if (screen === 'player') {
        switch (e.key) {
          case ' ':
            e.preventDefault()
            player.togglePlay()
            break
          case 'ArrowLeft':
            e.preventDefault()
            player.seekBackward()
            break
          case 'ArrowRight':
            e.preventDefault()
            player.seekForward()
            break
          case 'Escape':
            e.preventDefault()
            router.navigate('browser')
            break
        }
      } else if (screen === 'browser') {
        if (e.key === 'Escape' || e.key === 'Backspace') {
          e.preventDefault()
          browser.navigateUp()
        }
      } else if (screen === 'image' || screen === 'settings') {
        if (e.key === 'Escape') {
          e.preventDefault()
          router.navigate('browser')
        }
      }
    })

    // --- Android-like back button behavior for hash ---
    // The hash-based routing handles back naturally via browser history
  }

  // ==========================================================
  //   INIT
  // ==========================================================
  function init () {
    addSpinKeyframes()

    // Load persisted state
    state.playMode = storage.getPlayMode()
    parental.init()

    // Bind all events
    bindEvents()

    // Start routing
    router.init()

    // Load root files
    browser.loadFiles('/')

    console.log('儿童视频 v' + CONFIG.VERSION_NAME + ' 已启动')
    console.log('后端服务器: ' + CONFIG.SERVER_URL)
    console.log('提示: 如需修改后端地址，请编辑 app.js 中的 CONFIG.SERVER_URL')
  }

  document.addEventListener('DOMContentLoaded', init)
})()
