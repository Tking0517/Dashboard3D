// REC ROOM · LUT applier
//
// Parses Adobe .cube 3D LUT files and applies them to a 2D canvas via
// WebGL2. The composite draw loop calls applyTo(srcCanvas, amount)
// AFTER the filtered cam tiles land but BEFORE the borders, so only
// camera pixels get graded — the chrome stays clean.
//
// Surface:
//   parseCube(text)        → { size, data: Float32Array(size**3 * 3) }
//   setupLutApplier()      → { applyTo, loadFromPath, hasLut, getKey,
//                              getCanvas, dispose } | null
//
// Returns null if WebGL2 isn't available, so the caller can simply
// skip LUT compositing.

export function parseCube(text) {
  // .cube format (Adobe spec): "#" comments, optional TITLE,
  // LUT_3D_SIZE N, optional DOMAIN_MIN/DOMAIN_MAX, then N**3 lines
  // of "R G B" floats. Order: R changes fastest, then G, then B.
  // WebGL's texImage3D with depth=z reads the same memory layout
  // (X fastest, Y, Z slowest) so the file bytes drop in untouched.
  const lines = text.split(/\r?\n/);
  let size = 0;
  const samples = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('TITLE')) continue;
    if (line.startsWith('DOMAIN_')) continue;
    if (line.startsWith('LUT_1D_SIZE')) {
      throw new Error('1D LUTs not supported (need LUT_3D_SIZE)');
    }
    if (line.startsWith('LUT_3D_SIZE')) {
      const parts = line.split(/\s+/);
      size = parseInt(parts[1], 10) | 0;
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const r = parseFloat(parts[0]);
    const g = parseFloat(parts[1]);
    const b = parseFloat(parts[2]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;
    samples.push(r, g, b);
  }
  if (!size) throw new Error('LUT_3D_SIZE not found');
  const expected = size * size * size * 3;
  if (samples.length !== expected) {
    throw new Error(`LUT sample count mismatch: got ${samples.length / 3}, expected ${size ** 3}`);
  }
  return { size, data: new Float32Array(samples) };
}

