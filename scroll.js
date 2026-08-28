/* SRX — scroll-driven RGB glitch between the three views.

   Everything is composited onto one canvas. The channel split is done with
   explicit canvas compositing rather than stacked mix-blend-mode layers,
   which browsers handle inconsistently — Safari in particular drops a
   layer when `filter` and `mix-blend-mode` meet on one element, leaving
   the artwork with an unopposed red cast.

   A view is split into three copies, each reduced to one colour channel by
   lightening it against that channel's complement: lighten(grey v, cyan)
   gives (v, 1, 1), leaving red alone and forcing green and blue to white.
   Multiplied back together the three give (v, v, v) — the original — so a
   settled view is pixel-clean, and colour only appears once the copies are
   pulled apart. The swap between views is a hard cut at the midpoint,
   hidden inside the noise. No cross-fade.

   The track is built from full-screen snap sections, so a gesture always
   settles on a view; a half-scrolled state rolls back to the nearest one.
   Reverse scrolling runs it backwards, and the track wraps, so past view 3
   you come around to view 1 again. */

(function () {
  var VIEWS = [
    { src: 'assets/slide-1.png', frameH: 600, top: 0.0863 },
    { src: 'assets/slide-2.png', frameH: 650, top: 0 },
    { src: 'assets/slide-3.png', frameH: 710, top: 0.001 }
  ];
  /* ── sections ───────────────────────────────────────────────────
     Each is a block of copy plus its own artwork, drawn on the same canvas
     through the same glitch. Art is sized by `scale` — a fraction of the
     frame width — rather than the VIEWS frame system, so each piece can be
     sized on its own terms. */
  var EMAIL = 'jmweaver39@gmail.com';

  var PAGES = {
    team: {
      title: 'Team',
      lede: "we're four college students,\nwe've built:",
      /* `items` and `art` are index-paired — the name and the picture come
         from the same position, so reordering means moving both. */
      items: ['planes', 'rockets', 'drones', 'robots'],
      art: [
        { src: 'assets/plane.png',  scale: 0.58 },
        { src: 'assets/rocket.png', scale: 0.60 },
        { src: 'assets/drone.png',  scale: 0.40, nudgeX: 30 },
        { src: 'assets/robot.png',  scale: 0.36 }
      ],
      cycle: 3000                        // ms per item, until the first scroll takes over
    },
    support: {
      title: 'Support Us',
      lede: "we're looking for in-kind\ndonations & funding for:",
      items: ['dji fpv systems', 'composites'],
      /* Sized so the head-on body matches the fuselage in the other views.
         The side view's tube measures 152px of the 2000px nominal frame;
         the body in front.png is 47px tall against its 259px width. So the
         art is drawn at 259 * (152 / 47) / 2000 of the frame width. */
      art: [{ src: 'assets/front.png', scale: 0.419 }],
      shake: false                       // still under the scroll; it glitches in on arrival
    }
  };

  var CANVAS_W = 2000;     // the nominal frame every view is drawn into
  var N = VIEWS.length;
  var CYCLES = 3;          // three laps of track; we ride the middle one

  /* ── glitch tuning ─────────────────────────────────────────────
     SPLIT  how far the red and blue channels pull apart, in px
     DRIFT  sideways slam of the whole frame
     STEPS  glitch frames per transition — low is chunkier, more digital */
  var SPLIT = 20;
  var DRIFT = 10;
  var STEPS = 14;

  /* Stood on end the split runs across the *short* axis of the screen, so
     the same offset covers far more of the aircraft's width and reads much
     louder than it does along a landscape fuselage. Scale it back to keep
     the vertical layout as restrained as the horizontal one. */
  var ROTATED_SPLIT = 0.6;

  /* Turning artwork on its side is worth it only when the piece is too long
     to read across a narrow screen. The scroll views always turn together —
     they're one sequence and would look broken if they disagreed — but
     section art is judged on its own proportions. At 750 x 108 the rocket
     qualifies; the plane, drone, robot and head-on view don't. */
  var TURN_ASPECT = 4;

  // how much more of a narrow screen a section's artwork is allowed to take
  var NARROW_GAIN = 1.4;
  var DURATION = 250;      // ms — the committed cut runs on its own clock

  /* Colour bleeds outward rather than just fringing the edges: each channel
     is drawn several times along its offset direction, further out and
     fainter each pass. Ordered far-to-near so the solid core lands last. */
  var ECHOES = [[3.2, 0.20], [2.0, 0.42], [1.0, 1]];

  /* Dark is the exact dual of light, not a repaint. Light draws dark-on-white
     art and multiplies, isolating a channel by lightening against its
     complement: lighten(v, cyan) = (v,1,1), and the three multiply back to
     (v,v,v). Dark inverts the art and screens, isolating by darkening against
     the pure channel: darken(1-v, red) = (1-v,0,0), and the three screen back
     to (1-v,1-v,1-v). Either way the split stays colour — it never inverts
     into something muddy. */
  var LIGHT = {
    paper: '#f7f7f7',
    dot:   'rgba(0,0,0,.055)',
    op:    'multiply',
    mask:  'lighten',
    inks:  ['#00ffff', '#ff00ff', '#ffff00']   // complements
  };
  var DARK = {
    paper: '#080808',
    dot:   'rgba(255,255,255,.07)',
    op:    'screen',
    mask:  'darken',
    inks:  ['#ff0000', '#00ff00', '#0000ff']   // the channels themselves
  };
  var DOT_GAP = 5;

  var scheme = matchMedia('(prefers-color-scheme: dark)');
  var dark = scheme.matches;
  function theme() { return dark ? DARK : LIGHT; }

  var brand = document.querySelector('.brand');
  var canvas = document.querySelector('canvas.stage');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var track = document.querySelector('.track');

  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  var vh = window.innerHeight, vw = window.innerWidth, dpr = 1;
  var settleTimer = null, dots = null;
  var current = 0, from = 0, to = 0, started = 0, animating = false;
  var rotated = false;
  var spent = false;          // this drag has already cycled; its progress is used up
  var gesturing = false;      // a finger is still driving the scroll
  var gestureIdle = null;
  var releasing = false, releaseG = 0, releaseStart = 0, bouncing = false;
  var swipe = null;           // horizontal drag standing in for vertical scroll
  var page = null;            // open section key, or null for the scroll experience
  var painted = -1;           // last index the section's copy was painted for
  var cycleTimer = null, typeTimer = null;

  /* How many stops the scroll has right now. A section swaps its own art in
     for the three views; everything downstream — the snap track, the wrap,
     the index the scroll resolves to — is written against this rather than
     against N, so both run through one code path. */
  function count() { return page ? PAGES[page].art.length : N; }

  /* A section holding a single piece of artwork has nowhere to scroll to.
     Rather than let the page drift under it, it gets no track at all and the
     gesture is spent entirely on the glitch — it shakes in place. */
  function fixed() { return page && count() === 1; }

  /* A section may opt out of scroll-driven colour while keeping the glitch it
     arrives with. Only the gesture is silenced, not the entrance. */
  function shakeable() { return !page || PAGES[page].shake !== false; }
  var still = 0;              // gesture accumulated where there is nothing to scroll

  /* ── assets ──────────────────────────────────────────────────── */

  // every piece of artwork on the site, scroll views and sections alike
  var ART = [];
  Object.keys(PAGES).forEach(function (k) {
    PAGES[k].art.forEach(function (a) { ART.push(a); });
  });

  function loadArt(v) {
    var img = new Image();
    img.onload = function () {
      v.src_img = img;
      v.w = img.naturalWidth;
      v.h = img.naturalHeight;
      measureBias(v);
      dress(v);
      render();
    };
    img.src = v.src;
  }

  /* Centre on the artwork, not on its canvas. A cut-out carries whatever
     empty margin it was exported with — the plane sits about 4% low in its
     frame — so centring the image box leaves the aircraft visibly off. Find
     the opaque bounds once at load and record the offset as a fraction of
     the canvas, for place() to take back out.

     Reading pixels taints a canvas served from file://, so the whole thing is
     guarded: if it throws, the bias stays zero and placement falls back to
     centring the box, exactly as before. */
  function measureBias(v) {
    v.bx = 0;
    v.by = 0;
    try {
      var c = document.createElement('canvas');
      c.width = v.w; c.height = v.h;
      var x = c.getContext('2d');
      x.drawImage(v.src_img, 0, 0);
      var d = x.getImageData(0, 0, v.w, v.h).data;

      // full-bleed art (the scroll views) has nothing to trim — don't scan it
      var corners = [0, (v.w - 1), (v.h - 1) * v.w, (v.h * v.w - 1)];
      var solid = corners.every(function (i) { return d[i * 4 + 3] > 24; });
      if (solid) return;

      var x0 = v.w, y0 = v.h, x1 = -1, y1 = -1;
      for (var yy = 0; yy < v.h; yy++) {
        var row = yy * v.w;
        for (var xx = 0; xx < v.w; xx++) {
          if (d[(row + xx) * 4 + 3] > 24) {
            if (xx < x0) x0 = xx;
            if (xx > x1) x1 = xx;
            if (yy < y0) y0 = yy;
            if (yy > y1) y1 = yy;
          }
        }
      }
      if (x1 < 0) return;
      v.bx = ((x0 + x1) / 2 - v.w / 2) / v.w;
      v.by = ((y0 + y1) / 2 - v.h / 2) / v.h;
    } catch (e) {
      /* tainted canvas — centre the box and carry on */
    }
  }

  VIEWS.forEach(loadArt);
  ART.forEach(loadArt);

  /* Build the flat plate and the three channel plates for the active
     scheme. Re-run whenever the scheme flips. */
  function dress(v) {
    if (!v.src_img) return;
    v.img = flat(v.src_img);
    v.ch = channels(v.src_img);
  }

  function plate(img) {
    var c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    var x = c.getContext('2d');

    x.drawImage(img, 0, 0);

    if (dark) {
      /* Invert, then put the cut-out back. `difference` covers the whole
         canvas, so it turns the empty area opaque white as a side effect;
         masking against the source's own alpha restores the transparency
         and leaves only the artwork inverted. */
      x.globalCompositeOperation = 'difference';
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, c.width, c.height);
      x.globalCompositeOperation = 'destination-in';
      x.drawImage(img, 0, 0);
    }

    /* Lay the scheme's own ground in behind, rather than deriving it from
       the inversion above. Cut-out art is transparent where there's no
       aircraft, and a bare canvas is transparent: `lighten` against a
       transparent pixel just writes the ink colour, so the three channel
       plates would each fill the empty area and multiply back to
       cyan x magenta x yellow = black the moment the art glitched. White
       multiplies away to nothing in light mode; black screens away to
       nothing in dark. Filling it explicitly means the ground is right even
       if the inversion above misbehaves. */
    x.globalCompositeOperation = 'destination-over';
    x.fillStyle = dark ? '#000000' : '#ffffff';
    x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = 'source-over';

    return { canvas: c, ctx: x };
  }

  function flat(img) {
    if (!dark) return img;            // light mode uses the source as-is
    return plate(img).canvas;
  }

  /* One canvas per channel. Built by compositing, never by reading pixels,
     so this works from file:// as well as over http. */
  function channels(img) {
    var t = theme();
    return t.inks.map(function (ink) {
      var p = plate(img);
      p.ctx.globalCompositeOperation = t.mask;
      p.ctx.fillStyle = ink;
      p.ctx.fillRect(0, 0, p.canvas.width, p.canvas.height);
      return p.canvas;
    });
  }

  function dotPattern() {
    var c = document.createElement('canvas');
    c.width = c.height = DOT_GAP;
    var x = c.getContext('2d');
    x.fillStyle = theme().dot;
    x.fillRect(0, 0, 1, 1);
    return ctx.createPattern(c, 'repeat');
  }

  /* ── layout ──────────────────────────────────────────────────── */

  /* W and H are the *logical* viewport — swapped when the artwork is turned
     on its side, so nothing downstream needs to know about the rotation. */
  function frameWidth(W, H) {
    var byWidth = W <= 900 ? W * 0.88 : Math.min(W * 0.74, 1200);
    var byHeight = H * 0.62 * (CANVAS_W / 710);    // the tallest frame sets the ceiling
    return Math.min(byWidth, byHeight);
  }

  function resize() {
    vw = window.innerWidth;
    vh = window.innerHeight;
    rotated = vh > vw;          // portrait: turn the artwork on its side
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dots = dotPattern();
    layoutTrack();
  }

  /* One full-screen snap section per stop, three laps of them so there is
     runway to scroll backwards into. Rebuilt whenever the number of stops
     changes, which is the only thing that differs between the views and a
     section. */
  function layoutTrack() {
    if (!track) return;
    var want = fixed() ? 0 : count() * CYCLES;    // nothing to scroll through
    if (track.childElementCount === want) return;
    track.textContent = '';
    for (var i = 0; i < want; i++) {
      track.appendChild(document.createElement('div')).className = 'snap';
    }
  }

  /* ── drawing ─────────────────────────────────────────────────── */

  // deterministic per-step noise, so a glitch frame is stable while it shows
  function noise(n) {
    var x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function paper() {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = theme().paper;
    ctx.fillRect(0, 0, vw, vh);
    if (dots) { ctx.fillStyle = dots; ctx.fillRect(0, 0, vw, vh); }
  }

  function place(v, W, H) {
    var fw = frameWidth(W, H);

    /* Section art is sized as a fraction of the frame and simply centred —
       it has no nominal frame of its own to sit inside. */
    if (v.scale) {
      /* On a narrow screen nothing competes with the artwork for width, so
         each piece claims more of it than the desktop proportion allows.
         Clamped to the space actually available so a tall piece can't run
         off the top or collide with the copy. */
      var s = v.scale * (vw <= 900 ? NARROW_GAIN : 1);
      var aw = Math.min(fw * s, W * 0.94);
      var ah = aw * (v.h / v.w);
      if (ah > H * 0.94) { ah = H * 0.94; aw = ah * (v.w / v.h); }

      /* `nudgeX` is a hand offset in screen pixels, for art that reads better
         off-centre. Screen-right is local +x normally, but local -y once the
         piece is turned, so it follows the artwork rather than the canvas. */
      var t = turns(v);
      var nx = v.nudgeX || 0;

      return {
        x: (W - aw) / 2 - (v.bx || 0) * aw + (t ? 0 : nx),   // centre the artwork, not the canvas
        y: (H - ah) / 2 - (v.by || 0) * ah + (t ? -nx : 0),
        w: aw, h: ah, frameH: ah
      };
    }

    var scale = fw / CANVAS_W;
    var w = v.w * scale;
    var h = v.h * scale;
    var frameH = v.frameH * scale;
    return {
      x: (W - w) / 2,
      y: (H - frameH) / 2 + v.top * frameH,
      w: w,
      h: h,
      frameH: frameH
    };
  }

  /* The screen row the artwork has to stay above, so it never runs into the
     wordmark pinned to the bottom. */
  function keepOut() {
    if (!brand) return vh;
    var t = brand.getBoundingClientRect().top;
    return (t > 0 ? t : vh) - 18;
  }

  /* The glitch runs on a fixed 250 ms clock rather than tracking scroll
     position, so it plays at the same speed however fast the gesture was.
     Scrolling only decides *which* view is next. */
  function pageArt() {
    var p = PAGES[page];
    return p ? p.art[current] : null;
  }

  function turns(v) {
    if (!rotated) return false;
    if (!v.scale) return true;                 // a scroll view: they move as one
    return (v.w / v.h) > TURN_ASPECT;
  }

  function draw(view, g, t) {
    var v = page ? pageArt() : VIEWS[view];
    paper();
    if (!v || !v.img) return;

    var turn = turns(v);

    /* A window taller than it is wide can't fit a 3:1 aircraft across, so
       the artwork turns 90 degrees to run down the screen instead. Rotating
       the whole coordinate system means placement and scaling carry over
       untouched. The glitch offsets are the one thing that doesn't: the
       split is remapped below so it stays left-right for the viewer rather
       than following the fuselage onto the vertical. Which pieces turn is
       decided per artwork by turns(), not by the viewport alone. */
    var limit = keepOut();
    var band = Math.max(160, limit);         // size against the space that's actually free
    var W = turn ? band : vw;
    var H = turn ? vw : band;

    var r = place(v, W, H);

    /* Centred in the viewport as before, but lifted clear of the lockup when
       the window is short enough that the two would otherwise overlap. In
       the rotated layout the artwork's long axis is what runs vertically, so
       that's the extent to clear. */
    var halfV = (turn ? r.w : r.frameH) / 2;
    var cy = Math.min(vh / 2, limit - halfV);

    ctx.save();
    if (turn) {
      ctx.translate(vw / 2, cy);
      ctx.rotate(Math.PI / 2);
      ctx.translate(-W / 2, -H / 2);
    } else {
      ctx.translate(0, cy - H / 2);
    }
    ctx.globalCompositeOperation = theme().op;

    if (g < 0.002 || reduced) {
      ctx.drawImage(v.img, r.x, r.y, r.w, r.h);      // settled: one clean pass
    } else {
      var step = Math.floor(t * STEPS);
      var sp = g * SPLIT;
      var drift = (noise(step) - 0.5) * g * DRIFT;

      // red and blue pull apart, green holds the middle so the form stays read
      var major = [
        drift - sp * (0.7 + noise(step + 1) * 0.6),
        drift * 0.4,
        drift + sp * (0.7 + noise(step + 2) * 0.6)
      ];
      var minor = [
        (noise(step + 3) - 0.5) * g * 6,
        0,
        (noise(step + 4) - 0.5) * g * 6
      ];

      /* The split reads left-right on the viewer's screen in both
         orientations. Stood on end the local axes turn with the artwork, so
         the pull moves from local x to local y to stay across the screen
         instead of running up and down the fuselage. Local +y points
         screen-left once rotated, hence the negation: it keeps red on the
         same side of the aircraft in either layout. */
      var off = [];
      for (var c = 0; c < 3; c++) {
        off.push(turn
          ? [minor[c], -major[c] * ROTATED_SPLIT]
          : [major[c], minor[c]]);
      }

      for (var e = 0; e < ECHOES.length; e++) {
        var k = ECHOES[e][0], a = ECHOES[e][1];
        ctx.globalAlpha = a === 1 ? 1 : a * g;       // the spill fades in with intensity
        for (var i = 0; i < 3; i++) {
          ctx.drawImage(v.ch[i], r.x + off[i][0] * k, r.y + off[i][1] * k, r.w, r.h);
        }
      }
      ctx.globalAlpha = 1;
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  function render() { draw(current, 0, 0); }

  /* Let go before the threshold and the colour doesn't just track the
     snap-back — it pulls home under its own easing.

     Where there is nowhere to scroll, a hard gesture has momentum with
     nothing to spend it on. Rather than swallow it, the colour rings down:
     it overshoots back through zero a few times, each swing smaller, and
     settles clean. A gentle gesture still just eases home — the bounce is
     what distinguishes a shove from a nudge. */
  var BOUNCE_MIN = 0.4;       // release strength that has earned a bounce
  var BOUNCE_TIME = 640;      // ms for the ring-down to play out
  var BOUNCE_DECAY = 4.2;     // how fast the swings shrink
  var BOUNCE_SWINGS = 2.5;    // half-cycles before it is done

  function releaseFrame(now) {
    if (!releasing) return;

    var span = bouncing ? BOUNCE_TIME : DURATION;
    var t = (now - releaseStart) / span;
    if (t >= 1) { releasing = false; bouncing = false; render(); return; }

    var g;
    if (bouncing) {
      g = releaseG * Math.exp(-BOUNCE_DECAY * t) *
          Math.abs(Math.cos(Math.PI * BOUNCE_SWINGS * t));
    } else {
      var e = 1 - t;
      g = releaseG * e * e;
    }

    draw(current, g, t);
    requestAnimationFrame(releaseFrame);
  }

  function endGesture() {
    clearTimeout(gestureIdle);
    if (!gesturing) return;
    gesturing = false;
    var g = scrollState().g;
    still = 0;                             // the gesture is over; let it ease home
    if (animating) return;                 // a commit is already playing
    if (g < 0.002) { render(); return; }
    releasing = true;
    releaseG = g;
    bouncing = fixed() && g >= BOUNCE_MIN;   // momentum, and nowhere to put it
    releaseStart = performance.now();
    requestAnimationFrame(releaseFrame);
  }

  /* No standard event reports trackpad touch state, so a gesture counts as
     live while wheel events keep arriving and released once they stop.
     Touch devices report lift-off exactly, so use that where we have it. */
  function beginGesture() {
    gesturing = true;
    releasing = false;
    clearTimeout(gestureIdle);
    gestureIdle = setTimeout(endGesture, 110);
  }

  var settleGuard = null;

  /* The cut is a fixed-length animation driven by rAF, and rAF is suspended
     in a background tab — and stalls outright in some browsers. If the clock
     says the cut should be over and it isn't, settle it from a timer, which
     isn't held back the same way. Without this the page can be left frozen
     mid-glitch, or stuck showing the outgoing view for good. */
  function run() {
    clearTimeout(settleGuard);
    settleGuard = setTimeout(function () {
      if (!animating || performance.now() - started < DURATION) return;
      animating = false;
      current = to;
      if (page && current !== painted) { painted = current; paintList(true); }
      render();
    }, DURATION + 80);

    if (!animating) { animating = true; requestAnimationFrame(frame); }
  }

  /* Same glitch, but staying on the current view — used when the artwork
     flips orientation rather than when it changes view. */
  function flash() {
    from = to = current;
    started = performance.now();
    run();
  }

  function frame(now) {
    var t = (now - started) / DURATION;

    var st = scrollState();

    if (t >= 1) {
      animating = false;
      current = to;
      if (page && current !== painted) { painted = current; paintList(true); }
      draw(current, st.g, st.t);            // hand back to the scroll
      return;
    }

    current = t < 0.5 ? from : to;          // hard cut at the midpoint

    // a section's copy turns over on the same frame its artwork does
    if (page && current !== painted) { painted = current; paintList(true); }
    // whichever is louder: the committed cut, or the drag still under way
    draw(current, Math.max(1 - Math.abs(2 * t - 1), st.g), t);
    requestAnimationFrame(frame);
  }

  /* ── scrolling ───────────────────────────────────────────────── */

  /* Wrapping. Only done once scrolling has come to rest, so it can't fight
     an in-flight snap. The jump is exactly one lap, so the view on screen is
     identical before and after — the seam is invisible. */
  function wrap() {
    if (fixed()) return;
    var y = window.scrollY, C = count();
    var lap = C * vh;
    if (y < 1.5 * vh) window.scrollTo(0, y + lap);
    else if (y > (C * CYCLES - 2.5) * vh) window.scrollTo(0, y - lap);
  }

  /* Where the scroll actually sits, as distinct from where it will settle.
     `view` is the nearest snap point — the image on screen doesn't change
     until you cross the halfway line — while `g` scales with how far you've
     dragged away from it, so a partial scroll bleeds colour out of the
     aircraft and sucks it back in if you let go early. */
  function scrollState() {
    /* Nothing to read from the scroll here, so the gesture reports itself —
       same shape, so the bleed and the release behave as they do everywhere
       else, but no commit ever follows because there is nowhere to go. */
    if (fixed()) return { view: 0, g: still * still, t: still };

    var C = count();
    var p = window.scrollY / vh;
    var nearest = Math.round(p);
    var d = Math.min(Math.abs(p - nearest) * 2, 1);   // 0 at rest, 1 at the threshold

    /* Once a drag has cycled the image, its remaining travel is spent: the
       scroll is still far from the new snap point, and reading intensity
       off that distance would leave colour hanging on the new view after
       the cut. Stay clean until the scroll settles, then re-arm. */
    if (spent) {
      if (d < 0.03) spent = false;
      return { view: ((nearest % C) + C) % C, g: 0, t: 0 };
    }

    /* Squared, not linear. The artwork is halftone, so even a 2px channel
       offset misaligns every dot and floods the whole airframe with colour;
       easing in keeps a small drag subtle and saves the real bleed for the
       approach to the threshold. */
    return {
      view: ((nearest % C) + C) % C,
      g: d * d,
      t: d
    };
  }

  function viewAt() { return scrollState().view; }

  function onScroll() {
    var st = scrollState();

    if (st.view !== to) {                    // crossed the threshold: commit
      from = current;
      to = st.view;
      spent = true;                          // burn the rest of this drag
      releasing = false;
      started = performance.now();
      run();
    }

    if (!animating && !releasing) {          // under the threshold: follow the scroll
      current = st.view;
      draw(current, gesturing ? st.g : 0, st.t);
    }

    if ('onscrollend' in window) return;        // scrollend handles the wrap
    clearTimeout(settleTimer);
    settleTimer = setTimeout(wrap, 140);
  }

  /* ── sections ────────────────────────────────────────────────── */

  var dock = document.querySelector('.dock');
  var note = document.querySelector('.dock-note');
  var pageEl = document.querySelector('.page');
  var titleEl = pageEl.querySelector('.page-title');
  var ledeEl = pageEl.querySelector('.page-lede');
  var listEl = pageEl.querySelector('.page-list');
  var backEl = document.querySelector('.back');

  function paintCopy() {
    var p = PAGES[page];
    if (!p) return;
    titleEl.textContent = p.title;
    ledeEl.textContent = p.lede;
    listEl.textContent = '';
    paintList();
  }

  /* Run each character through random glyphs before it lands, resolving left
     to right, so the name reads as something settling into place rather than
     a straight swap. */
  var GLYPHS = 'abcdefghijklmnopqrstuvwxyz';
  var SCRAMBLE_FRAMES = 16, SCRAMBLE_STEP = 30;    // ~480ms
  var scrambleTimer = null;

  function scrambleTo(el, target) {
    clearInterval(scrambleTimer);
    scrambleTimer = null;
    if (reduced) { el.textContent = target; return; }

    var n = 0;
    scrambleTimer = setInterval(function () {
      n++;
      var landed = Math.floor(target.length * (n / SCRAMBLE_FRAMES));
      var out = target.slice(0, landed);
      for (var i = landed; i < target.length; i++) {
        out += GLYPHS.charAt((Math.random() * GLYPHS.length) | 0);
      }
      el.textContent = out;
      if (n >= SCRAMBLE_FRAMES) {
        clearInterval(scrambleTimer);
        scrambleTimer = null;
        el.textContent = target;
      }
    }, SCRAMBLE_STEP);
  }

  /* A stepped section names only the entry whose artwork is on screen, so the
     word and the picture always agree. A static one lists everything. */
  function paintList(animate) {
    var p = PAGES[page];
    if (!p) return;

    if (p.cycle) {
      var li = listEl.firstElementChild;
      if (!li) { li = document.createElement('li'); listEl.appendChild(li); }
      if (animate) scrambleTo(li, p.items[current]);
      else { clearInterval(scrambleTimer); scrambleTimer = null; li.textContent = p.items[current]; }
      return;
    }

    clearInterval(scrambleTimer);
    scrambleTimer = null;
    listEl.textContent = '';
    p.items.forEach(function (label) {
      var el = document.createElement('li');
      el.textContent = label;
      listEl.appendChild(el);
    });
  }

  /* Restarting a CSS animation needs the class off and the layout flushed
     before it goes back on, or the browser reuses the finished run. */
  function glitchCopy() {
    pageEl.classList.remove('is-glitching');
    void pageEl.offsetWidth;
    pageEl.classList.add('is-glitching');
  }

  function cut() {
    started = performance.now();
    run();
  }



  /* The section advances on its own until the reader takes over. It advances
     by scrolling — the same motion a gesture produces — so the dwell and the
     reader drive one mechanism rather than two. The first deliberate input
     retires the timer for as long as the section stays open; re-opening it
     starts the cycle again. */
  function stopCycle() { clearInterval(cycleTimer); cycleTimer = null; }

  function startCycle() {
    stopCycle();
    var p = PAGES[page];
    if (!p || !p.cycle || p.art.length < 2) return;
    cycleTimer = setInterval(function () {
      var next = Math.round(window.scrollY / vh) + 1;
      window.scrollTo({ top: next * vh, behavior: reduced ? 'auto' : 'smooth' });
    }, p.cycle);
  }

  /* Reading takes precedence over the dwell: any deliberate input stops the
     cycle. It comes back once the reader has been still for a while, so a
     section left alone carries on showing itself rather than sitting on
     whichever item they happened to stop on. */
  var IDLE_RESUME = 5000;
  var idleTimer = null;

  function readerActive() {
    if (!page) return;
    stopCycle();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { if (page) startCycle(); }, IDLE_RESUME);
  }

  ['wheel', 'touchstart', 'keydown'].forEach(function (ev) {
    window.addEventListener(ev, readerActive, { passive: true });
  });


  function openPage(key) {
    if (!PAGES[key]) return;
    page = key;
    painted = 0;
    layoutTrack();
    seat();                     // land on the first stop, same as the views do
    paintCopy();
    pageEl.hidden = false;
    backEl.hidden = false;
    dock.hidden = true;
    document.body.classList.remove('menu-open');
    document.body.classList.add('page-open');
    render();                   // put the artwork up now...
    glitchCopy();
    cut();                      // ...then glitch it into place over the top
    startCycle();
  }

  function closePage() {
    stopCycle();
    clearTimeout(idleTimer);
    clearInterval(scrambleTimer); scrambleTimer = null;
    page = null;
    painted = -1;
    pageEl.hidden = true;
    backEl.hidden = true;
    dock.hidden = false;
    document.body.classList.remove('page-open');
    settleDock();
    layoutTrack();
    seat();
    flash();
  }

  /* The note types itself out from the centre, holds, then backspaces away.
     Typing runs centred so the line grows from the middle; before deleting,
     the left edge is pinned where it landed so characters come off the end
     the way they would in a text file rather than collapsing inward. */
  var TYPE = 42, HOLD = 3000, ERASE = 26;   // ms per character / pause / per character
  var BLINK = 530;                          // caret flash while nothing is being typed
  var CARET = '|';
  var blinkTimer = null;

  function stopBlink() { clearInterval(blinkTimer); blinkTimer = null; }

  function say(msg) {
    clearTimeout(typeTimer);
    stopBlink();

    /* Fix the left edge up front, measured off the finished line, so the text
       only ever grows to the right and shrinks back the same way — it never
       slides sideways part-way through. The completed line still reads as
       centred; it is simply anchored where it will end up rather than being
       re-centred on every character. */
    note.textContent = msg + CARET;
    var full = note.getBoundingClientRect().width;
    note.style.left = Math.round((dock.getBoundingClientRect().width - full) / 2) + 'px';

    var n = 0;
    (function typeOn() {
      note.textContent = msg.slice(0, ++n) + CARET;
      if (n < msg.length) { typeTimer = setTimeout(typeOn, TYPE); return; }

      /* Nothing is being typed now, so the caret flashes the way a text
         cursor does at rest. A space stands in for the bar on the off beat —
         same width in a mono face, so the line doesn't twitch as it blinks. */
      var lit = true;
      blinkTimer = setInterval(function () {
        lit = !lit;
        note.textContent = msg + (lit ? CARET : ' ');
      }, BLINK);

      typeTimer = setTimeout(function () {
        stopBlink();
        (function typeOff() {
          note.textContent = msg.slice(0, --n) + (n ? CARET : '');
          if (n) { typeTimer = setTimeout(typeOff, ERASE); return; }
          note.textContent = '';
        })();
      }, HOLD);
    })();
  }

  /* Clipboard access can be refused outright — an insecure origin, or the
     user declining. Fall back to putting the address on screen so it can
     still be read off and typed. */
  function copyEmail() {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(EMAIL).then(
        function () { say('email copied to clipboard'); },
        function () { say(EMAIL); }
      );
    } else {
      say(EMAIL);
    }
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target : e.target.parentElement;
    var a = el && el.closest ? el.closest('a') : null;

    /* Tapping the lockup works the menu, since a touch screen has no hover to
       open it with. Once the links are up they cover the wordmark, so the way
       back out is a tap anywhere off the lockup — or a swipe down. */
    if (document.body.classList.contains('menu-open') &&
        (!el || !el.closest || !el.closest('.dock'))) {
      document.body.classList.remove('menu-open');
    }

    if (!a) return;

    if (a.classList.contains('brand')) {
      e.preventDefault();
      if (!page) document.body.classList.toggle('menu-open');
      return;
    }

    if (a.dataset.page) { e.preventDefault(); openPage(a.dataset.page); return; }
    if (a.dataset.act === 'contact') { e.preventDefault(); copyEmail(); return; }
    if (a === backEl) { e.preventDefault(); closePage(); return; }

    /* The wordmark still points at "#". Letting it resolve would jump the
       page to the top and throw away whichever view you were on. */
    if (a.getAttribute('href') === '#') e.preventDefault();
  });

  /* The links come up on hover; `menu-open` carries the artwork out with
     the wordmark, so the two move on the same beat. Focus counts as hover
     so the lockup is reachable from the keyboard. */
  function menu(on) {
    return function () {
      if (page) return;
      document.body.classList.toggle('menu-open', on);

      /* Second line of defence for the same Safari issue: repaint once now
         and once after the fade has finished, so a backing store dropped at
         either end can't leave the artwork blank. A canvas is never redrawn
         by the browser, so without this the frame is gone for good. */
      if (animating) return;
      render();
      setTimeout(function () { if (!animating) render(); }, 320);
    };
  }
  /* Last known pointer position. No pointerenter fires for an element that
     appears underneath a cursor that hasn't moved, so returning from a
     section has to look the pointer up rather than wait to be told. */
  var ptr = { x: -1, y: -1 };
  window.addEventListener('pointermove', function (e) {
    ptr.x = e.clientX; ptr.y = e.clientY;
  }, { passive: true });

  /* If the pointer is already over the lockup as it comes back, the links
     belong up immediately — fading them in would animate a state the user
     is already pointing at. */
  function settleDock() {
    if (ptr.x < 0) return;
    var under = document.elementFromPoint(ptr.x, ptr.y);
    if (!under || !dock.contains(under)) return;

    /* Suppress the transition, commit the open state, then hand the
       transition straight back. The reflow between the two is what makes it
       land un-animated — no class or timer is left behind to strand the
       animation if anything interrupts. */
    var linksEl = dock.querySelector('.links');
    brand.style.transition = 'none';
    linksEl.style.transition = 'none';
    document.body.classList.add('menu-open');
    void dock.offsetWidth;
    brand.style.transition = '';
    linksEl.style.transition = '';
  }

  dock.addEventListener('pointerenter', menu(true));
  dock.addEventListener('pointerleave', menu(false));
  dock.addEventListener('focusin', menu(true));
  dock.addEventListener('focusout', menu(false));

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && page) closePage();
  });

  /* rAF stops in a background tab, which would otherwise leave a
     half-finished glitch frozen on screen until the tab is focused again.
     Settle it the moment we come back. */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && animating) {
      animating = false;
      current = to;
      if (page) { painted = current; paintList(); }
      render();
    }
  });

  /* Follow the system setting. The plates are scheme-specific, so they have
     to be rebuilt before anything is drawn again. */
  function onScheme(e) {
    dark = e.matches;
    dots = dotPattern();
    VIEWS.forEach(dress);
    ART.forEach(dress);
    render();
  }
  if (scheme.addEventListener) scheme.addEventListener('change', onScheme);
  else if (scheme.addListener) scheme.addListener(onScheme);

  /* Under a finger the two axes mean different things, and the page itself
     never scrolls: a single-finger drag is always ours.

     Across  moves through the views. Scroll position stays the single source
             of truth — the drag just writes to it — so the bleed, the
             threshold and the cut behave exactly as they do on the wheel,
             and the channel split runs along the gesture. Snapping is
             suspended for the duration or it would fight every intermediate
             position, then restored so the release settles on a view.

     Up/down works the bottom lockup instead: up brings the links out, down
             puts them away. It never touches the scroll, so it shifts no
             colour — the artwork sits perfectly still through it. */
  var SWIPE_SPAN = 0.7;       // fraction of the screen width worth one view
  var MENU_SWIPE = 40;        // vertical travel that opens or closes the menu

  function onTouchStart(e) {
    swipe = null;
    if (e.touches.length !== 1) return;           // leave pinch-zoom alone
    swipe = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      y0: window.scrollY,
      axis: null,
      menuDone: false
    };
  }

  function onTouchMove(e) {
    if (!swipe || e.touches.length !== 1) return;

    var dx = e.touches[0].clientX - swipe.x;
    var dy = e.touches[0].clientY - swipe.y;

    if (swipe.axis === null) {                    // wait for a clear direction
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      swipe.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (swipe.axis === 'x') {
        document.documentElement.style.scrollSnapType = 'none';
        beginGesture();                           // colour bleeds with the drag
      }
    }

    e.preventDefault();                           // the page never scrolls under a finger

    if (swipe.axis === 'x') {
      if (fixed()) { shakeBy(dx - (swipe.lastDx || 0)); swipe.lastDx = dx; return; }
      beginGesture();
      window.scrollTo(0, swipe.y0 - dx * (vh / (vw * SWIPE_SPAN)));
      return;
    }

    // vertical: the menu, once per gesture, and nothing else
    if (swipe.menuDone || page || Math.abs(dy) < MENU_SWIPE) return;
    swipe.menuDone = true;
    document.body.classList.toggle('menu-open', dy < 0);
  }

  function onTouchEnd() {
    if (swipe && swipe.axis === 'x') {
      document.documentElement.style.scrollSnapType = '';
      window.scrollTo({ top: Math.round(window.scrollY / vh) * vh, behavior: 'smooth' });
    }
    swipe = null;
    endGesture();
  }

  /* On a section that cannot scroll the wheel drives the glitch directly.
     Letting go eases it back through the same release the scroll uses. */
  function shakeBy(amount) {
    if (!shakeable()) return;   // this section holds still under the scroll
    beginGesture();
    still = Math.min(still + Math.abs(amount) / 500, 1);
    if (!animating && !releasing) {
      var st = scrollState();
      draw(current, st.g, st.t);
    }
  }

  window.addEventListener('wheel', function (e) {
    if (fixed()) { shakeBy(e.deltaY); return; }
    beginGesture();
  }, { passive: true });
  window.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('touchend', onTouchEnd, { passive: true });
  window.addEventListener('touchcancel', onTouchEnd, { passive: true });

  window.addEventListener('scroll', onScroll, { passive: true });
  if ('onscrollend' in window) window.addEventListener('scrollend', wrap);

  window.addEventListener('resize', function () {
    var wasRotated = rotated;
    resize();
    window.scrollTo(0, (N + current) * vh);

    /* Glitch through the flip in either direction — pulled narrower or
       pushed back out. */
    if (rotated !== wasRotated) flash();
    else render();
  });

  function seat() {
    spent = false;
    window.scrollTo(0, count() * vh);       // middle lap, first stop
    current = from = to = viewAt();
    painted = page ? current : -1;
    render();
  }

  resize();
  seat();

  /* If the track isn't its full height yet the jump above clamps to 0,
     which costs us the runway needed to scroll backwards. Re-seat once
     everything has loaded. */
  if (Math.abs(window.scrollY - N * vh) > 1) {
    window.addEventListener('load', function () { resize(); seat(); }, { once: true });
  }
})();
