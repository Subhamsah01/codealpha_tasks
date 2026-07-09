/* =========================================================
   Late Groove — Music Player logic (v2)
   Handles: playback, progress, volume, playlist, shuffle,
   repeat, autoplay, uploading local files, searching,
   removing tracks, error recovery and saved preferences.
   ========================================================= */

(() => {
  'use strict';

  /* ---------- Cover art generator (inline SVG, no network needed) ---
     Every track gets a unique, deterministic abstract cover derived
     from its title — no external image requests, so nothing to fail
     to load, and no two tracks look alike.
  ---------------------------------------------------------------- */
  const ART_PALETTE = ['#E7A339', '#C1502B', '#7C9082', '#8E6BAE', '#4E8FA6', '#C4785B'];

  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
    return h;
  }

  function generateCoverArt(seedText) {
    const h = hashString(seedText);
    const hue = ART_PALETTE[h % ART_PALETTE.length];
    const variant = h % 3;
    let shapes = '';
    if (variant === 0) {
      // concentric rings, vinyl-style
      shapes = `<circle cx="150" cy="150" r="95" fill="none" stroke="${hue}" stroke-width="2" opacity="0.5"/>
        <circle cx="150" cy="150" r="70" fill="none" stroke="${hue}" stroke-width="10"/>
        <circle cx="150" cy="150" r="18" fill="${hue}"/>`;
    } else if (variant === 1) {
      // soundwave bars
      const bars = [40, 90, 60, 110, 75, 50, 95, 65];
      shapes = bars.map((h2, i) => {
        const x = 60 + i * 24;
        return `<rect x="${x}" y="${150 - h2 / 2}" width="12" height="${h2}" rx="6" fill="${hue}" opacity="${0.55 + (i % 3) * 0.15}"/>`;
      }).join('');
    } else {
      // diagonal stripes
      shapes = `<circle cx="150" cy="150" r="95" fill="${hue}" opacity="0.12"/>` +
        Array.from({ length: 5 }).map((_, i) =>
          `<rect x="${20 + i * 30}" y="0" width="10" height="300" fill="${hue}" opacity="${0.18 + i * 0.06}" transform="rotate(24 150 150)"/>`
        ).join('');
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
      <rect width="300" height="300" fill="#1C1613"/>
      <clipPath id="c"><circle cx="150" cy="150" r="150"/></clipPath>
      <g clip-path="url(#c)">${shapes}</g>
    </svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  const DEFAULT_ART = generateCoverArt('Late Groove upload');

  /* ---------- Seed playlist -----------------------------------------
     NCS (NoCopyrightSounds) track list — real, full-length releases
     (not loops/clips) mirrored on the Internet Archive, which is
     CDN-backed and serves proper HTTP range requests, so seeking and
     buffering behave like a real streaming host.

     This is still a third-party mirror, not something you control —
     for a production site you'll still want to grab the originals
     yourself and host them on infrastructure you own:
       1. Go to https://ncs.io/music-search
       2. Open a track and use its "Free Download" button
          (or download from https://soundcloud.com/nocopyrightsounds)
       3. Host that file yourself — e.g. an /audio folder on your own
          server, or any bucket/CDN you control — and point `src` at it.
  ---------------------------------------------------------------- */
  let idCounter = 0;
  const nextId = () => 'trk_' + (++idCounter);

  const PLAYLIST = [
    { title: "On & On",    artist: "Cartoon ft. Daniel Levi",  src: "https://archive.org/download/encees/Cartoon%20-%20On%20%26%20On%20%28feat.%20Daniel%20Levi%29.mp3", duration: "3:27" },
    { title: "Sky High",   artist: "Elektronomia",             src: "https://archive.org/download/encees/Elektronomia%20-%20Sky%20High.mp3",                           duration: "3:38" },
    { title: "Firefly",    artist: "Jim Yosef",                src: "https://archive.org/download/encees/Jim%20Yosef%20-%20Firefly.mp3",                                duration: "3:03" },
    { title: "Mortals",    artist: "Warriyo ft. Laura Brehm",  src: "https://archive.org/download/encees/Warriyo%20-%20Mortals%20%28feat.%20Laura%20Brehm%29.mp3",       duration: "3:44" },
    { title: "Spectre",    artist: "Alan Walker",              src: "https://archive.org/download/encees/Alan%20Walker%20-%20Spectre.mp3",                              duration: "3:33" },
    { title: "Invincible", artist: "DEAF KEV",                 src: "https://archive.org/download/encees/DEAF%20KEV%20-%20Invincible.mp3",                              duration: "3:36" }
  ].map(t => ({ ...t, id: nextId(), art: generateCoverArt(t.title), isUpload: false, objectUrl: null }));

  /* ---------- State ---------------------------------------- */
  let currentId       = PLAYLIST.length ? PLAYLIST[0].id : null;
  let isPlaying        = false;
  let isShuffled        = false;
  let shuffleOrder       = PLAYLIST.map(t => t.id);
  let autoplayEnabled     = true;
  let repeatMode          = 'off';   // 'off' | 'all' | 'one'
  let isSeeking           = false;
  let isVolumeSeeking     = false;
  let previousVolume      = 0.7;
  let searchQuery         = '';
  let loadToken           = 0;   // guards against races when tracks change quickly
  let retriedCurrentTrack = false;
  let consecutiveFailures = 0;   // resets on any successful play; trips the stop-guard if every track fails in a row

  /* ---------- DOM refs --------------------------------------- */
  const audio            = document.getElementById('audio');
  audio.preload = 'auto'; // let the browser buffer aggressively instead of waiting until play() is called
  const playlistEl        = document.getElementById('playlist');
  const playlistPanel     = document.getElementById('playlistPanel');
  const queueCountEl      = document.getElementById('queueCount');
  const searchInput       = document.getElementById('searchInput');

  const addMusicBtn       = document.getElementById('addMusicBtn');
  const fileInput         = document.getElementById('fileInput');
  const dropOverlay       = document.getElementById('dropOverlay');

  const albumArt          = document.getElementById('albumArt');
  const trackTitleEl      = document.getElementById('trackTitle');
  const trackArtistEl     = document.getElementById('trackArtist');
  const trackEyebrow      = document.getElementById('trackEyebrow');

  const disc              = document.getElementById('disc');
  const discLoader        = document.getElementById('discLoader');
  const tonearm           = document.getElementById('tonearm');

  const currentTimeEl     = document.getElementById('currentTime');
  const durationEl        = document.getElementById('duration');
  const progressTrack     = document.getElementById('progressTrack');
  const progressFill      = document.getElementById('progressFill');
  const progressBuffer    = document.getElementById('progressBuffer');
  const progressHandle    = document.getElementById('progressHandle');

  const playBtn           = document.getElementById('playBtn');
  const playIcon          = document.getElementById('playIcon');
  const pauseIcon         = document.getElementById('pauseIcon');
  const prevBtn           = document.getElementById('prevBtn');
  const nextBtn           = document.getElementById('nextBtn');
  const shuffleToggle     = document.getElementById('shuffleToggle');
  const repeatBtn         = document.getElementById('repeatBtn');
  const autoplayToggle    = document.getElementById('autoplayToggle');

  const muteBtn           = document.getElementById('muteBtn');
  const volIcon           = document.getElementById('volIcon');
  const volumeTrack       = document.getElementById('volumeTrack');
  const volumeFill        = document.getElementById('volumeFill');
  const volumeHandle      = document.getElementById('volumeHandle');
  const volumeLabel       = document.getElementById('volumeLabel');

  const toastContainer    = document.getElementById('toastContainer');

  /* ---------- Small helpers ----------------------------------- */
  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function clamp(val, min, max) { return Math.min(Math.max(val, min), max); }

  function getTrackById(id) { return PLAYLIST.find(t => t.id === id) || null; }

  /* ---------- Prefetching -------------------------------------------
     The old version only started fetching a track's audio the moment
     you clicked it, so every switch paid the full network round-trip
     before playback could start. Instead, as soon as a track loads we
     quietly warm the browser's cache for whatever comes next (and
     prev), so by the time the listener actually clicks, most/all of
     the data is already local and playback starts immediately.
  ---------------------------------------------------------------- */
  const prefetchCache = new Map(); // id -> Audio element kept alive to hold the browser cache warm

  function prefetchTrack(id) {
    if (!id) return;
    const track = getTrackById(id);
    if (!track || track.isUpload) return;       // local blobs are already instant, nothing to prefetch
    if (prefetchCache.has(id)) return;           // already warming/warmed

    const pre = new Audio();
    pre.preload = 'auto';
    pre.src = track.src;
    pre.load();
    prefetchCache.set(id, pre);

    // Keep the cache from growing forever as someone browses a big playlist
    if (prefetchCache.size > 6) {
      const oldestId = prefetchCache.keys().next().value;
      const oldest = prefetchCache.get(oldestId);
      oldest.src = '';
      prefetchCache.delete(oldestId);
    }
  }

  function prefetchAdjacentTracks(id) {
    const savedCurrent = currentId;
    currentId = id; // getNextId/getPrevId read currentId, so borrow it briefly
    const next = getNextId();
    const prev = getPrevId();
    currentId = savedCurrent;
    prefetchTrack(next);
    prefetchTrack(prev);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showToast(message, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    toastContainer.appendChild(el);
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    }, 3200);
  }

  /* ---------- Preferences persistence -------------------------- */
  const PREF_KEY = 'lateGroove.prefs.v1';
  function savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        volume: audio.volume,
        muted: audio.muted,
        shuffle: isShuffled,
        repeat: repeatMode,
        autoplay: autoplayEnabled
      }));
    } catch (e) { /* storage unavailable — safe to ignore */ }
  }

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  /* ---------- Render playlist ----------------------------------- */
  function renderPlaylist() {
    const query = searchQuery.trim().toLowerCase();
    const visible = query
      ? PLAYLIST.filter(t => t.title.toLowerCase().includes(query) || t.artist.toLowerCase().includes(query))
      : PLAYLIST;

    playlistEl.innerHTML = '';

    if (PLAYLIST.length === 0) {
      playlistEl.innerHTML = `<li class="list-empty-state"><strong>No tracks yet</strong>Use "Add music" below to load your own audio files.</li>`;
    } else if (visible.length === 0) {
      playlistEl.innerHTML = `<li class="list-empty-state"><strong>No matches</strong>Try a different search term.</li>`;
    } else {
      visible.forEach(track => {
        const li = document.createElement('li');
        li.className = 'track-item' + (track.id === currentId ? ' active' : '');
        li.setAttribute('role', 'button');
        li.setAttribute('tabindex', '0');
        li.setAttribute('aria-label', `Play ${track.title} by ${track.artist}`);
        li.dataset.id = track.id;

        li.innerHTML = `
          <img class="track-thumb" src="${track.art}" alt="" loading="lazy">
          <div class="track-meta">
            <div class="track-name">${escapeHtml(track.title)}</div>
            <div class="track-artist-sm">${escapeHtml(track.artist)}</div>
          </div>
          <div class="eq-bars"><span></span><span></span><span></span></div>
          ${track.isUpload ? '<span class="upload-badge">local</span>' : ''}
          <span class="track-dur">${track.duration}</span>
          <button class="track-remove" title="Remove from playlist" aria-label="Remove ${escapeHtml(track.title)}">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        `;

        li.addEventListener('click', () => loadTrackById(track.id, true));
        li.addEventListener('mouseenter', () => prefetchTrack(track.id));
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); loadTrackById(track.id, true); }
        });

        li.querySelector('.track-remove').addEventListener('click', (e) => {
          e.stopPropagation();
          removeTrack(track.id);
        });

        playlistEl.appendChild(li);
      });
    }

    const total = PLAYLIST.length;
    queueCountEl.textContent = query
      ? `${visible.length} of ${total} track${total !== 1 ? 's' : ''}`
      : `${total} track${total !== 1 ? 's' : ''} queued`;

    updatePlaylistActiveState();
    updateTransportAvailability();
  }

  function updatePlaylistActiveState() {
    [...playlistEl.children].forEach(li => {
      if (!li.dataset) return;
      li.classList.toggle('active', li.dataset.id === currentId);
    });
    playlistPanel.classList.toggle('paused', !isPlaying);
  }

  function updateTransportAvailability() {
    const hasTracks = PLAYLIST.length > 0;
    const multiTrack = PLAYLIST.length > 1;
    playBtn.disabled = !hasTracks;
    prevBtn.disabled = !multiTrack;
    nextBtn.disabled = !multiTrack;
    shuffleToggle.disabled = !multiTrack;
    repeatBtn.disabled = !hasTracks;
    progressTrack.classList.toggle('disabled', !hasTracks);
  }

  /* ---------- Load / play / pause -------------------------------- */
  function loadTrackById(id, autoplay = false) {
    const track = getTrackById(id);
    if (!track) { showEmptyState(); return; }

    const token = ++loadToken;
    currentId = id;
    retriedCurrentTrack = false;

    // Smooth crossfade: fade the old art/title out, swap content, fade back in
    const stage = document.querySelector('.stage');
    stage.classList.add('track-switching');

    audio.src = track.src;
    audio.load();

    // Neighboring tracks are usually where the listener goes next —
    // start warming the browser cache for them right away.
    prefetchAdjacentTracks(id);

    setTimeout(() => {
      if (token !== loadToken) return; // a newer track was requested meanwhile
      albumArt.src = track.art;
      trackTitleEl.textContent = track.title;
      trackArtistEl.textContent = track.artist;
      durationEl.textContent = track.duration;
      progressFill.style.width = '0%';
      progressBuffer.style.width = '0%';
      progressHandle.style.left = '0%';
      progressTrack.setAttribute('aria-valuenow', '0');
      currentTimeEl.textContent = '0:00';
      stage.classList.remove('track-switching');
    }, 120);

    trackEyebrow.textContent = autoplay ? 'Now Playing' : 'Paused';
    updatePlaylistActiveState();

    if (autoplay) play(token); else pause();
  }

  function showEmptyState() {
    loadToken++;
    currentId = null;
    audio.removeAttribute('src');
    audio.load();
    albumArt.src = DEFAULT_ART;
    trackTitleEl.textContent = 'No track loaded';
    trackArtistEl.textContent = 'Add music to get started';
    trackEyebrow.textContent = 'Idle';
    durationEl.textContent = '0:00';
    currentTimeEl.textContent = '0:00';
    progressFill.style.width = '0%';
    progressBuffer.style.width = '0%';
    progressHandle.style.left = '0%';
    isPlaying = false;
    playIcon.style.display = '';
    pauseIcon.style.display = 'none';
    disc.classList.remove('spinning');
    tonearm.classList.remove('playing');
    discLoader.classList.remove('visible');
    updatePlaylistActiveState();
    updateTransportAvailability();
  }

  function play(token) {
    if (!audio.src) return;
    const myToken = token !== undefined ? token : loadToken;
    const p = audio.play();
    if (p && p.catch) {
      p.then(() => { if (myToken === loadToken) onPlayStarted(); })
       .catch((err) => {
          if (myToken !== loadToken) return;      // superseded by a newer track — expected, ignore
          if (err && err.name === 'AbortError') return; // interrupted by a new load/pause — expected, ignore
          if (err && err.name === 'NotAllowedError') return; // needs a user gesture first — ignore quietly
          showToast('Playback was blocked — try pressing play again', 'error');
        });
    } else {
      onPlayStarted();
    }
  }

  function onPlayStarted() {
    isPlaying = true;
    consecutiveFailures = 0;
    playIcon.style.display = 'none';
    pauseIcon.style.display = '';
    playBtn.title = 'Pause';
    disc.classList.add('spinning');
    tonearm.classList.add('playing');
    if (!discLoader.classList.contains('visible')) trackEyebrow.textContent = 'Now Playing';
    updatePlaylistActiveState();
  }

  function pause() {
    audio.pause();
    isPlaying = false;
    playIcon.style.display = '';
    pauseIcon.style.display = 'none';
    playBtn.title = 'Play';
    disc.classList.remove('spinning');
    tonearm.classList.remove('playing');
    discLoader.classList.remove('visible');
    if (currentId) trackEyebrow.textContent = 'Paused';
    updatePlaylistActiveState();
  }

  function togglePlay() {
    if (!currentId) {
      if (PLAYLIST.length) loadTrackById(PLAYLIST[0].id, true);
      return;
    }
    isPlaying ? pause() : play();
  }

  /* ---------- Shuffle / repeat order helpers ----------------------- */
  function rebuildShuffleOrder() {
    shuffleOrder = PLAYLIST.map(t => t.id);
    for (let i = shuffleOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffleOrder[i], shuffleOrder[j]] = [shuffleOrder[j], shuffleOrder[i]];
    }
    if (currentId) {
      const pos = shuffleOrder.indexOf(currentId);
      if (pos > -1) {
        shuffleOrder.splice(pos, 1);
        shuffleOrder.unshift(currentId);
      }
    }
  }

  function getOrder() {
    return isShuffled ? shuffleOrder : PLAYLIST.map(t => t.id);
  }

  function getNextId() {
    const order = getOrder();
    if (!order.length) return null;
    const pos = order.indexOf(currentId);
    const next = pos + 1;
    if (next >= order.length) return repeatMode === 'all' ? order[0] : null;
    return order[next];
  }

  function getPrevId() {
    const order = getOrder();
    if (!order.length) return null;
    const pos = order.indexOf(currentId);
    const prev = pos - 1;
    if (prev < 0) return repeatMode === 'all' ? order[order.length - 1] : order[0];
    return order[prev];
  }

  function playNext() {
    const next = getNextId();
    if (next === null) { pause(); return; }
    loadTrackById(next, true);
  }

  function playPrev() {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    const prev = getPrevId();
    if (prev === null) return;
    loadTrackById(prev, true);
  }

  /* ---------- Add / remove tracks ---------------------------------- */
  function addFiles(fileList) {
    const files = [...fileList].filter(f => f.type.startsWith('audio/'));
    if (!files.length) {
      showToast('No audio files found in that selection', 'error');
      return;
    }

    const wasEmpty = PLAYLIST.length === 0;

    files.forEach(file => {
      const objectUrl = URL.createObjectURL(file);
      const track = {
        id: nextId(),
        title: file.name.replace(/\.[^/.]+$/, ''),
        artist: 'Local upload',
        src: objectUrl,
        art: DEFAULT_ART,
        duration: '--:--',
        isUpload: true,
        objectUrl
      };
      PLAYLIST.push(track);
      if (isShuffled) shuffleOrder.push(track.id);

      // Read real duration without disturbing current playback
      const probe = new Audio();
      probe.preload = 'metadata';
      probe.src = objectUrl;
      probe.addEventListener('loadedmetadata', () => {
        track.duration = formatTime(probe.duration);
        if (track.id === currentId) durationEl.textContent = track.duration;
        renderPlaylist();
      });
      probe.addEventListener('error', () => {
        track.duration = '—';
        renderPlaylist();
      });
    });

    renderPlaylist();
    showToast(`Added ${files.length} track${files.length !== 1 ? 's' : ''} to the playlist`);

    if (wasEmpty && PLAYLIST.length) {
      loadTrackById(PLAYLIST[0].id, false);
    }
  }

  function removeTrack(id) {
    const index = PLAYLIST.findIndex(t => t.id === id);
    if (index === -1) return;
    const [removed] = PLAYLIST.splice(index, 1);
    if (removed.objectUrl) URL.revokeObjectURL(removed.objectUrl);
    shuffleOrder = shuffleOrder.filter(sid => sid !== id);

    if (id === currentId) {
      const wasPlaying = isPlaying;
      if (PLAYLIST.length === 0) {
        showEmptyState();
      } else {
        const nextIndex = clamp(index, 0, PLAYLIST.length - 1);
        loadTrackById(PLAYLIST[nextIndex].id, wasPlaying);
      }
    }

    renderPlaylist();
    showToast(`Removed "${removed.title}"`);
  }

  /* ---------- Progress bar --------------------------------------- */
  audio.addEventListener('timeupdate', () => {
    if (isSeeking) return;
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    progressFill.style.width = pct + '%';
    progressHandle.style.left = pct + '%';
    progressTrack.setAttribute('aria-valuenow', Math.round(pct));
    currentTimeEl.textContent = formatTime(audio.currentTime);
  });

  audio.addEventListener('loadedmetadata', () => {
    if (isFinite(audio.duration)) durationEl.textContent = formatTime(audio.duration);
  });

  audio.addEventListener('progress', () => {
    if (audio.buffered.length && audio.duration) {
      const end = audio.buffered.end(audio.buffered.length - 1);
      progressBuffer.style.width = ((end / audio.duration) * 100) + '%';
    }
  });

  audio.addEventListener('waiting', () => {
    discLoader.classList.add('visible');
    if (isPlaying) trackEyebrow.textContent = 'Buffering…';
  });
  audio.addEventListener('playing', () => {
    discLoader.classList.remove('visible');
    if (isPlaying) trackEyebrow.textContent = 'Now Playing';
  });
  audio.addEventListener('canplay', () => discLoader.classList.remove('visible'));

  audio.addEventListener('error', () => {
    if (!currentId) return; // no track loaded — nothing to recover
    const code = audio.error && audio.error.code;
    // Code 1 (MEDIA_ERR_ABORTED) just means a newer load superseded this
    // one — completely normal when skipping tracks quickly, not a failure.
    if (code === 1) return;

    discLoader.classList.remove('visible');
    const token = loadToken;
    const track = getTrackById(currentId);

    if (!retriedCurrentTrack) {
      // Transient network hiccups are common — try once more before giving up.
      retriedCurrentTrack = true;
      setTimeout(() => {
        if (token !== loadToken || !track) return;
        audio.load();
        play(token);
      }, 600);
      return;
    }

    consecutiveFailures++;
    if (consecutiveFailures >= PLAYLIST.length && PLAYLIST.length > 0) {
      // Every track in the list has now failed in a row — the files
      // themselves are almost certainly unreachable (bad URL, not
      // hosted yet, CORS, etc). Stop instead of skipping forever.
      showToast('Playback stopped — none of these tracks could load. Check the audio file URLs.', 'error');
      pause();
      consecutiveFailures = 0;
      return;
    }

    showToast(`Couldn't play "${track ? track.title : 'this track'}" — skipping`, 'error');
    setTimeout(() => {
      if (token !== loadToken) return;
      if (PLAYLIST.length > 1) playNext(); else pause();
    }, 700);
  });

  audio.addEventListener('ended', () => {
    if (repeatMode === 'one') { audio.currentTime = 0; play(); return; }
    if (autoplayEnabled) playNext(); else pause();
  });

  function seekToClientX(clientX) {
    if (!audio.duration) return;
    const rect = progressTrack.getBoundingClientRect();
    const pct = clamp((clientX - rect.left) / rect.width, 0, 1);
    audio.currentTime = pct * audio.duration;
    progressFill.style.width = (pct * 100) + '%';
    progressHandle.style.left = (pct * 100) + '%';
    progressTrack.setAttribute('aria-valuenow', Math.round(pct * 100));
    currentTimeEl.textContent = formatTime(pct * audio.duration);
  }

  progressTrack.addEventListener('pointerdown', (e) => {
    if (!audio.duration) return;
    isSeeking = true;
    seekToClientX(e.clientX);
    progressTrack.setPointerCapture(e.pointerId);
  });
  progressTrack.addEventListener('pointermove', (e) => { if (isSeeking) seekToClientX(e.clientX); });
  ['pointerup', 'pointercancel'].forEach(evt =>
    progressTrack.addEventListener(evt, () => { isSeeking = false; })
  );
  progressTrack.addEventListener('keydown', (e) => {
    if (!audio.duration) return;
    const step = 5;
    if (e.key === 'ArrowRight') audio.currentTime = Math.min(audio.currentTime + step, audio.duration);
    if (e.key === 'ArrowLeft')  audio.currentTime = Math.max(audio.currentTime - step, 0);
  });

  /* ---------- Volume control --------------------------------------- */
  function setVolume(vol, { persist = true } = {}) {
    vol = clamp(vol, 0, 1);
    audio.volume = vol;
    audio.muted = vol === 0;
    volumeFill.style.width = (vol * 100) + '%';
    volumeHandle.style.left = (vol * 100) + '%';
    volumeLabel.textContent = Math.round(vol * 100) + '%';
    volumeTrack.setAttribute('aria-valuenow', Math.round(vol * 100));
    updateVolumeIcon(vol);
    if (vol > 0) previousVolume = vol;
    if (persist) savePrefs();
  }

  function updateVolumeIcon(vol) {
    if (vol === 0) {
      volIcon.innerHTML = '<path fill="currentColor" d="M3 10v4h4l5 5V5L7 10H3zm12.59 2 2.7-2.7-1.42-1.42L14.17 10l-2.7-2.7-1.42 1.42L12.76 11l-2.7 2.7 1.42 1.42 2.7-2.7 2.7 2.7 1.42-1.42z"/>';
    } else if (vol < 0.5) {
      volIcon.innerHTML = '<path fill="currentColor" d="M3 10v4h4l5 5V5L7 10H3zm11 2a3 3 0 0 0-1.5-2.6v5.2A3 3 0 0 0 14 12z"/>';
    } else {
      volIcon.innerHTML = '<path fill="currentColor" d="M3 10v4h4l5 5V5L7 10H3zm13.5 2A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
    }
  }

  function seekVolumeToClientX(clientX) {
    const rect = volumeTrack.getBoundingClientRect();
    setVolume(clamp((clientX - rect.left) / rect.width, 0, 1));
  }

  volumeTrack.addEventListener('pointerdown', (e) => {
    isVolumeSeeking = true;
    seekVolumeToClientX(e.clientX);
    volumeTrack.setPointerCapture(e.pointerId);
  });
  volumeTrack.addEventListener('pointermove', (e) => { if (isVolumeSeeking) seekVolumeToClientX(e.clientX); });
  ['pointerup', 'pointercancel'].forEach(evt =>
    volumeTrack.addEventListener(evt, () => { isVolumeSeeking = false; })
  );
  volumeTrack.addEventListener('keydown', (e) => {
    const step = 0.05;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp')   setVolume(audio.volume + step);
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowDown')  setVolume(audio.volume - step);
  });

  muteBtn.addEventListener('click', () => {
    if (audio.volume > 0) { previousVolume = audio.volume; setVolume(0); }
    else { setVolume(previousVolume || 0.7); }
  });

  /* ---------- Transport button events -------------------------------- */
  playBtn.addEventListener('click', togglePlay);
  nextBtn.addEventListener('click', playNext);
  prevBtn.addEventListener('click', playPrev);

  shuffleToggle.addEventListener('click', () => {
    isShuffled = !isShuffled;
    shuffleToggle.setAttribute('aria-pressed', String(isShuffled));
    if (isShuffled) rebuildShuffleOrder();
    showToast(isShuffled ? 'Shuffle on' : 'Shuffle off');
    savePrefs();
  });

  function applyRepeatUI() {
    repeatBtn.setAttribute('aria-pressed', String(repeatMode !== 'off'));
    repeatBtn.title = repeatMode === 'off' ? 'Repeat: off'
                      : repeatMode === 'all' ? 'Repeat: all tracks'
                      : 'Repeat: current track';
    repeatBtn.style.color = repeatMode === 'one' ? 'var(--accent-2)'
                            : repeatMode === 'all' ? 'var(--accent)'
                            : '';
  }

  repeatBtn.addEventListener('click', () => {
    repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
    applyRepeatUI();
    savePrefs();
  });

  function applyAutoplayUI() {
    autoplayToggle.setAttribute('aria-pressed', String(autoplayEnabled));
    autoplayToggle.title = autoplayEnabled ? 'Autoplay: on' : 'Autoplay: off';
    autoplayToggle.style.color = autoplayEnabled ? 'var(--accent)' : '';
  }

  autoplayToggle.addEventListener('click', () => {
    autoplayEnabled = !autoplayEnabled;
    applyAutoplayUI();
    savePrefs();
  });

  /* ---------- Search ---------------------------------------------- */
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderPlaylist();
  });

  /* ---------- Upload: button, file input, drag & drop --------------- */
  addMusicBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) addFiles(e.target.files);
    fileInput.value = ''; // allow re-selecting the same file later
  });

  let dragDepth = 0;
  playlistPanel.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    playlistPanel.classList.add('drag-active');
  });
  playlistPanel.addEventListener('dragover', (e) => e.preventDefault());
  playlistPanel.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) playlistPanel.classList.remove('drag-active');
  });
  playlistPanel.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    playlistPanel.classList.remove('drag-active');
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  /* ---------- Keyboard shortcuts ------------------------------------ */
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA';
    if (typing) return;

    if (e.code === 'Space' && document.activeElement !== progressTrack && document.activeElement !== volumeTrack) {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowRight' && document.activeElement !== progressTrack && document.activeElement !== volumeTrack) {
      playNext();
    } else if (e.key === 'ArrowLeft' && document.activeElement !== progressTrack && document.activeElement !== volumeTrack) {
      playPrev();
    } else if (e.key.toLowerCase() === 'm') {
      muteBtn.click();
    } else if (e.key.toLowerCase() === 's') {
      if (!shuffleToggle.disabled) shuffleToggle.click();
    } else if (e.key.toLowerCase() === 'r') {
      repeatBtn.click();
    }
  });

  /* ---------- Init ------------------------------------------------------ */
  function init() {
    const prefs = loadPrefs();
    if (prefs) {
      isShuffled = !!prefs.shuffle;
      repeatMode = prefs.repeat || 'off';
      autoplayEnabled = prefs.autoplay !== false;
      shuffleToggle.setAttribute('aria-pressed', String(isShuffled));
      if (isShuffled) rebuildShuffleOrder();
    }
    applyRepeatUI();
    applyAutoplayUI();

    renderPlaylist();
    setVolume(prefs && typeof prefs.volume === 'number' ? prefs.volume : 0.7, { persist: false });

    if (PLAYLIST.length) {
      loadTrackById(PLAYLIST[0].id, false);
    } else {
      showEmptyState();
    }
  }

  init();
})();