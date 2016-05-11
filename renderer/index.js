console.time('init')

var appConfig = require('application-config')('WebTorrent')
var concat = require('concat-stream')
var dragDrop = require('drag-drop')
var electron = require('electron')
var fs = require('fs-extra')
var mainLoop = require('main-loop')
var path = require('path')
var srtToVtt = require('srt-to-vtt')
var LanguageDetect = require('languagedetect')

var createElement = require('virtual-dom/create-element')
var diff = require('virtual-dom/diff')
var patch = require('virtual-dom/patch')

var App = require('./views/app')
var config = require('../config')
var crashReporter = require('../crash-reporter')
var errors = require('./lib/errors')
var sound = require('./lib/sound')
var State = require('./state')
var TorrentPlayer = require('./lib/torrent-player')
var TorrentSummary = require('./lib/torrent-summary')

var {setDispatch} = require('./lib/dispatcher')
setDispatch(dispatch)

appConfig.filePath = path.join(config.CONFIG_PATH, 'config.json')

// Electron apps have two processes: a main process (node) runs first and starts
// a renderer process (essentially a Chrome window). We're in the renderer process,
// and this IPC channel receives from and sends messages to the main process
var ipcRenderer = electron.ipcRenderer
var clipboard = electron.clipboard

var dialog = electron.remote.dialog
var Menu = electron.remote.Menu
var MenuItem = electron.remote.MenuItem
var remote = electron.remote

// This dependency is the slowest-loading, so we lazy load it
var Cast = null

// For easy debugging in Developer Tools
var state = global.state = State.getInitialState()

var vdomLoop

// Report crashes back to our server.
// Not global JS exceptions, not like Rollbar, handles segfaults/core dumps only
crashReporter.init()

// All state lives in state.js. `state.saved` is read from and written to a file.
// All other state is ephemeral. First we load state.saved then initialize the app.
loadState(init)

/**
 * Called once when the application loads. (Not once per window.)
 * Connects to the torrent networks, sets up the UI and OS integrations like
 * the dock icon and drag+drop.
 */
function init () {
  // Clean up the freshly-loaded config file, which may be from an older version
  cleanUpConfig()

  // Push the first page into the location history
  state.location.go({ url: 'home' })

  // Restart everything we were torrenting last time the app ran
  resumeTorrents()

  // Lazy-load other stuff, like the AppleTV module, later to keep startup fast
  window.setTimeout(delayedInit, 5000)

  // The UI is built with virtual-dom, a minimalist library extracted from React
  // The concepts--one way data flow, a pure function that renders state to a
  // virtual DOM tree, and a diff that applies changes in the vdom to the real
  // DOM, are all the same. Learn more: https://facebook.github.io/react/
  vdomLoop = mainLoop(state, render, {
    create: createElement,
    diff: diff,
    patch: patch
  })
  document.body.appendChild(vdomLoop.target)

  // Calling update() updates the UI given the current state
  // Do this at least once a second to give every file in every torrentSummary
  // a progress bar and to keep the cursor in sync when playing a video
  setInterval(update, 1000)

  // OS integrations:
  // ...drag and drop a torrent or video file to play or seed
  dragDrop('body', (files) => dispatch('onOpen', files))

  // ...same thing if you paste a torrent
  document.addEventListener('paste', onPaste)

  // ...keyboard shortcuts
  document.addEventListener('keydown', onKeyDown)

  // ...focus and blur. Needed to show correct dock icon text ("badge") in OSX
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)

  // Listen for messages from the main process
  setupIpc()

  // Done! Ideally we want to get here <100ms after the user clicks the app
  sound.play('STARTUP')

  console.timeEnd('init')
}

function delayedInit () {
  lazyLoadCast()
  sound.preload()
}

// Change `state.saved` (which will be saved back to config.json on exit) as
// needed, for example to deal with config.json format changes across versions
function cleanUpConfig () {
  state.saved.torrents.forEach(function (ts) {
    var infoHash = ts.infoHash

    // Migration: replace torrentPath with torrentFileName
    var src, dst
    if (ts.torrentPath) {
      console.log('migration: replacing torrentPath %s', ts.torrentPath)
      src = path.isAbsolute(ts.torrentPath)
        ? ts.torrentPath
        : path.join(config.STATIC_PATH, ts.torrentPath)
      dst = path.join(config.CONFIG_TORRENT_PATH, infoHash + '.torrent')
      // Synchronous FS calls aren't ideal, but probably OK in a migration
      // that only runs once
      if (src !== dst) fs.copySync(src, dst)

      delete ts.torrentPath
      ts.torrentFileName = infoHash + '.torrent'
    }

    // Migration: replace posterURL with posterFileName
    if (ts.posterURL) {
      console.log('migration: replacing posterURL %s', ts.posterURL)
      var extension = path.extname(ts.posterURL)
      src = path.isAbsolute(ts.posterURL)
        ? ts.posterURL
        : path.join(config.STATIC_PATH, ts.posterURL)
      dst = path.join(config.CONFIG_POSTER_PATH, infoHash + extension)
      // Synchronous FS calls aren't ideal, but probably OK in a migration
      // that only runs once
      if (src !== dst) fs.copySync(src, dst)

      delete ts.posterURL
      ts.posterFileName = infoHash + extension
    }

    // Migration: add per-file selections
    if (!ts.selections) {
      ts.selections = ts.files.map((x) => true)
    }
  })
}

