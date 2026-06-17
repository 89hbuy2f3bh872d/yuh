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

  // ── Per-game music themes (only play on slot pages, never casino-wide) ───
  // Each theme is a short looping sequence; quiet by default. Bonus theme is
  // brighter/faster. Switching themes crossfades the music bus.
  var THEMES = {
    // base machine themes
    candy:   { tempo: 430, type: "triangle", cut: 1150, gain: 0.085, lead: [523, 659, 784, 659, 587, 784, 880, 784], bass: [131, 0, 165, 0, 175, 0, 196, 0] },
    olympus: { tempo: 500, type: "sine",     cut: 950,  gain: 0.085, lead: [440, 523, 659, 523, 587, 440, 392, 523], bass: [110, 0, 131, 0, 98, 0, 110, 0] },
    bandit:  { tempo: 520, type: "triangle", cut: 880,  gain: 0.095, lead: [392, 0, 494, 587, 0, 494, 440, 0],       bass: [98, 0, 0, 123, 0, 0, 110, 0] },
    // bonus = brighter, faster variant of the SAME machine's song (one octave up, denser)
    candyB:  { tempo: 300, type: "triangle", cut: 1700, gain: 0.10, lead: [1046, 1318, 1568, 1318, 1175, 1568, 1760, 1568, 1318, 1175, 1046, 1175], bass: [262, 330, 349, 392, 350, 392, 392, 330] },
    olympusB:{ tempo: 330, type: "sawtooth", cut: 1500, gain: 0.10, lead: [880, 1046, 1318, 1046, 1175, 880, 784, 1046, 1318, 1046, 880, 784], bass: [220, 262, 196, 220, 196, 262, 220, 196] },
    banditB: { tempo: 320, type: "square",   cut: 1300, gain: 0.10, lead: [784, 988, 1175, 988, 880, 1175, 1318, 1175, 988, 880, 784, 988], bass: [196, 247, 196, 220, 196, 247, 220, 196] },
  };
  var mKey = null, mStep = 0, mTimer = 0, mPlaying = false;
  function mTick() {
    if (!mPlaying || !ensure()) return;
    var th = THEMES[mKey]; if (!th) { mTimer = setTimeout(mTick, 300); return; }
    var i = mStep % th.lead.length, f = th.lead[i];
    if (f) tone({ type: th.type, f0: f, dur: th.tempo / 1000 * 1.6, atk: 0.02, gain: th.gain, toMusic: true, filter: "lowpass", cut: th.cut });
    var bf = th.bass[i % th.bass.length];
    if (bf) tone({ type: "sine", f0: bf, dur: th.tempo / 1000 * 1.9, atk: 0.02, gain: th.gain * 0.85, toMusic: true, filter: "lowpass", cut: 480 });
    mStep++;
    mTimer = setTimeout(mTick, th.tempo);
  }
  function crossfade() {
    if (!musicGain || !ctx) return;
    var t = ctx.currentTime, target = cfg.muted ? 0 : cfg.music / 100;
    musicGain.gain.cancelScheduledValues(t);
    musicGain.gain.setValueAtTime(Math.max(0.0001, musicGain.gain.value), t);
    musicGain.gain.linearRampToValueAtTime(0.0001, t + 0.22);
    musicGain.gain.linearRampToValueAtTime(target, t + 0.6);
  }
  function playTheme(key) {
    if (!THEMES[key]) return;
    if (!ensure()) return; resume();
    if (mKey === key && mPlaying) return;
    if (mPlaying) crossfade();      // smooth transition between themes
    mKey = key; mStep = 0;
    if (!mPlaying) { mPlaying = true; if (mTimer) clearTimeout(mTimer); mTimer = setTimeout(mTick, 250); }
  }
  function stopMusic() { mPlaying = false; if (mTimer) clearTimeout(mTimer); mKey = null; }

  // First gesture only unlocks the audio context (no auto-play music).
  function unlock() { if (started) return; started = true; ensure(); resume(); }
  ["pointerdown", "keydown", "touchstart"].forEach(function (ev) { window.addEventListener(ev, unlock, { once: false }); });

  window.SG = {
    sfx: function (name) { if (cfg.muted) return; var f = SFX[name]; if (f) try { f(); } catch (e) {} },
    caseSpin: function (d) { if (!cfg.muted) try { caseSpin(d); } catch (e) {} },
    // schedule ticks at exact ms offsets (synced to the reel crossing dividers)
    caseTicks: function (times) { if (cfg.muted || !times) return; ensure(); resume(); for (var i = 0; i < times.length; i++) { (function (t) { setTimeout(function () { if (!cfg.muted) try { SFX.tick(); } catch (e) {} }, t); })(times[i]); } },
    music: { play: function (k) { try { playTheme(k); } catch (e) {} }, stop: stopMusic },
    get: function () { return Object.assign({}, cfg); },
    setMusic: function (v) { cfg.music = Math.max(0, Math.min(100, v | 0)); save(); if (musicGain) musicGain.gain.value = cfg.muted ? 0 : cfg.music / 100; if (cfg.music === 0) stopMusic(); },
    setSfx: function (v) { cfg.sfx = Math.max(0, Math.min(100, v | 0)); save(); if (sfxGain) sfxGain.gain.value = cfg.sfx / 100; },
    setMuted: function (m) { cfg.muted = !!m; save(); if (master) master.gain.value = cfg.muted ? 0 : 1; },
    test: function () { this.sfx("win"); },
  };
})();
