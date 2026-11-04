// Tiny WebAudio synth: coins, stamps, a night chime, a soft ambient bed. Nothing plays until the
// player has acted; a mute button switches it all off.

export class Sound {
  constructor() {
    this.ctx = null
    this.muted = localStorage.getItem('lantern-row:muted') === '1'
    this.ambient = null
    this.master = null
  }

  enable() {
    if (this.ctx) return
    try {
      this.ctx = new (globalThis.AudioContext || globalThis.webkitAudioContext)()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.muted ? 0 : 0.7
      this.master.connect(this.ctx.destination)
      this.startAmbient()
    } catch {
      this.ctx = null
    }
  }

  setMuted(m) {
    this.muted = m
    localStorage.setItem('lantern-row:muted', m ? '1' : '0')
    if (this.master) this.master.gain.linearRampToValueAtTime(m ? 0 : 0.7, this.ctx.currentTime + 0.2)
  }

  startAmbient() {
    const c = this.ctx
    // a soft wind: filtered noise
    const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.5
    const noise = c.createBufferSource()
    noise.buffer = buf
    noise.loop = true
    const lp = c.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 320
    const ng = c.createGain()
    ng.gain.value = 0.045
    noise.connect(lp).connect(ng).connect(this.master)
    noise.start()
    const lfo = c.createOscillator()
    lfo.frequency.value = 0.07
    const lg = c.createGain()
    lg.gain.value = 120
    lfo.connect(lg).connect(lp.frequency)
    lfo.start()
    // a low warm pad
    const pad = c.createGain()
    pad.gain.value = 0.035
    pad.connect(this.master)
    for (const f of [110, 164.8, 220]) {
      const o = c.createOscillator()
      o.type = 'triangle'
      o.frequency.value = f
      o.detune.value = (Math.random() - 0.5) * 8
      o.connect(pad)
      o.start()
    }
    this.ambient = { noise, pad }
  }

  tone({ freq, type = 'sine', dur = 0.2, gain = 0.2, slide = 0, delay = 0 }) {
    if (!this.ctx || this.muted) return
    const c = this.ctx
    const t = c.currentTime + delay
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(this.master)
    o.start(t)
    o.stop(t + dur + 0.02)
  }

  coin() {
    const base = 1100 + Math.random() * 300
    this.tone({ freq: base, dur: 0.14, gain: 0.12, slide: 500 })
    this.tone({ freq: base * 1.5, dur: 0.22, gain: 0.08, delay: 0.05 })
  }

  stamp() {
    this.tone({ freq: 140, type: 'square', dur: 0.08, gain: 0.1, slide: -80 })
    this.tone({ freq: 900, type: 'triangle', dur: 0.05, gain: 0.05, delay: 0.02 })
  }

  chime() {
    this.tone({ freq: 660, type: 'triangle', dur: 0.6, gain: 0.1 })
    this.tone({ freq: 990, type: 'triangle', dur: 0.8, gain: 0.08, delay: 0.18 })
  }

  refuse() {
    this.tone({ freq: 300, type: 'triangle', dur: 0.18, gain: 0.07, slide: -90 })
  }

  tap() {
    this.tone({ freq: 520, type: 'triangle', dur: 0.05, gain: 0.05 })
  }

  fanfare() {
    ;[523, 659, 784, 1046].forEach((f, i) => this.tone({ freq: f, type: 'triangle', dur: 0.35, gain: 0.1, delay: i * 0.09 }))
  }
}