// Lazily loads Chromecast and Airplay support
function lazyLoadCast () {
  if (!Cast) {
    Cast = require('./lib/cast')
    Cast.init(state, update) // Search the local network for Chromecast and Airplays
  }
  return Cast
}

// This is the (mostly) pure function from state -> UI. Returns a virtual DOM
// tree. Any events, such as button clicks, will turn into calls to dispatch()
function render (state) {
  try {
    return App(state)
  } catch (e) {
    console.log('rendering error: %s\n\t%s', e.message, e.stack)
  }
}

// Calls render() to go from state -> UI, then applies to vdom to the real DOM.
function update () {
  showOrHidePlayerControls()
  vdomLoop.update(state)
  updateElectron()
}

function updateElectron () {
  if (state.window.title !== state.prev.title) {
    state.prev.title = state.window.title
    ipcRenderer.send('setTitle', state.window.title)
  }
  if (state.dock.progress !== state.prev.progress) {
    state.prev.progress = state.dock.progress
    ipcRenderer.send('setProgress', state.dock.progress)
  }
  if (state.dock.badge !== state.prev.badge) {
    state.prev.badge = state.dock.badge
    ipcRenderer.send('setBadge', state.dock.badge || '')
  }
}

// Events from the UI never modify state directly. Instead they call dispatch()
function dispatch (action, ...args) {
  // Log dispatch calls, for debugging
  if (!['mediaMouseMoved', 'mediaTimeUpdate'].includes(action)) {
    console.log('dispatch: %s %o', action, args)
  }

  if (action === 'onOpen') {
    onOpen(args[0] /* files */)
  }
  if (action === 'addTorrent') {
    addTorrent(args[0] /* torrent */)
  }
  if (action === 'showOpenTorrentFile') {
    ipcRenderer.send('showOpenTorrentFile') /* open torrent file */
  }
  if (action === 'showCreateTorrent') {
    showCreateTorrent(args[0] /* fileOrFolder */)
  }
  if (action === 'createTorrent') {
    createTorrent(args[0] /* options */)
  }
  if (action === 'openFile') {
    openFile(args[0] /* infoHash */, args[1] /* index */)
  }
  if (action === 'toggleTorrent') {
    toggleTorrent(args[0] /* infoHash */)
  }
  if (action === 'deleteTorrent') {
    deleteTorrent(args[0] /* infoHash */)
  }
  if (action === 'toggleSelectTorrent') {
    toggleSelectTorrent(args[0] /* infoHash */)
  }
  if (action === 'toggleTorrentFile') {
    toggleTorrentFile(args[0] /* infoHash */, args[1] /* index */)
  }
  if (action === 'openTorrentContextMenu') {
    openTorrentContextMenu(args[0] /* infoHash */)
  }
  if (action === 'openDevice') {
    lazyLoadCast().open(args[0] /* deviceType */)
  }
  if (action === 'closeDevice') {
    lazyLoadCast().close()
  }
  if (action === 'setDimensions') {
    setDimensions(args[0] /* dimensions */)
  }
  if (action === 'backToList') {
    // Exit any modals and screens with a back button
    state.modal = null
    while (state.location.hasBack()) state.location.back()

    // Work around virtual-dom issue: it doesn't expose its redraw function,
    // and only redraws on requestAnimationFrame(). That means when the user
    // closes the window (hide window / minimize to tray) and we want to pause
    // the video, we update the vdom but it keeps playing until you reopen!
    var mediaTag = document.querySelector('video,audio')
    if (mediaTag) mediaTag.pause()
  }
  if (action === 'back') {
    state.location.back()
  }
  if (action === 'forward') {
    state.location.forward()
  }
  if (action === 'playPause') {
    playPause()
  }
  if (action === 'play') {
    if (state.location.pending()) return
    state.location.go({
      url: 'player',
      onbeforeload: function (cb) {
        openPlayer(args[0] /* infoHash */, args[1] /* index */, cb)
      },
      onbeforeunload: closePlayer
    })
    play()
  }
  if (action === 'playbackJump') {
    jumpToTime(args[0] /* seconds */)
  }
  if (action === 'changeVolume') {
    changeVolume(args[0] /* increase */)
  }
  if (action === 'setVolume') {
    setVolume(args[0] /* increase */)
  }
  if (action === 'openSubtitles') {
    openSubtitles()
  }
  if (action === 'selectSubtitle') {
    selectSubtitle(args[0] /* label */)
  }
  if (action === 'showSubtitles') {
    showSubtitles()
  }
  if (action === 'mediaStalled') {
    state.playing.isStalled = true
  }
  if (action === 'mediaError') {
    if (state.location.current().url === 'player') {
      state.playing.location = 'error'
      ipcRenderer.send('checkForVLC')
      ipcRenderer.once('checkForVLC', function (e, isInstalled) {
        state.modal = {
          id: 'unsupported-media-modal',
          error: args[0],
          vlcInstalled: isInstalled
        }
      })
    }
  }
  if (action === 'mediaTimeUpdate') {
    state.playing.lastTimeUpdate = new Date().getTime()
    state.playing.isStalled = false
  }
  if (action === 'mediaMouseMoved') {
    state.playing.mouseStationarySince = new Date().getTime()
  }
  if (action === 'vlcPlay') {
    ipcRenderer.send('vlcPlay', state.server.localURL)
    state.playing.location = 'vlc'
  }
  if (action === 'vlcNotFound') {
    if (state.modal && state.modal.id === 'unsupported-media-modal') {
      state.modal.vlcNotFound = true
    }
  }
  if (action === 'toggleFullScreen') {
    ipcRenderer.send('toggleFullScreen', args[0] /* optional bool */)
  }
  if (action === 'exitModal') {
    state.modal = null
  }
  if (action === 'updateAvailable') {
    updateAvailable(args[0] /* version */)
  }
  if (action === 'skipVersion') {
    if (!state.saved.skippedVersions) state.saved.skippedVersions = []
    state.saved.skippedVersions.push(args[0] /* version */)
    saveStateThrottled()
  }
  if (action === 'saveState') {
    saveState()
  }

  // Update the virtual-dom, unless it's just a mouse move event
  if (action !== 'mediaMouseMoved' || showOrHidePlayerControls()) {
    update()
  }
}

