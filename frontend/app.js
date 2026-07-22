/* global LivekitClient */
(() => {
  const {
    Room,
    RoomEvent,
    Track,
    ConnectionState,
  } = LivekitClient;

  const el = (id) => document.getElementById(id);

  const dom = {
    lkUrl: el('lkUrl'),
    lkToken: el('lkToken'),
    connectBtn: el('connectBtn'),
    disconnectBtn: el('disconnectBtn'),
    muteToggle: el('muteToggle'),
    linkStatusDot: el('linkStatusDot'),
    linkStatusText: el('linkStatusText'),
    speakerState: el('speakerState'),
    transcript: el('transcript'),
    clearBtn: el('clearBtn'),
    humorValue: el('humorValue'),
    humorBar: el('humorBar'),
    honestyValue: el('honestyValue'),
    honestyBar: el('honestyBar'),
    visualizer: el('visualizer'),
    micLevelBar: el('micLevelBar'),
    micLevelLabel: el('micLevelLabel'),
  };

  let room = null;
  let audioCtx = null;
  let analyser = null;
  let analyserSource = null;
  let vizRAF = null;
  let micAnalyser = null;
  let micSource = null;
  let micStream = null;

  // ---- persisted connection fields (memory-only by default) ----
  try {
    const savedUrl = sessionStorage.getItem('tars_lk_url');
    if (savedUrl) dom.lkUrl.value = savedUrl;
  } catch (_) { /* storage unavailable */ }

  // ---- optional local dev config (frontend/config.local.js, gitignored) ----
  // Lets you skip hand-typing/pasting a token during local development.
  if (window.TARS_CONFIG) {
    if (window.TARS_CONFIG.url && !dom.lkUrl.value) dom.lkUrl.value = window.TARS_CONFIG.url;
    if (window.TARS_CONFIG.token) dom.lkToken.value = window.TARS_CONFIG.token;
  }

  function setLinkState(state) {
    dom.linkStatusDot.classList.remove('live', 'err', 'speaking');
    if (state === 'connected') {
      dom.linkStatusDot.classList.add('live');
      dom.linkStatusText.textContent = 'LINK: ESTABLISHED';
    } else if (state === 'connecting') {
      dom.linkStatusText.textContent = 'LINK: NEGOTIATING...';
    } else if (state === 'error') {
      dom.linkStatusDot.classList.add('err');
      dom.linkStatusText.textContent = 'LINK: FAULT';
    } else {
      dom.linkStatusText.textContent = 'LINK: OFFLINE';
    }
  }

  function setSpeakerState(text) {
    dom.speakerState.textContent = text;
  }

  function appendLine(kind, tag, text) {
    const wrap = document.createElement('div');
    wrap.className = `line-${kind}`;
    wrap.innerHTML =
      `<span class="line-tag hud-font text-[10px] tracking-wider">${tag}</span> ` +
      `<span class="line-text">${escapeHtml(text)}</span>`;
    dom.transcript.appendChild(wrap);
    dom.transcript.scrollTop = dom.transcript.scrollHeight;
    return wrap;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  const liveSegments = new Map(); // segmentId -> DOM element (for streaming transcript updates)

  function upsertTranscriptSegment(id, kind, tag, text) {
    let node = liveSegments.get(id);
    if (!node) {
      node = appendLine(kind, tag, text);
      liveSegments.set(id, node);
    } else {
      node.querySelector('.line-text').textContent = text;
      dom.transcript.scrollTop = dom.transcript.scrollHeight;
    }
  }

  function updateParams(humor, honesty) {
    if (typeof humor === 'number') {
      dom.humorValue.textContent = `${humor}%`;
      dom.humorBar.style.width = `${humor}%`;
    }
    if (typeof honesty === 'number') {
      dom.honestyValue.textContent = `${honesty}%`;
      dom.honestyBar.style.width = `${honesty}%`;
    }
  }

  // ---------------- Audio visualizer (agent output) ----------------

  function ensureAudioContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }

  function bindVisualizerToTrack(mediaStreamTrack) {
    const ctx = ensureAudioContext();
    if (analyserSource) {
      try { analyserSource.disconnect(); } catch (_) {}
    }
    const stream = new MediaStream([mediaStreamTrack]);
    analyserSource = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyserSource.connect(analyser);
    if (!vizRAF) drawVisualizer();
  }

  function drawVisualizer() {
    const canvas = dom.visualizer;
    const ctx2d = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 400;
    const cssH = canvas.clientHeight || 140;
    if (canvas.width !== cssW * dpr) canvas.width = cssW * dpr;
    if (canvas.height !== cssH * dpr) canvas.height = cssH * dpr;

    function frame() {
      vizRAF = requestAnimationFrame(frame);
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, cssW, cssH);

      let data = null;
      if (analyser) {
        data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
      }

      const barCount = 32;
      const gap = 3;
      const barWidth = (cssW - gap * (barCount - 1)) / barCount;

      for (let i = 0; i < barCount; i++) {
        let v = 0;
        if (data) {
          const idx = Math.floor((i / barCount) * data.length);
          v = data[idx] / 255;
        }
        const barH = Math.max(2, v * cssH);
        const x = i * (barWidth + gap);
        const y = cssH - barH;
        ctx2d.fillStyle = 'rgba(255, 176, 0, 0.85)';
        ctx2d.shadowColor = 'rgba(255, 176, 0, 0.6)';
        ctx2d.shadowBlur = 6;
        ctx2d.fillRect(x, y, barWidth, barH);
      }
    }
    frame();
  }

  // ---------------- Mic level meter ----------------

  async function bindMicMeter(mediaStreamTrack) {
    const ctx = ensureAudioContext();
    if (micSource) {
      try { micSource.disconnect(); } catch (_) {}
    }
    micStream = new MediaStream([mediaStreamTrack]);
    micSource = ctx.createMediaStreamSource(micStream);
    micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 256;
    micSource.connect(micAnalyser);
    updateMicMeter();
  }

  function updateMicMeter() {
    if (!micAnalyser) return;
    const data = new Uint8Array(micAnalyser.frequencyBinCount);
    micAnalyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    const pct = Math.min(100, Math.round(rms * 300));
    dom.micLevelBar.style.width = `${pct}%`;
    dom.micLevelLabel.textContent = `${pct}%`;
    requestAnimationFrame(updateMicMeter);
  }

  // ---------------- LiveKit wiring ----------------

  function wireRoomEvents(r) {
    r.on(RoomEvent.ConnectionStateChanged, (state) => {
      if (state === ConnectionState.Connected) setLinkState('connected');
      else if (state === ConnectionState.Connecting || state === ConnectionState.Reconnecting) setLinkState('connecting');
      else if (state === ConnectionState.Disconnected) setLinkState('offline');
      else setLinkState('error');
    });

    r.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind === Track.Kind.Audio) {
        const audioEl = track.attach();
        audioEl.autoplay = true;
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);
        try {
          bindVisualizerToTrack(track.mediaStreamTrack);
        } catch (e) {
          console.warn('visualizer bind failed', e);
        }
        appendLine('sys', 'SYS', `Audio track subscribed from ${participant.identity}.`);
      }
    });

    r.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((elm) => elm.remove());
    });

    r.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (topic !== 'tars-settings') return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg && msg.type === 'tars_settings') {
          updateParams(msg.humor, msg.honesty);
        }
      } catch (e) {
        console.warn('bad data payload', e);
      }
    });

    // Agent speaking/listening/thinking state, published as a participant attribute
    // by the LiveKit Agents framework (lk.agent.state).
    const readAgentState = (participant) => {
      const state = participant?.attributes?.['lk.agent.state'];
      if (state) setSpeakerState(state.toUpperCase());
    };
    r.on(RoomEvent.ParticipantAttributesChanged, (_changed, participant) => {
      readAgentState(participant);
    });
    r.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const agentSpeaking = speakers.some((p) => p.identity !== r.localParticipant.identity);
      if (agentSpeaking) setSpeakerState('SPEAKING');
    });

    // Realtime transcription text streams (agent + user captions), topic "lk.transcription".
    if (typeof r.registerTextStreamHandler === 'function') {
      try {
        r.registerTextStreamHandler('lk.transcription', async (reader, participantInfo) => {
          const isLocal = participantInfo?.identity === r.localParticipant?.identity;
          const tag = isLocal ? 'YOU' : 'TARS';
          const kind = isLocal ? 'user' : 'tars';
          const segId = reader.info?.id || `${tag}-${Date.now()}`;
          let text = '';
          try {
            for await (const chunk of reader) {
              text += chunk;
              upsertTranscriptSegment(segId, kind, tag, text);
            }
          } catch (e) {
            console.warn('transcription stream error', e);
          }
        });
      } catch (e) {
        console.warn('registerTextStreamHandler unavailable', e);
      }
    }

    // Legacy fallback event some SDK versions still emit for STT segments.
    r.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
      const isLocal = participant?.identity === r.localParticipant?.identity;
      const tag = isLocal ? 'YOU' : 'TARS';
      const kind = isLocal ? 'user' : 'tars';
      segments.forEach((seg) => {
        upsertTranscriptSegment(seg.id, kind, tag, seg.text);
      });
    });

    r.on(RoomEvent.Disconnected, () => {
      setLinkState('offline');
      setSpeakerState('IDLE');
      appendLine('sys', 'SYS', 'Disconnected.');
      teardownAudio();
      dom.connectBtn.disabled = false;
      dom.disconnectBtn.disabled = true;
    });
  }

  function teardownAudio() {
    if (vizRAF) {
      cancelAnimationFrame(vizRAF);
      vizRAF = null;
    }
    analyser = null;
    if (analyserSource) {
      try { analyserSource.disconnect(); } catch (_) {}
      analyserSource = null;
    }
    if (micSource) {
      try { micSource.disconnect(); } catch (_) {}
      micSource = null;
    }
    micAnalyser = null;
  }

  async function connect() {
    const url = dom.lkUrl.value.trim();
    const token = dom.lkToken.value.trim();
    if (!url || !token) {
      appendLine('sys', 'SYS', 'LiveKit URL and access token are both required.');
      return;
    }
    try {
      sessionStorage.setItem('tars_lk_url', url);
    } catch (_) { /* ignore */ }

    dom.connectBtn.disabled = true;
    setLinkState('connecting');
    liveSegments.clear();
    dom.transcript.innerHTML = '';

    room = new Room({ adaptiveStream: true, dynacast: true });
    wireRoomEvents(room);

    try {
      await room.connect(url, token);
      await room.localParticipant.setMicrophoneEnabled(true);

      const micPub = room.localParticipant.getTrackPublication
        ? room.localParticipant.getTrackPublication(Track.Source.Microphone)
        : null;
      const micTrack = micPub?.track || [...room.localParticipant.audioTrackPublications.values()]
        .find((p) => p.source === Track.Source.Microphone)?.track;
      if (micTrack?.mediaStreamTrack) {
        bindMicMeter(micTrack.mediaStreamTrack);
      }

      appendLine('sys', 'SYS', `Connected as ${room.localParticipant.identity}.`);
      dom.disconnectBtn.disabled = false;
    } catch (err) {
      console.error(err);
      setLinkState('error');
      appendLine('sys', 'SYS', `Connection failed: ${err.message || err}`);
      // room.connect() may have already succeeded before a later step (e.g. mic
      // permission) failed — tear it down fully so we don't leak a live connection
      // with no way to reach it from the UI.
      if (room) {
        try { await room.disconnect(); } catch (_) {}
        room = null;
      }
      teardownAudio();
      dom.connectBtn.disabled = false;
      dom.disconnectBtn.disabled = true;
    }
  }

  async function disconnect() {
    if (room) {
      await room.disconnect();
      room = null;
    }
  }

  dom.connectBtn.addEventListener('click', connect);
  dom.disconnectBtn.addEventListener('click', disconnect);

  dom.muteToggle.addEventListener('change', () => {
    if (room) {
      room.localParticipant.setMicrophoneEnabled(!dom.muteToggle.checked);
    }
  });

  dom.clearBtn.addEventListener('click', () => {
    dom.transcript.innerHTML = '';
    liveSegments.clear();
  });

  window.addEventListener('beforeunload', () => {
    if (room) room.disconnect();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('sw register failed', e));
    });
  }
})();