export function setupLutApplier() {
  const glCanvas = document.createElement('canvas');
  const gl = glCanvas.getContext('webgl2', {
    premultipliedAlpha: false,
    preserveDrawingBuffer: true, // composite reads from us via drawImage
    antialias: false,
  });
  if (!gl) {
    console.warn('[lut] WebGL2 unavailable — LUT compositing disabled');
    return null;
  }

  // EXT_color_buffer_float lets us use RGB32F textures (needed for
  // accurate 3D-LUT sampling). OES_texture_float_linear enables LINEAR
  // filtering on float textures — without it the LUT only does nearest
  // lookup, which posterizes the grade. Both are widely supported in
  // Chromium/Electron desktop, but we degrade gracefully if missing.
  gl.getExtension('EXT_color_buffer_float');
  const hasFloatLinear = !!gl.getExtension('OES_texture_float_linear');

  const VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // Map clip-space [-1,1] to UV [0,1].
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

  const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_src;
uniform sampler3D u_lut;
uniform float u_size;
uniform float u_amount;
void main() {
  // Flip Y so the WebGL framebuffer matches the source canvas
  // orientation — the 2D canvas is top-origin, GL is bottom-origin.
  vec4 src = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
  // Pull texel-center sampling so the grade hits cell centers
  // (otherwise the endpoints get clipped by half a cell each side).
  float scale = (u_size - 1.0) / u_size;
  float offset = 1.0 / (2.0 * u_size);
  vec3 luv = clamp(src.rgb, 0.0, 1.0) * scale + offset;
  vec3 graded = texture(u_lut, luv).rgb;
  outColor = vec4(mix(src.rgb, graded, u_amount), src.a);
}`;

  function compile(type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || 'shader compile failed';
      gl.deleteShader(sh);
      throw new Error(log);
    }
    return sh;
  }
  let vs, fs, prog;
  try {
    vs = compile(gl.VERTEX_SHADER, VS);
    fs = compile(gl.FRAGMENT_SHADER, FS);
    prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) || 'program link failed');
    }
  } catch (err) {
    console.warn('[lut] shader setup failed:', err?.message || err);
    return null;
  }
  const u_src    = gl.getUniformLocation(prog, 'u_src');
  const u_lut    = gl.getUniformLocation(prog, 'u_lut');
  const u_size   = gl.getUniformLocation(prog, 'u_size');
  const u_amount = gl.getUniformLocation(prog, 'u_amount');

  // Fullscreen triangle (3 verts cover the screen — cheaper than a
  // quad and avoids the diagonal seam between two triangles).
  const verts = new Float32Array([-1, -1, 3, -1, -1, 3]);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // Source 2D texture — reused each frame; the composite canvas
  // replaces its contents via texImage2D.
  const srcTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  let lutTex = null;
  let lutSize = 0;
  let lutKey = null;       // path of the currently-loaded LUT (or null)
  let loadingKey = null;   // path of an in-flight load (so we don't double-fire)

  function uploadLut(parsed) {
    if (lutTex) {
      try { gl.deleteTexture(lutTex); } catch {}
      lutTex = null;
    }
    lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, lutTex);
    const filter = hasFloatLinear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    lutSize = parsed.size;
    gl.texImage3D(
      gl.TEXTURE_3D, 0, gl.RGB32F,
      lutSize, lutSize, lutSize, 0,
      gl.RGB, gl.FLOAT, parsed.data,
    );
  }

  async function loadFromPath(path) {
    // Idempotent: re-calling with the same path is a no-op once loaded.
    if (path === lutKey) return !!lutTex;
    if (path === loadingKey) return !!lutTex;
    if (!path) {
      // OFF — drop the current GPU resident.
      lutKey = null;
      loadingKey = null;
      if (lutTex) {
        try { gl.deleteTexture(lutTex); } catch {}
        lutTex = null;
      }
      return false;
    }
    loadingKey = path;
    try {
      const res = await window.dash?.lutRead?.(path);
      if (!res?.ok) throw new Error(res?.error || 'lutRead returned !ok');
      const parsed = parseCube(res.text || '');
      // The selection may have changed during the await — only commit
      // if we're still the most recent load request.
      if (loadingKey !== path) return !!lutTex;
      uploadLut(parsed);
      lutKey = path;
      loadingKey = null;
      return true;
    } catch (err) {
      console.warn('[lut] load failed for', path, ':', err?.message || err);
      if (loadingKey === path) loadingKey = null;
      lutKey = null;
      if (lutTex) {
        try { gl.deleteTexture(lutTex); } catch {}
        lutTex = null;
      }
      return false;
    }
  }

  function applyTo(srcCanvas, amount) {
    if (!lutTex) return false;
    const W = srcCanvas.width | 0;
    const H = srcCanvas.height | 0;
    if (!W || !H) return false;
    if (glCanvas.width !== W)  glCanvas.width  = W;
    if (glCanvas.height !== H) glCanvas.height = H;
    gl.viewport(0, 0, W, H);

    gl.useProgram(prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    // texImage2D from an HTMLCanvasElement upload IS the fast path —
    // Chromium recognizes it and uses a GPU-side copy when both contexts
    // live on the same device.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
    gl.uniform1i(u_src, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lutTex);
    gl.uniform1i(u_lut, 1);

    gl.uniform1f(u_size, lutSize);
    gl.uniform1f(u_amount, Math.max(0, Math.min(1, amount)));

    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    return true;
  }

  function dispose() {
    try { if (lutTex) gl.deleteTexture(lutTex); } catch {}
    try { gl.deleteTexture(srcTex); } catch {}
    try { gl.deleteProgram(prog); } catch {}
    try { gl.deleteShader(vs); gl.deleteShader(fs); } catch {}
    try { gl.deleteBuffer(vbo); gl.deleteVertexArray(vao); } catch {}
    lutTex = null;
    lutKey = null;
    loadingKey = null;
  }

  return {
    applyTo,
    loadFromPath,
    hasLut: () => !!lutTex,
    getKey: () => lutKey,
    getCanvas: () => glCanvas,
    dispose,
  };
}