// Shows a modal saying that we have an update
function updateAvailable (version) {
  if (state.saved.skippedVersions && state.saved.skippedVersions.includes(version)) {
    console.log('new version skipped by user: v' + version)
    return
  }
  state.modal = { id: 'update-available-modal', version: version }
}

function play () {
  if (!state.playing.isPaused) return
  state.playing.isPaused = false
  if (isCasting()) {
    Cast.play()
  }
  ipcRenderer.send('blockPowerSave')
}

function pause () {
  if (state.playing.isPaused) return
  state.playing.isPaused = true
  if (isCasting()) {
    Cast.pause()
  }
  ipcRenderer.send('unblockPowerSave')
}

function playPause () {
  if (state.playing.isPaused) {
    play()
  } else {
    pause()
  }
}

function jumpToTime (time) {
  if (isCasting()) {
    Cast.seek(time)
  } else {
    state.playing.jumpToTime = time
  }
}

function changeVolume (delta) {
  // change volume with delta value
  setVolume(state.playing.volume + delta)
}

function setVolume (volume) {
  // check if its in [0.0 - 1.0] range
  volume = Math.max(0, Math.min(1, volume))
  if (isCasting()) {
    Cast.setVolume(volume)
  } else {
    state.playing.setVolume = volume
  }
}

function openSubtitles () {
  dialog.showOpenDialog({
    title: 'Select a subtitles file.',
    filters: [ { name: 'Subtitles', extensions: ['vtt', 'srt'] } ],
    properties: [ 'openFile' ]
  }, function (filenames) {
    if (!Array.isArray(filenames)) return
    addSubtitle({path: filenames[0]})
  })
}

// Checks whether we are connected and already casting
// Returns false if we not casting (state.playing.location === 'local')
// or if we're trying to connect but haven't yet ('chromecast-pending', etc)
function isCasting () {
  return state.playing.location === 'chromecast' ||
    state.playing.location === 'airplay' ||
    state.playing.location === 'dlna'
}

function setupIpc () {
  ipcRenderer.send('ipcReady')

  ipcRenderer.on('log', (e, ...args) => console.log(...args))
  ipcRenderer.on('error', (e, ...args) => console.error(...args))

  ipcRenderer.on('dispatch', (e, ...args) => dispatch(...args))

  ipcRenderer.on('showOpenTorrentAddress', function (e) {
    state.modal = { id: 'open-torrent-address-modal' }
    update()
  })

  ipcRenderer.on('fullscreenChanged', function (e, isFullScreen) {
    state.window.isFullScreen = isFullScreen
    update()
  })

  ipcRenderer.on('wt-infohash', (e, ...args) => torrentInfoHash(...args))
  ipcRenderer.on('wt-metadata', (e, ...args) => torrentMetadata(...args))
  ipcRenderer.on('wt-done', (e, ...args) => torrentDone(...args))
  ipcRenderer.on('wt-warning', (e, ...args) => torrentWarning(...args))
  ipcRenderer.on('wt-error', (e, ...args) => torrentError(...args))

  ipcRenderer.on('wt-progress', (e, ...args) => torrentProgress(...args))
  ipcRenderer.on('wt-file-modtimes', (e, ...args) => torrentFileModtimes(...args))
  ipcRenderer.on('wt-file-saved', (e, ...args) => torrentFileSaved(...args))
  ipcRenderer.on('wt-poster', (e, ...args) => torrentPosterSaved(...args))
  ipcRenderer.on('wt-audio-metadata', (e, ...args) => torrentAudioMetadata(...args))
  ipcRenderer.on('wt-server-running', (e, ...args) => torrentServerRunning(...args))
}

