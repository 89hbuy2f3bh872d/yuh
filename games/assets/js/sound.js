/* SirGreen audio — synthesized SFX + ambient music via WebAudio (no asset files).
   Settings persisted in localStorage. Exposed as window.SG. */
(function () {
  if (window.SG) return;
  var LS = "sirgreen_audio";
  function load() {
    try { var s = JSON.parse(localStorage.getItem(LS) || "{}"); return { music: s.music != null ? s.music : 35, sfx: s.sfx != null ? s.sfx : 65, muted: !!s.muted }; }
    catch (e) { return { music: 35, sfx: 65, muted: false }; }
  }
  var cfg = load();
  var ctx = null, master = null, musicGain = null, sfxGain = null, musicOn = false, musicTimer = 0, started = false;

  function save() { try { localStorage.setItem(LS, JSON.stringify(cfg)); } catch (e) {} }
  function ensure() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = cfg.muted ? 0 : 1; master.connect(ctx.destination);
    sfxGain = ctx.createGain(); sfxGain.gain.value = cfg.sfx / 100; sfxGain.connect(master);
    musicGain = ctx.createGain(); musicGain.gain.value = cfg.music / 100; musicGain.connect(master);
    return ctx;
  }
  function resume() { if (ctx && ctx.state === "suspended") ctx.resume(); }

  // ── one-shot tone helper ───────────────────────────────────────────────
  function tone(o) {
    if (!ensure()) return; resume();
    var t = ctx.currentTime, dur = o.dur || 0.12;
    var osc = ctx.createOscillator(); osc.type = o.type || "sine";
    osc.frequency.setValueAtTime(o.f0 || 440, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + dur);
    var g = ctx.createGain(); var peak = (o.gain == null ? 0.5 : o.gain);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (o.atk || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    var node = osc;
    if (o.filter) { var bp = ctx.createBiquadFilter(); bp.type = o.filter; bp.frequency.value = o.cut || 1200; osc.connect(bp); bp.connect(g); }
    else osc.connect(g);
    g.connect(o.toMusic ? musicGain : sfxGain);
    osc.start(t); osc.stop(t + dur + 0.02);
  }
  function noise(o) {
    if (!ensure()) return; resume();
    var t = ctx.currentTime, dur = o.dur || 0.08;
    var n = ctx.createBufferSource(); var buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    var d = buf.getChannelData(0); for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    n.buffer = buf;
    var bp = ctx.createBiquadFilter(); bp.type = o.filter || "bandpass"; bp.frequency.value = o.cut || 2200; bp.Q.value = o.q || 1;
    var g = ctx.createGain(); g.gain.setValueAtTime(o.gain || 0.4, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(bp); bp.connect(g); g.connect(sfxGain); n.start(t); n.stop(t + dur);
  }

  // ── SFX library ────────────────────────────────────────────────────────
  var SFX = {
    click: function () { tone({ type: "triangle", f0: 520, f1: 380, dur: 0.06, gain: 0.3 }); },
    tick: function () { noise({ cut: 3000, q: 6, dur: 0.03, gain: 0.35 }); },
    spin: function () { tone({ type: "sawtooth", f0: 200, f1: 600, dur: 0.25, gain: 0.25, filter: "lowpass", cut: 1400 }); },
    pop: function () { tone({ type: "sine", f0: 700, f1: 1200, dur: 0.09, gain: 0.4 }); },
    win: function () { [523, 659, 784].forEach(function (f, i) { setTimeout(function () { tone({ type: "triangle", f0: f, dur: 0.16, gain: 0.4 }); }, i * 70); }); },
    mult: function () { tone({ type: "square", f0: 300, f1: 900, dur: 0.3, gain: 0.35 }); setTimeout(function () { tone({ type: "square", f0: 900, f1: 1500, dur: 0.2, gain: 0.3 }); }, 120); },
    scatter: function () { [392, 523, 659, 880].forEach(function (f, i) { setTimeout(function () { tone({ type: "sine", f0: f, dur: 0.22, gain: 0.4 }); }, i * 90); }); },
    bigwin: function () { [523, 659, 784, 1046, 1318].forEach(function (f, i) { setTimeout(function () { tone({ type: "triangle", f0: f, dur: 0.3, gain: 0.45 }); }, i * 110); }); },
    lose: function () { tone({ type: "sine", f0: 300, f1: 150, dur: 0.4, gain: 0.3 }); },
    coin: function () { tone({ type: "square", f0: 880, f1: 1320, dur: 0.08, gain: 0.3 }); },
    caseLand: function () { tone({ type: "triangle", f0: 180, f1: 90, dur: 0.18, gain: 0.5 }); noise({ cut: 1200, q: 1, dur: 0.1, gain: 0.3 }); },
    reveal: function () { tone({ type: "sine", f0: 660, f1: 990, dur: 0.14, gain: 0.4 }); },
  };

  // CS:GO-style case spin: ticks that start fast and decelerate over `dur` ms.
  function caseSpin(dur) {
    if (!ensure()) return; resume();
    dur = dur || 3000; var n = 0, total = Math.min(60, Math.round(dur / 55));
    function next() {
      if (n >= total || !cfg && true) {} // guard
      SFX.tick();
      n++;
      if (n < total) {
        // ease-out: gaps grow toward the end
        var p = n / total; var gap = 35 + p * p * 240;
        musicTimerSafe = setTimeout(next, gap);
      }
    }
    next();
  }
  var musicTimerSafe = 0;

  // ── Ambient music: slow pentatonic pads, gentle and calming ─────────────
  var SCALE = [220, 246.94, 293.66, 329.63, 392, 440, 587.33];
  function musicStep() {
    if (!musicOn || !ensure()) return;
    var root = SCALE[Math.floor(Math.random() * SCALE.length)];
    // soft pad chord
    [root, root * 1.5, root * 2].forEach(function (f, i) {
      tone({ type: "sine", f0: f, dur: 3.2, atk: 0.8, gain: 0.12 - i * 0.03, toMusic: true, filter: "lowpass", cut: 900 });
    });
    musicTimer = setTimeout(musicStep, 2600 + Math.random() * 1400);
  }
  function startMusic() { if (musicOn) return; if (!ensure()) return; resume(); musicOn = true; musicStep(); }
  function stopMusic() { musicOn = false; if (musicTimer) clearTimeout(musicTimer); }

  // first user gesture unlocks audio + (re)starts music if enabled
  function unlock() {
    if (started) return; started = true; ensure(); resume();
    if (cfg.music > 0 && !cfg.muted) startMusic();
  }
  ["pointerdown", "keydown", "touchstart"].forEach(function (ev) { window.addEventListener(ev, unlock, { once: false }); });

  window.SG = {
    sfx: function (name) { if (cfg.muted) return; var f = SFX[name]; if (f) try { f(); } catch (e) {} },
    caseSpin: function (d) { if (!cfg.muted) try { caseSpin(d); } catch (e) {} },
    get: function () { return Object.assign({}, cfg); },
    setMusic: function (v) { cfg.music = Math.max(0, Math.min(100, v | 0)); save(); if (musicGain) musicGain.gain.value = cfg.music / 100; if (cfg.music > 0 && !cfg.muted) startMusic(); else if (cfg.music === 0) stopMusic(); },
    setSfx: function (v) { cfg.sfx = Math.max(0, Math.min(100, v | 0)); save(); if (sfxGain) sfxGain.gain.value = cfg.sfx / 100; },
    setMuted: function (m) { cfg.muted = !!m; save(); if (master) master.gain.value = cfg.muted ? 0 : 1; if (cfg.muted) stopMusic(); else if (cfg.music > 0) startMusic(); },
    test: function () { this.sfx("win"); },
  };
})();
