import{r as P,j as Ie}from"./index-DP-5BigZ.js";const Ge=8,se=4,ue=24,Pe=1.2,Oe=.7,Xe=.015,st=2.4,Q=60,q=100,ut=16,lt=.78,ke=["#1e3fd8","#f6f8ff","#a5d8ff","#38bdf8"],Ne=" =+xX0S8#@",qe='"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',ft={horizon:0,pinch:1,rise:2,eclipse:3},mt={none:0,wave:1,burst:2},dt=`#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`,Ve=`
float hash12(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
`,ht=`#version 300 es
precision highp float;
precision highp int;
uniform float uAspect;
uniform float uTime;
uniform int uShape;
uniform vec3 uRamp[8];
uniform int uCount;
uniform float uScale;
uniform float uSoftness;
uniform float uFlow;
uniform vec2 uSeed;
uniform vec4 uTrail[24];
uniform float uRadius;
uniform vec4 uClicks[4];
uniform int uClickEffect;
uniform float uIntro;
uniform float uFrame;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outAux;
${Ve}
vec2 hash22(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy) * 2.0 - 1.0;
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash22(i), f);
  float b = dot(hash22(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(hash22(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(hash22(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return 0.5 + 0.5 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec3 labToRgb(vec3 lab) {
  float l = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  l = l * l * l;
  m = m * m * m;
  s = s * s * s;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}

vec3 encode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec3 horizon(vec2 p, float time, out float order) {
  float span = 0.5 * max(uAspect, 1.0);
  float x = p.x / span;
  float arch = -0.17 - 0.2 * x * x + 0.02 * sin(time * 0.6);
  float soft = mix(0.05, 0.22, uSoftness);
  float edge = p.y - arch;
  float rim = 0.38 * smoothstep(-soft, 0.42, edge);
  vec2 sun = vec2(0.08 * sin(time * 0.31) * span, 0.58);
  float spread = length((p - sun) / vec2(0.95 * span, 0.75));
  float sky = mix(0.55, 1.0, smoothstep(0.2, 0.95, spread));
  order = clamp(edge * 1.3, 0.0, 1.0);
  return vec3(rim, sky, smoothstep(0.18, 0.62, edge));
}

vec3 pinch(vec2 p, float time, out float order) {
  float span = 0.5 * max(uAspect, 0.75);
  float x = p.x / span;
  float sway = 0.02 * sin(x * 1.7 + time * 0.55);
  float breathe = 1.0 + 0.06 * sin(time * 0.8);
  float width = (0.13 + 0.22 * x * x) * breathe * mix(0.85, 1.2, uSoftness);
  float y = abs(p.y - sway) / width;
  float t = exp(-pow(y, 2.2)) * (0.42 + 0.58 * exp(-x * x * 1.8));
  order = clamp(abs(p.y - sway) * 2.4 + abs(x) * 0.3, 0.0, 1.0);
  return vec3(t, t, 0.0);
}

vec3 rise(vec2 p, float time, out float order) {
  float wide = max(uAspect, 0.9);
  vec2 center = vec2(0.05 * sin(time * 0.45) * wide, -0.7);
  vec2 radius = vec2(0.82 * wide, 0.64 * (1.0 + 0.04 * sin(time * 0.8)));
  float d = length((p - center) / radius);
  float soft = mix(0.6, 1.15, uSoftness);
  float t = clamp(pow(clamp(1.0 - d, 0.0, 1.0), soft) * 1.35, 0.0, 1.0);
  order = clamp((d - 0.2) * 1.3, 0.0, 1.0);
  return vec3(t, t, 0.0);
}

vec3 eclipse(vec2 p, float time, out float order) {
  float fit = min(1.0, uAspect * 1.25);
  float r = 0.23 * fit * (1.0 + 0.015 * sin(time * 0.9));
  float angle = atan(p.y, p.x);
  float rays = noise(vec2(cos(angle), sin(angle)) * 2.2 + time * 0.08) * 0.8 + 0.6;
  float d = length(p) - r;
  float reach = mix(0.07, 0.15, uSoftness) * rays * fit;
  float t = smoothstep(-0.006, 0.006 + 0.02 * uSoftness, d) * exp(-max(d, 0.0) / reach);
  order = clamp(d * 2.0, 0.0, 1.0);
  return vec3(t, t, 0.0);
}

vec4 tone(float t) {
  float x = smoothstep(0.3, 1.0, t) * float(uCount - 1);
  int index = int(floor(x));
  return vec4(mix(uRamp[index], uRamp[min(index + 1, uCount - 1)], fract(x)), smoothstep(0.0, 0.38, t));
}

void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float time = uTime;
  vec2 q = p / uScale;
  vec2 warp = vec2(
    noise(q * 1.6 + uSeed + vec2(0.0, time * 0.3)),
    noise(q * 1.6 + uSeed.yx + vec2(4.3, -time * 0.24))
  ) - 0.5;
  q += warp * uFlow * (uShape == 3 ? 0.04 : 0.18);
  float order = 0.0;
  vec3 shape;
  if (uShape == 0) shape = horizon(q, time, order);
  else if (uShape == 1) shape = pinch(q, time, order);
  else if (uShape == 2) shape = rise(q, time, order);
  else shape = eclipse(q, time, order);

  float reveal = clamp((uIntro * 1.45 - order) / 0.45, 0.0, 1.0);
  reveal = reveal * reveal * (3.0 - 2.0 * reveal);

  float scramble = 0.0;
  for (int i = 0; i < 24; i++) {
    vec4 point = uTrail[i];
    if (point.z <= 0.0) continue;
    vec2 d = p - point.xy;
    scramble = max(scramble, point.z * exp(-dot(d, d) / (uRadius * uRadius)));
  }
  for (int i = 0; i < 4; i++) {
    vec4 c = uClicks[i];
    if (c.w <= 0.0) continue;
    float d = length(p - c.xy);
    if (uClickEffect == 1) {
      scramble = max(scramble, exp(-pow((d - c.z * 0.75) / 0.06, 2.0)) * c.w);
    } else if (uClickEffect == 2) {
      float size = 0.08 + 0.22 * (1.0 - exp(-c.z * 5.0));
      scramble = max(scramble, (1.0 - smoothstep(size * 0.6, size, d)) * c.w);
    }
  }
  vec2 t = clamp(shape.xy * mix(0.7, 1.0, reveal), 0.0, 1.0);
  vec4 mixed = mix(tone(t.x), tone(t.y), shape.z);
  vec3 color = encode(labToRgb(mixed.rgb));
  float alpha = mixed.a * reveal;
  float dither = (hash12(gl_FragCoord.xy + uFrame * 13.7) - 0.5) / 255.0;
  outColor = clamp(vec4(color * alpha + dither, alpha + dither), 0.0, 1.0);
  outAux = vec4(reveal, scramble, 0.0, 1.0);
}`,$e=`
uniform sampler2D uField;
uniform sampler2D uAux;
uniform sampler2D uAtlas;
uniform vec2 uResolution;
uniform vec2 uCell;
uniform vec2 uOffset;
uniform vec2 uAtlasGrid;
uniform float uCount;
uniform float uDensity;
uniform float uOpacity;
uniform float uFlicker;
uniform float uDepth;
uniform float uGlyphTime;
uniform float uSeedValue;
uniform float uLight;
${Ve}
float sampleGlyph(float index, vec2 local, vec2 coord, float soft) {
  float column = mod(index, uAtlasGrid.x);
  float row = floor(index / uAtlasGrid.x);
  vec2 atlasUv = vec2((column + local.x) / uAtlasGrid.x, (row + 1.0 - local.y) / uAtlasGrid.y);
  vec2 continuous = coord / uAtlasGrid;
  float scale = exp2(soft);
  return textureGrad(uAtlas, atlasUv, dFdx(continuous) * scale, dFdy(continuous) * scale).a;
}

vec4 glyphAt(vec2 px) {
  vec2 coord = (px - uOffset) / uCell;
  vec2 cell = floor(coord);
  vec2 local = coord - cell;
  vec2 uv = clamp(((cell + 0.5) * uCell + uOffset) / uResolution, vec2(0.0), vec2(1.0));
  vec4 field = texture(uField, uv);
  vec4 aux = texture(uAux, uv);
  vec3 visible = uLight > 0.5 ? field.rgb + (1.0 - field.a) : field.rgb;
  float luma = dot(visible, vec3(0.2126, 0.7152, 0.0722));
  float value = uLight > 0.5 ? clamp((1.0 - luma) * 1.5, 0.0, 1.0) : luma;
  float pick = hash12(cell + uSeedValue * 7.31);
  float level = hash12(cell * 1.73 + 4.1 + uSeedValue);
  float tick = floor(uGlyphTime * 9.0 + level * 9.0);
  float wobble = (hash12(cell * 2.31 + tick * 17.7) - 0.5) * uFlicker * 0.4 + (level - 0.5) * 0.1;
  float tone = clamp(pow(value, 0.75) + wobble, 0.0, 1.0);
  float index = floor(tone * (uCount - 1.0) + 0.5);
  float decode = max(aux.g, 1.0 - aux.r);
  if (decode > 0.02) {
    float frame = floor(uGlyphTime * 20.0);
    if (hash12(cell * 3.7 + frame * 5.3) < decode * 1.25) index = 1.0 + floor(hash12(cell + frame * 1.37) * (uCount - 1.0));
  }
  float present = step(pick, uDensity * mix(1.0, 0.3 + tone * 1.1, 0.55));
  float cutoff = smoothstep(0.03, 0.1, value);
  float focus = step(hash12(cell * 0.71 + 9.2 + uSeedValue), uDepth);
  float coverage = sampleGlyph(index, local, coord, focus * 1.2);
  float alpha = uOpacity * present * cutoff * coverage * mix(1.0, 0.35 + 0.65 * level, 0.55) * (1.0 - focus * 0.5);
  if (uLight < 0.5) {
    vec3 light = field.rgb * 0.55 + vec3(0.03) * field.a;
    return vec4(light * alpha, 0.6 * field.a * alpha);
  }
  vec3 ink = visible * 0.8;
  return vec4(ink * alpha, alpha);
}
`,pt=`#version 300 es
precision highp float;
uniform float uDownscale;
in vec2 vUv;
out vec4 outColor;
${$e}
void main() {
  outColor = glyphAt(gl_FragCoord.xy * uDownscale);
}`,vt=`#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uStep;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 sum = texture(uSource, vUv) * 0.2270270270;
  sum += texture(uSource, vUv + uStep * 1.3846153846) * 0.3162162162;
  sum += texture(uSource, vUv - uStep * 1.3846153846) * 0.3162162162;
  sum += texture(uSource, vUv + uStep * 3.2307692308) * 0.0702702703;
  sum += texture(uSource, vUv - uStep * 3.2307692308) * 0.0702702703;
  outColor = sum;
}`,xt=`#version 300 es
precision highp float;
uniform sampler2D uHalo;
uniform float uGlow;
uniform float uGradient;
uniform float uGrain;
uniform float uFrame;
in vec2 vUv;
out vec4 outColor;
${$e}
void main() {
  vec4 base = texture(uField, vUv) * uGradient;
  vec4 glyph = glyphAt(gl_FragCoord.xy);
  vec4 halo = texture(uHalo, vUv) * uGlow;
  vec4 color;
  if (uLight < 0.5) {
    color = base + glyph + halo;
  } else {
    color = glyph + base * (1.0 - glyph.a);
    color += halo * 0.6 * (1.0 - color.a);
  }
  float grain = (hash12(gl_FragCoord.xy + uFrame * vec2(17.0, 59.0)) + hash12(gl_FragCoord.xy * 1.31 + uFrame * 7.0) - 1.0) * uGrain;
  float body = clamp(color.a, 0.0, 1.0);
  color.rgb += grain * (0.25 + body) * 0.5;
  color.a = clamp(color.a, 0.0, 1.0);
  color.rgb = clamp(color.rgb, 0.0, color.a);
  outColor = color;
}`,p=(t,s,u)=>Math.min(u,Math.max(s,t)),le=t=>t<=.04045?t/12.92:((t+.055)/1.055)**2.4,Et=([t,s,u])=>{const n=le(t),l=le(s),f=le(u),g=Math.cbrt(.4122214708*n+.5363325363*l+.0514459929*f),T=Math.cbrt(.2119034982*n+.6806995451*l+.1073969566*f),v=Math.cbrt(.0883024619*n+.2817188376*l+.6299787005*f);return[.2104542553*g+.793617785*T-.0040720468*v,1.9779984951*g-2.428592205*T+.4505937099*v,.0259040371*g+.7827717662*T-.808675766*v]},ze=(t,s,u)=>{const n=t.createShader(s);return n?(t.shaderSource(n,u),t.compileShader(n),n):null},J=(t,s)=>{const u=ze(t,t.VERTEX_SHADER,dt),n=ze(t,t.FRAGMENT_SHADER,s),l=t.createProgram();return!u||!n||!l?null:(t.attachShader(l,u),t.attachShader(l,n),t.linkProgram(l),t.deleteShader(u),t.deleteShader(n),{program:l,uniforms:{}})},Be=(t,s)=>{if(!t.getProgramParameter(s.program,t.LINK_STATUS))return!1;const u=t.getProgramParameter(s.program,t.ACTIVE_UNIFORMS);for(let n=0;n<u;n++){const l=t.getActiveUniform(s.program,n);if(!l)continue;const f=l.name.replace(/\[0\]$/,"");s.uniforms[f]=t.getUniformLocation(s.program,f)}return!0},fe=(t,s)=>({textures:Array.from({length:s},()=>{const n=t.createTexture();return t.bindTexture(t.TEXTURE_2D,n),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),n}),framebuffer:t.createFramebuffer(),width:0,height:0}),me=(t,s,u,n)=>{s.width===u&&s.height===n||(s.width=u,s.height=n,t.bindFramebuffer(t.FRAMEBUFFER,s.framebuffer),s.textures.forEach((l,f)=>{t.bindTexture(t.TEXTURE_2D,l),t.texImage2D(t.TEXTURE_2D,0,t.RGBA8,u,n,0,t.RGBA,t.UNSIGNED_BYTE,null),t.framebufferTexture2D(t.FRAMEBUFFER,t.COLOR_ATTACHMENT0+f,t.TEXTURE_2D,l,0)}),t.bindFramebuffer(t.FRAMEBUFFER,null))},He=(t,s,u)=>{const n=[...new Set([...s].filter(F=>F!==`
`&&F!=="\r"))];n.length||n.push(" ");const l=`300 ${Math.round(q*lt)}px ${u}`,f=Math.min(ut,n.length),g=Math.ceil(n.length/f),T=document.createElement("canvas");T.width=Q*f,T.height=q*g;const v=T.getContext("2d");v&&(v.font=l,v.textAlign="center",v.textBaseline="middle",v.fillStyle="#fff",n.forEach((F,B)=>{const Z=B%f,ee=Math.floor(B/f);v.fillText(F,Z*Q+Q/2,ee*q+q/2+3)}));const z=t.createTexture();return t.bindTexture(t.TEXTURE_2D,z),t.pixelStorei(t.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!1),t.texImage2D(t.TEXTURE_2D,0,t.RGBA8,t.RGBA,t.UNSIGNED_BYTE,T),t.generateMipmap(t.TEXTURE_2D),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR_MIPMAP_LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),{texture:z,count:n.length,grid:[f,g]}},yt=({colors:t=ke,shape:s="horizon",characters:u=Ne,cellSize:n=18,density:l=.8,glyphOpacity:f=.85,glow:g=.2,depthOfField:T=0,flicker:v=.2,softness:z=.5,scale:F=1,flow:B=.5,speed:Z=1,gradientOpacity:ee=.9,grain:We=.08,variation:Ke=0,mouseInteraction:je=!0,scrambleRadius:Ye=.1,clickEffect:Je="wave",intro:Qe=!0,lightMode:Ze=!1,fontFamily:et=qe,dpr:tt,className:de="",style:ot,...rt})=>{const he=P.useRef(null),pe=P.useRef(null),te=P.useRef(null),H=(Array.isArray(t)&&t.length?t:ke).slice(0,Ge),ve={colors:H.length>1?H:[H[0],H[0]],shape:ft[s]??0,characters:u||Ne,cellSize:p(n,6,64),density:p(l,0,1),glyphOpacity:p(f,0,1),glow:p(g,0,2),depthOfField:p(T,0,1),flicker:p(v,0,1),softness:p(z,0,1),scale:p(F,.4,2.5),flow:p(B,0,2),speed:Math.max(0,Z),gradientOpacity:p(ee,0,1),grain:p(We,0,.4),variation:Math.max(0,Ke),mouseInteraction:je,scrambleRadius:p(Ye,.02,.4),clickEffect:mt[Je]??1,intro:Qe,lightMode:Ze,fontFamily:et||qe,dpr:tt},y=P.useRef(ve);return y.current=ve,P.useEffect(()=>{const M=he.current,m=pe.current,e=m?.getContext("webgl2",{alpha:!0,premultipliedAlpha:!0,antialias:!1,depth:!1,stencil:!1});if(!M||!m||!e)return;const V=e.getExtension("KHR_parallel_shader_compile"),$=J(e,ht),O=J(e,pt),C=J(e,vt),X=J(e,xt);if(!$||!O||!C||!X)return;const L=[$,O,C,X];if(!V&&!L.every(o=>Be(e,o))){L.forEach(o=>e.deleteProgram(o.program));return}const xe=e.createVertexArray(),_=fe(e,2),E=fe(e,1),W=fe(e,1),U=document.createElement("canvas").getContext("2d",{willReadFrequently:!0}),Ee=new Map,at=o=>{const a=String(o),r=Ee.get(a);if(r)return r;let c=[0,0,0];if(U){U.clearRect(0,0,1,1),U.fillStyle="#000000",U.fillStyle=a,U.fillRect(0,0,1,1);const[i,b,w]=U.getImageData(0,0,1,1).data;c=[i/255,b/255,w/255]}return Ee.set(a,c),c},S=window.matchMedia?.("(prefers-reduced-motion: reduce)").matches??!1,R={width:1,height:1,ratio:1},Te=new Float32Array(Ge*3),oe=new Float32Array(se*4),A=[],re=new Float32Array(ue*4),x=[],h={x:0,y:0,inside:!1};let d=null,ae="",ye="",Re=0,Ae=0,k=y.current.intro&&!S?0:1,K=0,ne=0,D=0,I=0,j=!0,N=!1,Y=!V;const be=()=>!V||L.every(o=>e.getProgramParameter(o.program,V.COMPLETION_STATUS_KHR)),ge=()=>{if(!e.isContextLost()){if(!Y&&!be()){requestAnimationFrame(ge);return}L.forEach(o=>e.deleteProgram(o.program))}},nt=()=>{const o=y.current,a=`${o.fontFamily}|${o.characters}`;a===ae&&d||(ae=a,d&&e.deleteTexture(d.texture),d=He(e,o.characters,o.fontFamily),document.fonts?.load?.(`300 64px ${o.fontFamily}`,o.characters).then(()=>{N||ae!==a||(d&&e.deleteTexture(d.texture),d=He(e,o.characters,o.fontFamily),ie())},()=>{}))},it=()=>{const o=y.current,a=o.colors.join(",");a!==ye&&(ye=a,o.colors.forEach((r,c)=>Te.set(Et(at(r)),c*3)))},we=(o,a,r)=>{if(!d)return;const c=y.current,i=o.uniforms,b=c.cellSize*R.ratio,w=b*(Q/q);e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,_.textures[0]),e.uniform1i(i.uField,0),e.activeTexture(e.TEXTURE1),e.bindTexture(e.TEXTURE_2D,_.textures[1]),e.uniform1i(i.uAux,1),e.activeTexture(e.TEXTURE2),e.bindTexture(e.TEXTURE_2D,d.texture),e.uniform1i(i.uAtlas,2),e.uniform2f(i.uResolution,a,r),e.uniform2f(i.uCell,w,b),e.uniform2f(i.uOffset,(a-Math.ceil(a/w)*w)/2,(r-Math.ceil(r/b)*b)/2),e.uniform2f(i.uAtlasGrid,d.grid[0],d.grid[1]),e.uniform1f(i.uCount,d.count),e.uniform1f(i.uDensity,c.density),e.uniform1f(i.uOpacity,c.glyphOpacity),e.uniform1f(i.uFlicker,S?0:c.flicker),e.uniform1f(i.uDepth,c.depthOfField),e.uniform1f(i.uGlyphTime,Ae),e.uniform1f(i.uSeedValue,c.variation),e.uniform1f(i.uLight,c.lightMode?1:0)},ie=()=>{if(!Y)return;const o=y.current,a=R.width/R.height;nt(),it(),e.bindVertexArray(xe),e.disable(e.BLEND),e.bindFramebuffer(e.FRAMEBUFFER,_.framebuffer),e.drawBuffers([e.COLOR_ATTACHMENT0,e.COLOR_ATTACHMENT1]),e.viewport(0,0,_.width,_.height),e.useProgram($.program);const r=$.uniforms;e.uniform1f(r.uAspect,a),e.uniform1f(r.uTime,Re),e.uniform1i(r.uShape,o.shape),e.uniform3fv(r.uRamp,Te),e.uniform1i(r.uCount,o.colors.length),e.uniform1f(r.uScale,o.scale),e.uniform1f(r.uSoftness,o.softness),e.uniform1f(r.uFlow,o.flow),e.uniform2f(r.uSeed,o.variation*3.17,o.variation*1.91),e.uniform4fv(r.uTrail,re),e.uniform1f(r.uRadius,o.scrambleRadius),e.uniform4fv(r.uClicks,oe),e.uniform1i(r.uClickEffect,o.clickEffect),e.uniform1f(r.uIntro,k),e.uniform1f(r.uFrame,K),e.drawArrays(e.TRIANGLES,0,3);const c=o.glow>.001;c&&(e.bindFramebuffer(e.FRAMEBUFFER,E.framebuffer),e.drawBuffers([e.COLOR_ATTACHMENT0]),e.viewport(0,0,E.width,E.height),e.useProgram(O.program),we(O,m.width,m.height),e.uniform1f(O.uniforms.uDownscale,m.width/E.width),e.drawArrays(e.TRIANGLES,0,3),e.useProgram(C.program),e.activeTexture(e.TEXTURE0),e.uniform1i(C.uniforms.uSource,0),e.bindFramebuffer(e.FRAMEBUFFER,W.framebuffer),e.bindTexture(e.TEXTURE_2D,E.textures[0]),e.uniform2f(C.uniforms.uStep,1/E.width,0),e.drawArrays(e.TRIANGLES,0,3),e.bindFramebuffer(e.FRAMEBUFFER,E.framebuffer),e.bindTexture(e.TEXTURE_2D,W.textures[0]),e.uniform2f(C.uniforms.uStep,0,1/E.height),e.drawArrays(e.TRIANGLES,0,3)),e.bindFramebuffer(e.FRAMEBUFFER,null),e.viewport(0,0,m.width,m.height),e.useProgram(X.program),we(X,m.width,m.height);const i=X.uniforms;e.activeTexture(e.TEXTURE3),e.bindTexture(e.TEXTURE_2D,E.textures[0]),e.uniform1i(i.uHalo,3),e.uniform1f(i.uGlow,c?o.glow:0),e.uniform1f(i.uGradient,o.gradientOpacity),e.uniform1f(i.uGrain,o.grain),e.uniform1f(i.uFrame,K),e.drawArrays(e.TRIANGLES,0,3)},_e=()=>{const o=y.current;R.width=Math.max(1,M.clientWidth),R.height=Math.max(1,M.clientHeight),R.ratio=Math.min(o.dpr||window.devicePixelRatio||1,2),m.width=Math.max(1,Math.round(R.width*R.ratio)),m.height=Math.max(1,Math.round(R.height*R.ratio)),me(e,_,Math.max(1,Math.round(m.width/2)),Math.max(1,Math.round(m.height/2)));const a=Math.max(1,Math.round(m.width/4)),r=Math.max(1,Math.round(m.height/4));me(e,E,a,r),me(e,W,a,r),ie(),G()},ct=o=>{for(x.forEach(a=>{a.age+=o});x.length&&x[x.length-1].age>Oe;)x.pop();for(let a=0;a<ue;a++){const r=x[a];if(!r){re[a*4+2]=0;continue}const c=1-r.age/Oe;re.set([r.x,r.y,c*c,0],a*4)}for(A.forEach(a=>{a.age+=o});A.length&&A[A.length-1].age>Pe;)A.pop();for(let a=0;a<se;a++){const r=A[a];if(!r){oe[a*4+3]=0;continue}const c=r.age/Pe,i=Math.min(1,r.age/.08)*(1-c)*(1-c);oe.set([r.x,r.y,r.age,i],a*4)}},ce=o=>{if(D=0,N||!j||document.hidden)return;if(!Y){if(!e.isContextLost()&&!be()){D=requestAnimationFrame(ce);return}if(!L.every(i=>Be(e,i))){De();return}Y=!0}const a=y.current,r=I?p((o-I)/1e3,.001,.05):1/60;I=o,S||(Re+=r*a.speed*.5,Ae+=r*Math.max(a.speed,.15)),k<1&&(k=Math.min(1,k+r/st)),ne+=r,!S&&ne>1/24&&(ne=0,K=(K+1)%97),ct(r),ie(),!S||k<1||A.length>0||x.length>0?D=requestAnimationFrame(ce):I=0};function G(){!D&&!N&&j&&!document.hidden&&(D=requestAnimationFrame(ce))}const Se=o=>{const a=M.getBoundingClientRect(),r=(o.clientX-a.left)/Math.max(1,a.width),c=1-(o.clientY-a.top)/Math.max(1,a.height),i=a.width/Math.max(1,a.height);h.inside=r>=0&&r<=1&&c>=0&&c<=1,h.x=(r-.5)*i,h.y=c-.5},Fe=o=>{Se(o);const a=y.current;if(!h.inside||!a.mouseInteraction||S)return;const r=x[0],c=r?Math.hypot(h.x-r.x,h.y-r.y):1/0;if(!(c<Xe)){if(r&&r.age<.1){const i=Math.min(6,Math.floor(c/(Xe*2)));for(let b=1;b<=i;b++){const w=b/(i+1);x.unshift({x:r.x+(h.x-r.x)*w,y:r.y+(h.y-r.y)*w,age:0})}}x.unshift({x:h.x,y:h.y,age:0}),x.length=Math.min(x.length,ue),G()}},Me=o=>{Se(o);const a=y.current;!h.inside||!a.clickEffect||S||(A.unshift({x:h.x,y:h.y,age:0}),A.length>se&&A.pop(),G())},Ce=()=>{I=0,G()},Le=new ResizeObserver(_e);Le.observe(M);const Ue=new IntersectionObserver(o=>{j=o.some(a=>a.isIntersecting),j&&(I=0,G())});Ue.observe(M),window.addEventListener("pointermove",Fe,{passive:!0}),window.addEventListener("pointerdown",Me,{passive:!0}),document.addEventListener("visibilitychange",Ce),_e(),te.current=G;const De=()=>{N||(N=!0,cancelAnimationFrame(D),te.current=null,Le.disconnect(),Ue.disconnect(),window.removeEventListener("pointermove",Fe),window.removeEventListener("pointerdown",Me),document.removeEventListener("visibilitychange",Ce),[_,E,W].forEach(o=>{o.textures.forEach(a=>e.deleteTexture(a)),e.deleteFramebuffer(o.framebuffer)}),d&&e.deleteTexture(d.texture),e.deleteVertexArray(xe),m.isConnected?ge():(L.forEach(o=>e.deleteProgram(o.program)),e.getExtension("WEBGL_lose_context")?.loseContext()))};return De},[]),P.useEffect(()=>{te.current?.()}),Ie.jsx("div",{ref:he,className:`gradient-ascii-container${de?` ${de}`:""}`,style:ot,...rt,children:Ie.jsx("canvas",{ref:pe,className:"gradient-ascii-canvas","aria-hidden":"true"})})};export{yt as default};