// Load state.saved from the JSON state file
function loadState (cb) {
  appConfig.read(function (err, data) {
    if (err) console.error(err)
    console.log('loaded state from ' + appConfig.filePath)

    // populate defaults if they're not there
    state.saved = Object.assign({}, State.getDefaultSavedState(), data)
    state.saved.torrents.forEach(function (torrentSummary) {
      if (torrentSummary.displayName) torrentSummary.name = torrentSummary.displayName
    })

    if (cb) cb()
  })
}

// Starts all torrents that aren't paused on program startup
function resumeTorrents () {
  state.saved.torrents
    .filter((x) => x.status !== 'paused')
    .forEach((x) => startTorrentingSummary(x))
}

// Don't write state.saved to file more than once a second
function saveStateThrottled () {
  if (state.saveStateTimeout) return
  state.saveStateTimeout = setTimeout(function () {
    delete state.saveStateTimeout
    saveState()
  }, 1000)
}

// Write state.saved to the JSON state file
function saveState () {
  console.log('saving state to ' + appConfig.filePath)

  // Clean up, so that we're not saving any pending state
  var copy = Object.assign({}, state.saved)
  // Remove torrents pending addition to the list, where we haven't finished
  // reading the torrent file or file(s) to seed & don't have an infohash
  copy.torrents = copy.torrents
    .filter((x) => x.infoHash)
    .map(function (x) {
      var torrent = {}
      for (var key in x) {
        if (key === 'progress' || key === 'torrentKey') {
          continue // Don't save progress info or key for the webtorrent process
        }
        if (key === 'playStatus' && x.playStatus !== 'unplayable') {
          continue // Don't save whether a torrent is playing / pending
        }
        torrent[key] = x[key]
      }
      return torrent
    })

  appConfig.write(copy, function (err) {
    if (err) console.error(err)
    ipcRenderer.send('savedState')
  })

  // Update right away, don't wait for the state to save
  update()
}

function onOpen (files) {
  if (!Array.isArray(files)) files = [ files ]

  // .torrent file = start downloading the torrent
  files.filter(isTorrent).forEach(addTorrent)

  // subtitle file
  files.filter(isSubtitle).forEach(addSubtitle)

  // everything else = seed these files
  var rest = files.filter(not(isTorrent)).filter(not(isSubtitle))
  if (rest.length > 0) showCreateTorrent(rest)
}

function isTorrent (file) {
  var name = typeof file === 'string' ? file : file.name
  var isTorrentFile = path.extname(name).toLowerCase() === '.torrent'
  var isMagnet = typeof file === 'string' && /^magnet:/.test(file)
  return isTorrentFile || isMagnet
}

function isSubtitle (file) {
  var name = typeof file === 'string' ? file : file.name
  var ext = path.extname(name).toLowerCase()
  return ext === '.srt' || ext === '.vtt'
}

function not (test) {
  return function (...args) {
    return !test(...args)
  }
}

// Gets a torrent summary {name, infoHash, status} from state.saved.torrents
// Returns undefined if we don't know that infoHash
function getTorrentSummary (torrentKey) {
  if (!torrentKey) return undefined
  return state.saved.torrents.find((x) =>
    x.torrentKey === torrentKey || x.infoHash === torrentKey)
}

// Adds a torrent to the list, starts downloading/seeding. TorrentID can be a
// magnet URI, infohash, or torrent file: https://github.com/feross/webtorrent#clientaddtorrentid-opts-function-ontorrent-torrent-
function addTorrent (torrentId) {
  var torrentKey = state.nextTorrentKey++
  var path = state.saved.downloadPath
  if (torrentId.path) {
    // Use path string instead of W3C File object
    torrentId = torrentId.path
  }
  ipcRenderer.send('wt-start-torrenting', torrentKey, torrentId, path)
}

