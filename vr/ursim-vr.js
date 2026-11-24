// UrSim VR mod: play the BIOBUZZ simulator from the driver station in a VR headset (WebXR).
// - Puts you behind your alliance wall at real scale, head-tracked.
// - Drive with a real gamepad (PS4 / PS5 / F310, Xbox is relabelled so the game accepts it)
//   or with the Quest Touch controllers (mapped to a virtual gamepad).
// - Floating scoreboard with score and match clock.
(() => {
  'use strict';
  const TAG = '[UrSim VR]';

  // ---------------------------------------------------------------- gamepads
  let xrSession = null;
  let xrActive = false;
  let virtLive = false;
  const virt = {
    id: 'Wireless Controller (Quest Touch)', index: 3, connected: true, mapping: 'standard',
    timestamp: 0, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  const nativeGet = typeof navigator.getGamepads === 'function'
    ? navigator.getGamepads.bind(navigator) : () => [];
  const supported = id => /dualsense|dualshock|wireless controller|f310|dual action|vendor:\s*(054c|046d)/i.test(id || '');
  const relabelled = new Map();
  function relabel(g) {
    // The game only accepts PS4/PS5/F310. A standard-mapped pad (e.g. Xbox) has the same layout,
    // so present it under a name the game recognises as a PS4 pad.
    let r = relabelled.get(g.index);
    if (!r) { r = {}; relabelled.set(g.index, r); }
    r.id = 'Wireless Controller (' + g.id.replace(/vendor[^)]*|[0-9a-f]{4}-[0-9a-f]{4}-/gi, '').trim() + ')';
    r.index = g.index; r.connected = g.connected; r.mapping = 'standard';
    r.timestamp = g.timestamp; r.axes = g.axes; r.buttons = g.buttons;
    return r;
  }
  // Input mode: 'auto' (gamepad if one is connected, otherwise Quest controllers),
  // 'pad' (gamepad only, Quest controllers ignored), 'touch' (Quest controllers only).
  const MODES = ['auto', 'pad', 'touch'];
  let inputMode = 'auto';
  try { const m = localStorage.getItem('ursimvr.input'); if (MODES.includes(m)) inputMode = m; } catch (_) {}
  let realPadName = '';
  const isXrPad = g => g.mapping === 'xr-standard' || /oculus|meta quest|touch|openxr|quest/i.test(g.id || '');
  function getGamepads() {
    const src = nativeGet() || [];
    const out = [];
    let hasReal = false;
    realPadName = '';
    for (let i = 0; i < src.length; i++) {
      const g = src[i];
      // Quest controllers are read separately (pollTouch); in 'touch' mode ordinary pads are hidden.
      if (!g || !g.connected || isXrPad(g) || inputMode === 'touch') { out.push(null); continue; }
      // Any ordinary gamepad counts (Bluetooth pad on the Quest, or a pad on the PC).
      hasReal = true;
      if (!realPadName) realPadName = g.id.replace(/\(.*\)/, '').trim() || 'gamepad';
      out.push(supported(g.id) && g.mapping === 'standard' ? g : relabel(g));
    }
    const useTouch = virtLive && (inputMode === 'touch' || (inputMode === 'auto' && !hasReal));
    if (useTouch) {
      virt.index = Math.max(3, out.length);
      while (out.length < virt.index) out.push(null);
      out[virt.index] = virt;
    }
    activeInput = hasReal && inputMode !== 'touch' ? 'pad' : (useTouch ? 'touch' : 'none');
    return out;
  }
  let activeInput = 'none';
  function inputStatus() {
    if (activeInput === 'pad') return 'Управление: геймпад ' + realPadName.slice(0, 28);
    if (activeInput === 'touch') return inputMode === 'touch' ? 'Управление: контроллеры Quest' : 'Контроллеры Quest · геймпад не найден (нажми на нём кнопку)';
    return inputMode === 'pad' ? 'Геймпад не найден: нажми на нём любую кнопку' : '';
  }
  try { Object.defineProperty(navigator, 'getGamepads', { value: getGamepads, configurable: true }); }
  catch (e) { navigator.getGamepads = getGamepads; }

  function pollTouch() {
    if (!xrSession) { virtLive = false; return; }
    let L = null, R = null;
    for (const s of xrSession.inputSources) {
      if (!s.gamepad) continue;
      if (s.handedness === 'left') L = s.gamepad; else if (s.handedness === 'right') R = s.gamepad;
    }
    if (!L && !R) { virtLive = false; return; }
    virtLive = true;
    const bv = (gp, i) => { const b = gp && gp.buttons[i]; return b ? Math.max(b.value, b.pressed ? 1 : 0) : 0; };
    const stick = (gp, k) => { if (!gp) return 0; const a = gp.axes; const v = a.length >= 4 ? a[2 + k] : (a[k] || 0); return Math.abs(v) < 0.08 ? 0 : v; };
    const set = (i, v) => { const b = virt.buttons[i]; b.value = v; b.pressed = v > 0.5; b.touched = v > 0; };
    virt.axes[0] = stick(L, 0); virt.axes[1] = stick(L, 1);
    virt.axes[2] = stick(R, 0); virt.axes[3] = stick(R, 1);
    const lStick = bv(L, 3), rStick = bv(R, 3);
    const both = lStick > 0.5 && rStick > 0.5;
    set(0, bv(R, 4));            // A  <- A
    set(1, bv(R, 5));            // B  <- B
    set(2, bv(L, 4));            // X  <- X
    set(3, bv(L, 5));            // Y  <- Y
    set(4, bv(L, 1));            // left bumper  <- left grip
    set(5, bv(R, 1));            // right bumper <- right grip
    set(6, bv(L, 0));            // left trigger
    set(7, bv(R, 0));            // right trigger
    set(10, both ? 0 : lStick);  // left stick button (slow mode)
    set(11, 0);
    set(13, both ? 0 : rStick);  // dpad down (eject) <- right stick click
    set(16, both ? 1 : 0);       // guide (pause)  <- both stick clicks
    virt.timestamp = performance.now();
  }

  // ---------------------------------------------------------------- VR
  function waitApp(cb) {
    const id = setInterval(() => {
      if (window.__ursim && window.__ursim.renderer && window.__ursim.effects) { clearInterval(id); cb(window.__ursim); }
    }, 200);
  }

  waitApp(app => {
    const T = window.__URSIM_THREE;
    if (!T) { console.warn(TAG, 'three.js classes not available; VR disabled'); return; }
    const renderer = app.renderer;

    // Dolly: the tracking-space origin, placed at the driver station.
    const dolly = new T.Group();
    dolly.name = 'vr-dolly';
    const xrCam = new T.PerspectiveCamera(70, 1, 0.03, 80);
    dolly.add(xrCam);

    // Scoreboard panel
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 300;
    const ctx = canvas.getContext('2d');
    const tex = new T.CanvasTexture(canvas);
    tex.colorSpace = 'srgb';
    const panel = new T.Mesh(new T.PlaneGeometry(1.8, 1.8 * 300 / 1024),
      new T.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
    panel.rotation.order = 'YXZ';
    panel.renderOrder = 999;
    panel.visible = false;
    app.scene.add(dolly, panel);
    // Scoreboard hangs in the venue over the far half of the field, slightly to the right.
    function placePanel(side, dz) {
      panel.position.set(side * 1.2, 2.2, dz + side * 1.1);
      panel.rotation.set(0.12, -side * Math.PI / 2, 0);
      panel.updateMatrixWorld(true);
    }

    let lastKey = '';
    let lastErr = '';
    function roundRect(x, y, w, h, r, fill) {
      ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
    }
    function drawPanel() {
      const h = app.hud;
      const red = h.scoreRed.textContent || '0', blue = h.scoreBlue.textContent || '0';
      const clock = h.clock.textContent || '', label = h.clockLabel.textContent || '';
      const st = app.state;
      const status = inputStatus();
      const key = [st, red, blue, clock, label, status, lastErr].join('|');
      if (key === lastKey) return;
      lastKey = key;
      ctx.clearRect(0, 0, 1024, 300);
      roundRect(0, 0, 1024, 210, 28, 'rgba(9,11,15,0.88)');
      roundRect(18, 18, 300, 174, 20, '#c62828');
      roundRect(706, 18, 300, 174, 20, '#1565c0');
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
      ctx.font = 'bold 110px system-ui, sans-serif';
      ctx.fillText(red, 168, 108); ctx.fillText(blue, 856, 108);
      ctx.font = 'bold 96px system-ui, sans-serif'; ctx.fillText(clock || '--:--', 512, 90);
      ctx.font = '40px system-ui, sans-serif'; ctx.fillStyle = '#b0bec5'; ctx.fillText(label, 512, 165);
      let msg = '';
      if (st === 'paused') msg = 'ПАУЗА · нажми снова Guide / оба стика — продолжить';
      else if (st === 'results') msg = 'МАТЧ ОКОНЧЕН · оба триггера — сыграть ещё';
      else if (st !== 'playing') msg = 'Оба триггера — старт практики';
      if (!msg && status && activeInput !== 'pad' && st === 'playing') msg = status;
      if (lastErr) msg = 'Ошибка: ' + lastErr;
      if (activeInput === 'pad') {
        ctx.fillStyle = '#81c784'; ctx.font = '26px system-ui, sans-serif'; ctx.fillText(status, 512, 196);
      }
      if (msg) {
        roundRect(60, 226, 904, 64, 18, 'rgba(255,193,7,0.92)');
        ctx.fillStyle = '#111'; ctx.font = 'bold 34px system-ui, sans-serif'; ctx.fillText(msg, 512, 259);
      }
      tex.needsUpdate = true;
    }

    // Place the dolly so that the player's head ends up at the driver station looking at the field.
    let needAlign = true;
    let refType = 'local-floor';
    function align(frame) {
      const ref = renderer.xr.getReferenceSpace();
      const pose = frame && ref && frame.getViewerPose(ref);
      if (!pose) return false;
      const p = pose.transform.position, o = pose.transform.orientation;
      const fwd = new T.Vector3(0, 0, -1).applyQuaternion(new T.Quaternion(o.x, o.y, o.z, o.w));
      const headYaw = Math.atan2(-fwd.x, -fwd.z);
      const side = app.rig.alliance === 'blue' ? -1 : 1;
      const yaw = -side * Math.PI / 2 - headYaw;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const rx = p.x * c + p.z * s, rz = -p.x * s + p.z * c;
      const dx = -side * 2.75, dz = typeof app.rig.driverZ === 'number' ? app.rig.driverZ : 0.6;
      // Sitting (or no floor tracking): lift the view to a standing driver's eye height.
      const eye = refType === 'local-floor' ? p.y : p.y + 1.6;
      const lift = eye < 1.35 ? 1.65 - p.y : (refType === 'local-floor' ? 0 : 1.6);
      dolly.rotation.set(0, yaw, 0);
      dolly.position.set(dx - rx, lift, dz - rz);
      dolly.updateMatrixWorld(true);
      placePanel(side, dz);
      lastAlliance = app.rig.alliance;
      return true;
    }
    let lastAlliance = null;

    // Rendering: skip the post-processing chain while in VR (it can't render stereo).
    const origRender = app.effects.render.bind(app.effects);
    app.effects.render = function (dt) {
      if (renderer.xr.isPresenting) {
        // Note: three.js has already bound the headset's framebuffer for this frame;
        // do not touch the render target here or the image goes to the page instead of the headset.
        drawPanel();
        renderer.render(app.scene, xrCam);
      } else origRender(dt);
    };

    // Main loop: while in VR the headset drives the frames, the normal loop idles.
    const origFrame = app.frame;
    app.frame = function (t) {
      if (xrActive) { requestAnimationFrame(g => app.frame(g)); return; }
      return origFrame.call(app, t);
    };

    let last = 0, prevBoth = false;
    function vrButtons() {
      let both = false;
      for (const g of navigator.getGamepads()) {
        if (g && g.mapping === 'standard') {
          const v = i => (g.buttons[i] ? g.buttons[i].value : 0);
          both = v(6) > 0.8 && v(7) > 0.8;
          break;
        }
      }
      if (both && !prevBoth && (app.state === 'results' || app.state === 'menu' || app.state === 'select')) {
        try { app.startSolo(app.lastSoloMode || 'practice'); needAlign = true; } catch (e) { console.warn(TAG, e); }
      }
      prevBoth = both;
    }
    function xrLoop(t, frame) {
      const dt = last ? (t - last) / 1000 : 1 / 72;
      last = t;
      pollTouch();
      vrButtons();
      if (app.rig.alliance !== lastAlliance) needAlign = true;
      if (needAlign && align(frame)) needAlign = false;
      try { app.tick(Math.min(0.1, Math.max(0, dt))); }
      catch (e) {
        // Never leave the headset black: draw the scene anyway and show the error on the scoreboard.
        if (!lastErr) console.error(TAG, e);
        lastErr = String((e && e.message) || e).slice(0, 60);
        try { drawPanel(); renderer.render(app.scene, xrCam); } catch (_) {}
      }
    }

    async function startVR() {
      const tryStart = async type => {
        const session = await navigator.xr.requestSession('immersive-vr',
          { optionalFeatures: type === 'local-floor' ? ['local-floor', 'bounded-floor'] : [] });
        try {
          renderer.xr.enabled = true;
          renderer.xr.setReferenceSpaceType(type);
          if (renderer.xr.setFoveation) renderer.xr.setFoveation(0.5);
          await renderer.xr.setSession(session);
          return session;
        } catch (e) { try { await session.end(); } catch (_) {} throw e; }
      };
      let session;
      try { session = await tryStart('local-floor'); refType = 'local-floor'; }
      catch (e) { console.warn(TAG, 'local-floor failed, using local', e); session = await tryStart('local'); refType = 'local'; }
      xrSession = session; xrActive = true; last = 0; needAlign = true; lastKey = '';
      panel.visible = true;
      const ref = renderer.xr.getReferenceSpace();
      if (ref && ref.addEventListener) ref.addEventListener('reset', () => { needAlign = true; });
      session.addEventListener('end', () => {
        renderer.setAnimationLoop(null);
        renderer.xr.enabled = false;
        xrSession = null; xrActive = false; virtLive = false; panel.visible = false;
        app.lastTime = 0;
        try { app.resize(); } catch (_) {}
        btn.textContent = 'Войти в VR';
      });
      renderer.setAnimationLoop(xrLoop);
      btn.textContent = 'Выйти из VR';
    }

    window.addEventListener('keydown', e => { if (e.code === 'F8') needAlign = true; });

    // Enter-VR button
    const btn = document.createElement('button');
    btn.textContent = 'Войти в VR';
    btn.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:99999;padding:12px 20px;border:0;border-radius:12px;'
      + 'font:600 16px system-ui,sans-serif;background:#ffb300;color:#111;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4)';
    document.body.appendChild(btn);

    // Input mode switch (saved between visits)
    const modeBtn = document.createElement('button');
    const modeNames = { auto: 'Управление: авто', pad: 'Управление: только геймпад', touch: 'Управление: контроллеры Quest' };
    modeBtn.style.cssText = 'position:fixed;right:18px;bottom:76px;z-index:99999;padding:10px 16px;border:0;border-radius:12px;'
      + 'font:600 14px system-ui,sans-serif;background:#eceff1;color:#111;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4)';
    const showMode = () => { modeBtn.textContent = modeNames[inputMode]; modeBtn.title = 'Нажми, чтобы сменить. Геймпад: подключи по Bluetooth и нажми на нём любую кнопку.'; };
    modeBtn.addEventListener('click', () => {
      inputMode = MODES[(MODES.indexOf(inputMode) + 1) % MODES.length];
      try { localStorage.setItem('ursimvr.input', inputMode); } catch (_) {}
      showMode(); lastKey = '';
    });
    showMode();
    document.body.appendChild(modeBtn);
    // Show which gamepad is seen, on the page too
    setInterval(() => {
      navigator.getGamepads();
      if (!xrSession) btn.title = inputStatus() || 'Геймпад не подключён: в VR будут работать контроллеры Quest';
    }, 1000);
    const toast = m => { try { app.hud.toast(m); } catch (_) {} console.log(TAG, m); };
    if (!navigator.xr) {
      btn.textContent = 'VR недоступен'; btn.disabled = true; btn.style.opacity = '0.5';
      btn.title = 'Браузер не поддерживает WebXR. Открой через Chrome/Edge с Quest Link или в браузере Quest (через localhost).';
    } else {
      navigator.xr.isSessionSupported('immersive-vr').then(ok => {
        if (!ok) { btn.textContent = 'VR-шлем не найден'; btn.title = 'Запусти Quest Link / Air Link и обнови страницу.'; }
      }).catch(() => {});
      btn.addEventListener('click', async () => {
        if (xrSession) { xrSession.end(); return; }
        try { await startVR(); }
        catch (e) { console.error(TAG, e); toast('Не удалось войти в VR: ' + (e && e.message || e)); }
      });
    }
    window.__ursimVR = { dolly, xrCam, panel, align, drawPanel, start: startVR, inputStatus, getMode: () => inputMode };
    console.log(TAG, 'ready');
  });
})();