function addSubtitle (file) {
  if (state.playing.type !== 'video') return
  fs.createReadStream(file.path || file).pipe(srtToVtt()).pipe(concat(function (buf) {
    // Set the cue text position so it appears above the player controls.
    // The only way to change cue text position is by modifying the VTT. It is not
    // possible via CSS.
    var langDetected = (new LanguageDetect()).detect(buf.toString().replace(/(.*-->.*)/g, ''), 2)
    langDetected = langDetected.length ? langDetected[0][0] : 'subtitle'
    langDetected = langDetected.slice(0, 1).toUpperCase() + langDetected.slice(1)
    var subtitles = Buffer(buf.toString().replace(/(-->.*)/g, '$1 line:88%'))
    var track = {
      buffer: 'data:text/vtt;base64,' + subtitles.toString('base64'),
      label: langDetected,
      selected: true
    }
    state.playing.subtitles.tracks.forEach(function (trackItem) {
      trackItem.selected = false
      if (trackItem.label === track.label) {
        track.label = Number.isNaN(track.label.slice(-1))
          ? track.label + ' 2'
          : track.label.slice(0, -1) + (parseInt(track.label.slice(-1)) + 1)
      }
    })
    state.playing.subtitles.change = track.label
    state.playing.subtitles.tracks.push(track)
    state.playing.subtitles.enabled = true
  }))
}

function selectSubtitle (label) {
  state.playing.subtitles.tracks.forEach(function (track) {
    track.selected = (track.label === label)
  })
  state.playing.subtitles.enabled = !!label
  state.playing.subtitles.change = label
  state.playing.subtitles.show = false
}

function showSubtitles () {
  state.playing.subtitles.show = !state.playing.subtitles.show
}

// Starts downloading and/or seeding a given torrentSummary. Returns WebTorrent object
function startTorrentingSummary (torrentSummary) {
  var s = torrentSummary

  // Backward compatibility for config files save before we had torrentKey
  if (!s.torrentKey) s.torrentKey = state.nextTorrentKey++

  // Use Downloads folder by default
  var path = s.path || state.saved.downloadPath

  var torrentID
  if (s.torrentFileName) { // Load torrent file from disk
    torrentID = TorrentSummary.getTorrentPath(torrentSummary)
  } else { // Load torrent from DHT
    torrentID = s.magnetURI || s.infoHash
  }

  console.log('start torrenting %s %s', s.torrentKey, torrentID)
  ipcRenderer.send('wt-start-torrenting', s.torrentKey, torrentID, path, s.fileModtimes, s.selections)
}

//
// TORRENT MANAGEMENT
// Send commands to the WebTorrent process, handle events
//

// Shows the Create Torrent page with options to seed a given file or folder
function showCreateTorrent (files) {
  if (Array.isArray(files)) {
    if (state.location.pending() || state.location.current().url !== 'home') return
    state.location.go({
      url: 'create-torrent',
      files: files
    })
    return
  }

  var fileOrFolder = files
  findFilesRecursive(fileOrFolder, showCreateTorrent)
}

// Recursively finds {name, path, size} for all files in a folder
// Calls `cb` on success, calls `onError` on failure
function findFilesRecursive (fileOrFolder, cb) {
  fs.stat(fileOrFolder, function (err, stat) {
    if (err) return onError(err)

    // Files: return name, path, and size
    if (!stat.isDirectory()) {
      var filePath = fileOrFolder
      return cb([{
        name: path.basename(filePath),
        path: filePath,
        size: stat.size
      }])
    }

    // Folders: recurse, make a list of all the files
    var folderPath = fileOrFolder
    fs.readdir(folderPath, function (err, fileNames) {
      if (err) return onError(err)
      var numComplete = 0
      var ret = []
      fileNames.forEach(function (fileName) {
        findFilesRecursive(path.join(folderPath, fileName), function (fileObjs) {
          ret = ret.concat(fileObjs)
          if (++numComplete === fileNames.length) {
            cb(ret)
          }
        })
      })
    })
  })
}

// Creates a new torrent and start seeeding
function createTorrent (options) {
  var torrentKey = state.nextTorrentKey++
  ipcRenderer.send('wt-create-torrent', torrentKey, options)
}

function torrentInfoHash (torrentKey, infoHash) {
  var torrentSummary = getTorrentSummary(torrentKey)
  console.log('got infohash for %s torrent %s',
    torrentSummary ? 'existing' : 'new', torrentKey)

  if (!torrentSummary) {
    torrentSummary = {
      torrentKey: torrentKey,
      status: 'new'
    }
    state.saved.torrents.push(torrentSummary)
    sound.play('ADD')
  }

  torrentSummary.infoHash = infoHash
  update()
}

function torrentWarning (torrentKey, message) {
  onWarning(message)
}

function torrentError (torrentKey, message) {
  var torrentSummary = getTorrentSummary(torrentKey)

  // TODO: WebTorrent should have semantic errors
  if (message.startsWith('There is already a swarm')) {
    onError(new Error('Can\'t add duplicate torrent'))
  } else if (!torrentSummary) {
    onError(message)
  } else {
    console.log('error, stopping torrent %s (%s):\n\t%o',
      torrentSummary.name, torrentSummary.infoHash, message)
    torrentSummary.status = 'paused'
    update()
  }
}

function torrentMetadata (torrentKey, torrentInfo) {
  // Summarize torrent
  var torrentSummary = getTorrentSummary(torrentKey)
  torrentSummary.status = 'downloading'
  torrentSummary.name = torrentSummary.displayName || torrentInfo.name
  torrentSummary.path = torrentInfo.path
  torrentSummary.files = torrentInfo.files
  torrentSummary.magnetURI = torrentInfo.magnetURI
  if (!torrentSummary.selections) {
    torrentSummary.selections = torrentSummary.files.map((x) => true)
  }
  update()

  // Save the .torrent file, if it hasn't been saved already
  if (!torrentSummary.torrentFileName) ipcRenderer.send('wt-save-torrent-file', torrentKey)

  // Auto-generate a poster image, if it hasn't been generated already
  if (!torrentSummary.posterFileName) ipcRenderer.send('wt-generate-torrent-poster', torrentKey)
}

function torrentDone (torrentKey, torrentInfo) {
  // Update the torrent summary
  var torrentSummary = getTorrentSummary(torrentKey)
  torrentSummary.status = 'seeding'

  // Notify the user that a torrent finished, but only if we actually DL'd at least part of it.
  // Don't notify if we merely finished verifying data files that were already on disk.
  if (torrentInfo.bytesReceived > 0) {
    if (!state.window.isFocused) {
      state.dock.badge += 1
    }
    showDoneNotification(torrentSummary)
  }

  update()
}

function torrentProgress (progressInfo) {
  // Overall progress across all active torrents, 0 to 1
  var progress = progressInfo.progress
  var hasActiveTorrents = progressInfo.hasActiveTorrents

  // Hide progress bar when client has no torrents, or progress is 100%
  // TODO: isn't this equivalent to: if (progress === 1) ?
  if (!hasActiveTorrents || progress === 1) {
    progress = -1
  }

  // Show progress bar under the WebTorrent taskbar icon, on OSX
  state.dock.progress = progress

  // Update progress for each individual torrent
  progressInfo.torrents.forEach(function (p) {
    var torrentSummary = getTorrentSummary(p.torrentKey)
    if (!torrentSummary) {
      console.log('warning: got progress for missing torrent %s', p.torrentKey)
      return
    }
    torrentSummary.progress = p
  })

  update()
}

function torrentFileModtimes (torrentKey, fileModtimes) {
  var torrentSummary = getTorrentSummary(torrentKey)
  torrentSummary.fileModtimes = fileModtimes
  saveStateThrottled()
}

function torrentFileSaved (torrentKey, torrentFileName) {
  console.log('torrent file saved %s: %s', torrentKey, torrentFileName)
  var torrentSummary = getTorrentSummary(torrentKey)
  torrentSummary.torrentFileName = torrentFileName
  saveStateThrottled()
}

function torrentPosterSaved (torrentKey, posterFileName) {
  var torrentSummary = getTorrentSummary(torrentKey)
  torrentSummary.posterFileName = posterFileName
  saveStateThrottled()
}

function torrentAudioMetadata (infoHash, index, info) {
  var torrentSummary = getTorrentSummary(infoHash)
  var fileSummary = torrentSummary.files[index]
  fileSummary.audioInfo = info
  update()
}

function torrentServerRunning (serverInfo) {
  state.server = serverInfo
}

// Picks the default file to play from a list of torrent or torrentSummary files
// Returns an index or undefined, if no files are playable
function pickFileToPlay (files) {
  // first, try to find the biggest video file
  var videoFiles = files.filter(TorrentPlayer.isVideo)
  if (videoFiles.length > 0) {
    var largestVideoFile = videoFiles.reduce(function (a, b) {
      return a.length > b.length ? a : b
    })
    return files.indexOf(largestVideoFile)
  }

  // if there are no videos, play the first audio file
  var audioFiles = files.filter(TorrentPlayer.isAudio)
  if (audioFiles.length > 0) {
    return files.indexOf(audioFiles[0])
  }

  // no video or audio means nothing is playable
  return undefined
}

// Opens the video player
function openPlayer (infoHash, index, cb) {
  var torrentSummary = getTorrentSummary(infoHash)

  // automatically choose which file in the torrent to play, if necessary
  if (index === undefined) index = pickFileToPlay(torrentSummary.files)
  if (index === undefined) return cb(new errors.UnplayableError())

  // update UI to show pending playback
  if (torrentSummary.progress !== 1) sound.play('PLAY')
  torrentSummary.playStatus = 'requested'
  update()

  var timeout = setTimeout(function () {
    torrentSummary.playStatus = 'timeout' /* no seeders available? */
    sound.play('ERROR')
    cb(new Error('playback timed out'))
    update()
  }, 10000) /* give it a few seconds */

  if (torrentSummary.status === 'paused') {
    startTorrentingSummary(torrentSummary)
    ipcRenderer.once('wt-ready-' + torrentSummary.infoHash,
      () => openPlayerFromActiveTorrent(torrentSummary, index, timeout, cb))
  } else {
    openPlayerFromActiveTorrent(torrentSummary, index, timeout, cb)
  }
}

function openPlayerFromActiveTorrent (torrentSummary, index, timeout, cb) {
  var fileSummary = torrentSummary.files[index]

  // update state
  state.playing.infoHash = torrentSummary.infoHash
  state.playing.fileIndex = index
  state.playing.type = TorrentPlayer.isVideo(fileSummary) ? 'video'
    : TorrentPlayer.isAudio(fileSummary) ? 'audio'
    : 'other'

  // if it's audio, parse out the metadata (artist, title, etc)
  if (state.playing.type === 'audio' && !fileSummary.audioInfo) {
    ipcRenderer.send('wt-get-audio-metadata', torrentSummary.infoHash, index)
  }

  ipcRenderer.send('wt-start-server', torrentSummary.infoHash, index)
  ipcRenderer.once('wt-server-' + torrentSummary.infoHash, function (e, info) {
    clearTimeout(timeout)

    // if we timed out (user clicked play a long time ago), don't autoplay
    var timedOut = torrentSummary.playStatus === 'timeout'
    delete torrentSummary.playStatus
    if (timedOut) {
      ipcRenderer.send('wt-stop-server')
      return update()
    }

    // otherwise, play the video
    state.window.title = torrentSummary.files[state.playing.fileIndex].name
    update()

    ipcRenderer.send('onPlayerOpen')

    cb()
  })
}

function closePlayer (cb) {
  if (isCasting()) {
    Cast.close()
  }
  if (state.playing.location === 'vlc') {
    ipcRenderer.send('vlcQuit')
  }
  state.window.title = config.APP_WINDOW_TITLE
  state.playing = State.getDefaultPlayState()
  state.server = null

  if (state.window.isFullScreen) {
    dispatch('toggleFullScreen', false)
  }
  restoreBounds()

  ipcRenderer.send('wt-stop-server')
  ipcRenderer.send('unblockPowerSave')
  ipcRenderer.send('onPlayerClose')

  update()
  cb()
}

function openFile (infoHash, index) {
  var torrentSummary = getTorrentSummary(infoHash)
  var filePath = path.join(
    torrentSummary.path,
    torrentSummary.files[index].path)
  ipcRenderer.send('openItem', filePath)
}

// TODO: use torrentKey, not infoHash
function toggleTorrent (infoHash) {
  var torrentSummary = getTorrentSummary(infoHash)
  if (torrentSummary.status === 'paused') {
    torrentSummary.status = 'new'
    startTorrentingSummary(torrentSummary)
    sound.play('ENABLE')
  } else {
    torrentSummary.status = 'paused'
    ipcRenderer.send('wt-stop-torrenting', torrentSummary.infoHash)
    sound.play('DISABLE')
  }
}

// TODO: use torrentKey, not infoHash
function deleteTorrent (infoHash) {
  ipcRenderer.send('wt-stop-torrenting', infoHash)

  var index = state.saved.torrents.findIndex((x) => x.infoHash === infoHash)
  if (index > -1) state.saved.torrents.splice(index, 1)
  saveStateThrottled()
  state.location.clearForward() // prevent user from going forward to a deleted torrent
  sound.play('DELETE')
}

function toggleSelectTorrent (infoHash) {
  // toggle selection
  state.selectedInfoHash = state.selectedInfoHash === infoHash ? null : infoHash
  update()
}

function toggleTorrentFile (infoHash, index) {
  var torrentSummary = getTorrentSummary(infoHash)
  torrentSummary.selections[index] = !torrentSummary.selections[index]

  // Let the WebTorrent process know to start or stop fetching that file
  ipcRenderer.send('wt-select-files', infoHash, torrentSummary.selections)
}

function openTorrentContextMenu (infoHash) {
  var torrentSummary = getTorrentSummary(infoHash)
  var menu = new Menu()

  if (torrentSummary.files) {
    menu.append(new MenuItem({
      label: process.platform === 'darwin' ? 'Show in Finder' : 'Show in Folder',
      click: () => showItemInFolder(torrentSummary)
    }))
    menu.append(new MenuItem({
      type: 'separator'
    }))
  }

  menu.append(new MenuItem({
    label: 'Copy Magnet Link to Clipboard',
    click: () => clipboard.writeText(torrentSummary.magnetURI)
  }))

  menu.append(new MenuItem({
    label: 'Copy Instant.io Link to Clipboard',
    click: () => clipboard.writeText(`https://instant.io/#${torrentSummary.infoHash}`)
  }))

  menu.append(new MenuItem({
    label: 'Save Torrent File As...',
    click: () => saveTorrentFileAs(torrentSummary)
  }))

  menu.popup(remote.getCurrentWindow())
}

function showItemInFolder (torrentSummary) {
  var itemPath = path.join(torrentSummary.path, torrentSummary.files[0].path)
  if (torrentSummary.files.length > 1) {
    itemPath = path.dirname(itemPath)
  }
  ipcRenderer.send('showItemInFolder', itemPath)
}

function saveTorrentFileAs (torrentSummary) {
  var newFileName = `${path.parse(torrentSummary.name).name}.torrent`
  var opts = {
    title: 'Save Torrent File',
    defaultPath: path.join(state.saved.downloadPath, newFileName),
    filters: [
      { name: 'Torrent Files', extensions: ['torrent'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  }
  dialog.showSaveDialog(remote.getCurrentWindow(), opts, function (savePath) {
    var torrentPath = TorrentSummary.getTorrentPath(torrentSummary)
    fs.readFile(torrentPath, function (err, torrentFile) {
      if (err) return onError(err)
      fs.writeFile(savePath, torrentFile, function (err) {
        if (err) return onError(err)
      })
    })
  })
}

// Set window dimensions to match video dimensions or fill the screen
function setDimensions (dimensions) {
  // Don't modify the window size if it's already maximized
  if (remote.getCurrentWindow().isMaximized()) {
    state.window.bounds = null
    return
  }

  // Save the bounds of the window for later. See restoreBounds()
  state.window.bounds = {
    x: window.screenX,
    y: window.screenY,
    width: window.outerWidth,
    height: window.outerHeight
  }
  state.window.wasMaximized = remote.getCurrentWindow().isMaximized

  // Limit window size to screen size
  var screenWidth = window.screen.width
  var screenHeight = window.screen.height
  var aspectRatio = dimensions.width / dimensions.height
  var scaleFactor = Math.min(
    Math.min(screenWidth / dimensions.width, 1),
    Math.min(screenHeight / dimensions.height, 1)
  )
  var width = Math.max(
    Math.floor(dimensions.width * scaleFactor),
    config.WINDOW_MIN_WIDTH
  )
  var height = Math.max(
    Math.floor(dimensions.height * scaleFactor),
    config.WINDOW_MIN_HEIGHT
  )

  ipcRenderer.send('setAspectRatio', aspectRatio)
  ipcRenderer.send('setBounds', {x: null, y: null, width, height})
}

function restoreBounds () {
  ipcRenderer.send('setAspectRatio', 0)
  if (state.window.bounds) {
    ipcRenderer.send('setBounds', state.window.bounds, false)
  }
}

function showDoneNotification (torrent) {
  var notif = new window.Notification('Download Complete', {
    body: torrent.name,
    silent: true
  })

  notif.onclick = function () {
    ipcRenderer.send('focusWindow', 'main')
  }

  sound.play('DONE')
}

// Hide player controls while playing video, if the mouse stays still for a while
// Never hide the controls when:
// * The mouse is over the controls or we're scrubbing (see CSS)
// * The video is paused
// * The video is playing remotely on Chromecast or Airplay
function showOrHidePlayerControls () {
  var hideControls = state.location.current().url === 'player' &&
    state.playing.mouseStationarySince !== 0 &&
    new Date().getTime() - state.playing.mouseStationarySince > 2000 &&
    !state.playing.isPaused &&
    state.playing.location === 'local'

  if (hideControls !== state.playing.hideControls) {
    state.playing.hideControls = hideControls
    return true
  }
  return false
}

// Event handlers
function onError (err) {
  console.error(err.stack || err)
  sound.play('ERROR')
  state.errors.push({
    time: new Date().getTime(),
    message: err.message || err
  })
  update()
}

function onWarning (err) {
  console.log('warning: %s', err.message || err)
}

function onPaste (e) {
  if (e.target.tagName.toLowerCase() === 'input') return

  var torrentIds = clipboard.readText().split('\n')
  torrentIds.forEach(function (torrentId) {
    torrentId = torrentId.trim()
    if (torrentId.length === 0) return
    dispatch('addTorrent', torrentId)
  })
}

function onKeyDown (e) {
  if (e.which === 27) { /* ESC means either exit fullscreen or go back */
    if (state.modal) {
      dispatch('exitModal')
    } else if (state.window.isFullScreen) {
      dispatch('toggleFullScreen')
    } else {
      dispatch('back')
    }
  } else if (e.which === 32) { /* spacebar pauses or plays the video */
    dispatch('playPause')
  }
}

function onFocus (e) {
  state.window.isFocused = true
  state.dock.badge = 0
  update()
}

function onBlur () {
  state.window.isFocused = false
  update()
}
